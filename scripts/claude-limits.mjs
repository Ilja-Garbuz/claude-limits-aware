#!/usr/bin/env node
// claude-limits: reads the subscription's session (5-hour) and weekly limits
// without spending any of them, and turns them into a workflow verdict.
//
// Sources, both free (no model call):
//   1. statusline  Claude Code hands the status line `rate_limits` after every
//                  API response. `claude-limits statusline` saves it as a snapshot.
//   2. live        `claude -p /usage --safe-mode --no-session-persistence` prints
//                  the account's live figures in ~2-3 s. Used when the snapshot is stale.
//
// Everything is per Claude config dir: $CLAUDE_CONFIG_DIR, else ~/.claude.
// Files: <config>/limits/snapshot.json, <config>/limits/sessions/<id>.json
//
// Commands:
//   statusline          stdin = status line JSON; saves snapshot, prints a short line
//   check [--live] [--json]   prints figures + band; --live forces a /usage read
//   refresh             live read into the snapshot, prints nothing
//   hook                stdin = hook JSON (PostToolUse, UserPromptSubmit, SessionStart);
//                       prints additionalContext only when the band says so
//
// Ships in the limits-aware plugin (hooks/hooks.json runs `hook`); usable on its own too.
// Node 18+, no dependencies. Works in Git Bash on Windows and on Linux.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const DIR = path.join(CFG, 'limits')
const SNAP = path.join(DIR, 'snapshot.json')
const SESS = path.join(DIR, 'sessions')
const LOCK = path.join(DIR, 'refresh.lock')

// Thresholds, percent used. Override any with env, e.g. CLAUDE_LIMITS_5H_WRAP=80.
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d)
const T = {
  five_hour: { caution: num('CLAUDE_LIMITS_5H_CAUTION', 70), wrap: num('CLAUDE_LIMITS_5H_WRAP', 85), stop: num('CLAUDE_LIMITS_5H_STOP', 93) },
  seven_day: { caution: num('CLAUDE_LIMITS_7D_CAUTION', 80), wrap: num('CLAUDE_LIMITS_7D_WRAP', 90), stop: num('CLAUDE_LIMITS_7D_STOP', 96) },
}
const STALE_S = num('CLAUDE_LIMITS_STALE_S', 180)     // snapshot older than this triggers a background live read
const THROTTLE_S = num('CLAUDE_LIMITS_THROTTLE_S', 30) // hook evaluates at most this often per session
const REMIND_S = num('CLAUDE_LIMITS_REMIND_S', 600)    // repeat a wrap/stop note this often
const ETA_WRAP_MIN = num('CLAUDE_LIMITS_ETA_WRAP_MIN', 20) // projected to hit 100% within N min -> wrap
const BANDS = ['ok', 'caution', 'wrap', 'stop']
const LABEL = { five_hour: '5-hour session limit', seven_day: 'weekly limit' }

const now = () => Math.floor(Date.now() / 1000)
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v))
  fs.renameSync(tmp, f)
}
const readStdin = () => { try { return fs.readFileSync(0, 'utf8') } catch { return '' } }

// ---------- snapshot ----------

// Each window: { pct, resets_at (epoch s), at (epoch s when read) }.
// History keeps a few recent 5h readings for a burn-rate projection.
function saveWindows(windows, source) {
  const prev = readJson(SNAP) || {}
  const t = now()
  const next = { ...prev, updated_at: t, source }
  for (const [kind, w] of Object.entries(windows)) {
    if (!w || typeof w.pct !== 'number' || Number.isNaN(w.pct)) continue
    const old = prev[kind]
    next[kind] = { pct: w.pct, resets_at: w.resets_at ?? old?.resets_at ?? null, at: t }
  }
  if (next.five_hour) {
    const same = x => x.resets_at === next.five_hour.resets_at || (x.resets_at && next.five_hour.resets_at && Math.abs(x.resets_at - next.five_hour.resets_at) < 1800)
    const h = (prev.history || []).filter(x => t - x.at < 3600 && same(x))
    const last = h[h.length - 1]
    if (!last || last.pct !== next.five_hour.pct || t - last.at >= 60) h.push({ at: t, pct: next.five_hour.pct, resets_at: next.five_hour.resets_at })
    next.history = h.slice(-30)
  }
  writeJson(SNAP, next)
  return next
}

// ---------- live read through headless /usage ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

// "Oct 20, 8:20am" | "5pm" | "Oct 24, 5pm", in the machine's local time zone.
export function parseReset(text, ref = new Date()) {
  const m = /(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text || '')
  if (!m) return null
  let h = Number(m[3]) % 12
  if (m[5].toLowerCase() === 'pm') h += 12
  const min = Number(m[4] || 0)
  const d = new Date(ref)
  d.setSeconds(0, 0)
  if (m[1] && MONTHS[m[1].toLowerCase()] !== undefined) {
    d.setMonth(MONTHS[m[1].toLowerCase()], Number(m[2]))
    d.setHours(h, min)
    if (d.getTime() < ref.getTime() - 86400_000) d.setFullYear(d.getFullYear() + 1)
  } else {
    d.setHours(h, min)
    if (d.getTime() < ref.getTime() - 60_000) d.setDate(d.getDate() + 1)
  }
  return Math.floor(d.getTime() / 1000)
}

export function parseUsage(text) {
  const out = {}
  const s = /Current session:\s*([\d.]+)%[^\n]*?resets\s+([^(\n]+)/.exec(text)
  const w = /Current week \(all models\):\s*([\d.]+)%[^\n]*?resets\s+([^(\n]+)/.exec(text) ||
            /Current week[^:\n]*:\s*([\d.]+)%[^\n]*?resets\s+([^(\n]+)/.exec(text)
  if (s) out.five_hour = { pct: Number(s[1]), resets_at: parseReset(s[2]) }
  if (w) out.seven_day = { pct: Number(w[1]), resets_at: parseReset(w[2]) }
  return out
}

function liveRead() {
  const bin = process.env.CLAUDE_LIMITS_CLAUDE_BIN || 'claude'
  const args = ['-p', '/usage', '--safe-mode', '--no-session-persistence']
  // windowsHide: no console window on Windows. Run the binary directly (claude.exe from the
  // native installer); only an npm install (claude.cmd) needs a shell, still hidden.
  const opts = { encoding: 'utf8', timeout: 30_000, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  let r = spawnSync(bin, args, opts)
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') r = spawnSync(bin, args, { ...opts, shell: true })
  if (r.status !== 0 || !r.stdout) return null
  const w = parseUsage(r.stdout)
  return Object.keys(w).length ? saveWindows(w, 'live') : null
}

// Starts a detached live read unless one ran recently. Never blocks the caller.
function refreshInBackground() {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const st = fs.existsSync(LOCK) ? fs.statSync(LOCK) : null
    if (st && Date.now() - st.mtimeMs < STALE_S * 1000) return
    fs.writeFileSync(LOCK, String(process.pid))
    // detached so the read outlives the hook; windowsHide keeps its console hidden on Windows
    const child = spawn(process.execPath, [SELF, 'refresh'], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true })
    child.unref()
  } catch { /* best effort */ }
}

// ---------- verdict ----------

function bandFor(kind, pct) {
  const t = T[kind]
  if (pct >= t.stop) return 'stop'
  if (pct >= t.wrap) return 'wrap'
  if (pct >= t.caution) return 'caution'
  return 'ok'
}

// Minutes until the 5h window hits 100% at the recent burn rate, or null.
function etaMinutes(snap) {
  const h = snap.history || []
  const cur = h[h.length - 1]
  if (!cur) return null
  const base = [...h].reverse().find(x => cur.at - x.at >= 300 && cur.at - x.at <= 3600)
  if (!base || cur.pct <= base.pct) return null
  const ratePerMin = (cur.pct - base.pct) / ((cur.at - base.at) / 60)
  return Math.max(0, (100 - cur.pct) / ratePerMin)
}

export function evaluate(snap, t = now()) {
  const res = { band: 'ok', windows: {}, reasons: [], eta_min: null, age_s: snap?.updated_at ? t - snap.updated_at : null }
  if (!snap) return { ...res, band: 'unknown' }
  for (const kind of ['five_hour', 'seven_day']) {
    const w = snap[kind]
    if (!w) continue
    if (w.resets_at && w.resets_at <= t) { res.windows[kind] = { pct: 0, resets_at: null, reset: true }; continue }
    const band = bandFor(kind, w.pct)
    const resets_in_min = w.resets_at ? Math.round((w.resets_at - t) / 60) : null
    res.windows[kind] = { pct: w.pct, resets_at: w.resets_at, resets_in_min, band }
    if (BANDS.indexOf(band) > BANDS.indexOf(res.band)) res.band = band
    if (band !== 'ok') res.reasons.push(`${LABEL[kind]} ${w.pct}%`)
  }
  const fh = res.windows.five_hour
  const eta = fh && !fh.reset ? etaMinutes(snap) : null
  if (eta !== null) {
    res.eta_min = Math.round(eta)
    const beatsReset = fh.resets_in_min === null || eta < fh.resets_in_min
    if (beatsReset && eta <= ETA_WRAP_MIN && BANDS.indexOf(res.band) < BANDS.indexOf('wrap')) {
      res.band = 'wrap'
      res.reasons.push(`projected to reach 100% in ~${res.eta_min} min, before the reset`)
    }
  }
  return res
}

const clock = epoch => {
  if (!epoch) return '?'
  const d = new Date(epoch * 1000)
  const sameDay = d.toDateString() === new Date().toDateString()
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return sameDay ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`
}
const inMin = m => (m === null || m === undefined ? '' : m < 90 ? ` (in ${m} min)` : ` (in ${Math.round(m / 6) / 10} h)`)

export function describe(v) {
  if (v.band === 'unknown') return 'Limits (subscription usage, not context): no reading yet.'
  const parts = []
  for (const kind of ['five_hour', 'seven_day']) {
    const w = v.windows[kind]
    if (!w) continue
    parts.push(w.reset ? `${LABEL[kind]}: window has reset` : `${LABEL[kind]} ${w.pct}% used, resets ${clock(w.resets_at)}${inMin(w.resets_in_min)}`)
  }
  if (v.eta_min !== null) parts.push(`at the current rate the 5-hour limit is reached in ~${v.eta_min} min`)
  return `Limits (subscription usage, not context): ${parts.join('; ')}. Band: ${v.band.toUpperCase()}.`
}

const ADVICE = {
  caution: 'Per limits-aware-workflow, CAUTION: finish the current unit, checkpoint at each milestone, avoid starting large new work or spawning subagents.',
  wrap: 'Per limits-aware-workflow, WRAP: finish only the step in progress, verify it, commit/save, run the pre-compact checklist (handoff note), then call mcp__limits-aware__compact_after_turn if available, and tell the user what is left and when the limit resets.',
  stop: 'Per limits-aware-workflow, STOP: no new work. Save state (commit, handoff note) in as few tool calls as possible, call mcp__limits-aware__compact_after_turn if available, and end the turn with a short summary and the reset time.',
}

// ---------- commands ----------

function cmdStatusline() {
  let j = {}
  try { j = JSON.parse(readStdin() || '{}') } catch { /* ignore */ }
  const rl = j.rate_limits || {}
  const w = {}
  if (rl.five_hour?.used_percentage !== undefined) w.five_hour = { pct: Number(rl.five_hour.used_percentage), resets_at: rl.five_hour.resets_at ?? null }
  if (rl.seven_day?.used_percentage !== undefined) w.seven_day = { pct: Number(rl.seven_day.used_percentage), resets_at: rl.seven_day.resets_at ?? null }
  const snap = Object.keys(w).length ? saveWindows(w, 'statusline') : readJson(SNAP)
  const v = evaluate(snap)
  const bits = []
  const fh = v.windows.five_hour, wk = v.windows.seven_day
  if (fh && !fh.reset) bits.push(`5h ${Math.round(fh.pct)}% ↻${clock(fh.resets_at)}`)
  if (wk && !wk.reset) bits.push(`7d ${Math.round(wk.pct)}%`)
  if (v.eta_min !== null && v.band !== 'ok') bits.push(`~${v.eta_min}m left`)
  const ctx = j.context_window?.used_percentage
  if (ctx !== undefined && ctx !== null) bits.push(`ctx ${Math.round(ctx)}%`)
  const pc = j.prompt_cache
  if (pc?.caching_observed) bits.push(pc.warm ? `cache ↻${clock(pc.expires_at)}` : 'cache cold')
  if (v.band !== 'ok' && v.band !== 'unknown') bits.push(v.band.toUpperCase())
  process.stdout.write(bits.join(' · ') + '\n')
}

function current(forceLive) {
  let snap = readJson(SNAP)
  const age = snap?.updated_at ? now() - snap.updated_at : Infinity
  if (forceLive || age > STALE_S) snap = liveRead() || snap
  return snap
}

function cmdCheck(args) {
  const v = evaluate(current(args.includes('--live')))
  if (args.includes('--json')) { process.stdout.write(JSON.stringify(v) + '\n'); return }
  const advice = ADVICE[v.band] ? ` ${ADVICE[v.band]}` : ''
  process.stdout.write(describe(v) + advice + '\n')
}

function cmdHook() {
  let j = {}
  try { j = JSON.parse(readStdin() || '{}') } catch { /* ignore */ }
  const event = j.hook_event_name || 'PostToolUse'
  const sid = (j.session_id || 'nosession').replace(/[^\w.-]/g, '_')
  const sf = path.join(SESS, `${sid}.json`)
  const st = readJson(sf) || {}
  const t = now()
  const isSub = Boolean(j.agent_id)
  // Throttle tool-use checks; prompts and session start always evaluate.
  if (event === 'PostToolUse' && st.checked_at && t - st.checked_at < THROTTLE_S) return
  const snap = readJson(SNAP)
  if (!snap || t - (snap.updated_at || 0) > STALE_S) refreshInBackground()
  const v = evaluate(snap, t)
  const rank = BANDS.indexOf(v.band)
  const lastRank = BANDS.indexOf(st.band || 'ok')
  let say = false
  if (rank >= 1 && rank > lastRank) say = true                                   // band went up
  if (rank >= 2 && st.said_at && t - st.said_at >= REMIND_S) say = true          // periodic reminder in wrap/stop
  if (rank >= 1 && (event === 'UserPromptSubmit' || event === 'SessionStart')) say = true
  if (rank === 0 && lastRank >= 2) say = true                                    // window reset: say once that work can resume
  if (isSub && rank < 3) say = false                                              // subagents hear only STOP
  const next = { ...st, checked_at: t, band: v.band === 'unknown' ? st.band : v.band }
  if (say) next.said_at = t
  writeJson(sf, next)
  if (!say) return
  const text = rank === 0 ? `${describe(v)} Limits are back to normal; work can continue.` : `${describe(v)} ${ADVICE[v.band]}`
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }))
}

function cleanup() {
  // drop session state older than 3 days
  try {
    for (const f of fs.readdirSync(SESS)) {
      const p = path.join(SESS, f)
      if (Date.now() - fs.statSync(p).mtimeMs > 3 * 86400_000) fs.unlinkSync(p)
    }
  } catch { /* none yet */ }
}

const [cmd, ...args] = process.argv.slice(2)
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    if (cmd === 'statusline') cmdStatusline()
    else if (cmd === 'check') cmdCheck(args)
    else if (cmd === 'refresh') { liveRead(); cleanup() }
    else if (cmd === 'hook') cmdHook()
    else {
      process.stdout.write('usage: claude-limits statusline | check [--live] [--json] | refresh | hook\n')
      process.exitCode = cmd ? 2 : 0
    }
  } catch (e) {
    // a limits check must never break the session
    if (cmd === 'check') { process.stderr.write(String(e?.stack || e) + '\n'); process.exitCode = 1 }
  }
}
