import type { Register, EngineInterface } from 'claude-code'

// limits-aware: compacts the conversation when a session or weekly limit is
// near, after Claude has written its notes.
//
// - Tool compact_after_turn: Claude calls it once the pre-compact checklist is
//   done; the compaction runs when the turn ends (it can't run mid-turn).
// - Fallback (once per 5h window, large context only): a main turn that ends in
//   WRAP or STOP without that call gets a follow-up prompt asking Claude to save
//   its notes and call the tool. If the next turn still ends without it, the
//   module compacts with notes-keeping instructions itself.
// - /limits shows the current figures.
//
// The figures and bands come from scripts/claude-limits.mjs (`check --json`),
// so the hooks, the status line and this module share one set of thresholds.

const TOOL = 'compact_after_turn'
const BASE = [
  'Limits-aware compaction: the subscription limit is close, so this summary is what the next turn',
  '(possibly after the limit resets and the prompt cache is cold) starts from. Keep: the goal; what is',
  'done and verified; what is done but not verified; the exact next step; decisions and open questions or',
  'offers awaiting the user; uncommitted or unpushed git state and branches; where the handoff note and',
  'memory notes are; files that live only in temporary folders. Drop exploration detail and tool output',
  'that the notes already cover.',
].join(' ')

type Verdict = {
  band: 'ok' | 'caution' | 'wrap' | 'stop' | 'unknown'
  windows?: { five_hour?: { pct: number; resets_at?: number | null }; seven_day?: { pct: number } }
}

let pending: string | undefined
// A window's reset time drifts by a minute between readings, so compare loosely.
const sameWindow = (a: number | null | undefined, b: number | null | undefined) =>
  a !== undefined && b !== undefined && (a === b || (a !== null && b !== null && Math.abs(a - b) < 1800))
let nudgedFor: number | null | undefined
let autoDoneFor: number | null | undefined

async function verdict($: EngineInterface): Promise<Verdict | undefined> {
  try {
    const ran = await $.process.run(['node', `${$.plugin.root}/scripts/claude-limits.mjs`, 'check', '--json'], {
      timeoutMs: 30_000,
    })
    if (ran.exitCode !== 0) return undefined
    return JSON.parse(ran.stdout) as Verdict
  } catch {
    return undefined
  }
}

function headline(v: Verdict | undefined): string {
  const fh = v?.windows?.five_hour
  const wk = v?.windows?.seven_day
  const parts: string[] = []
  if (fh) parts.push(`session ${fh.pct}%`)
  if (wk) parts.push(`weekly ${wk.pct}%`)
  return parts.length ? parts.join(', ') : 'limits unknown'
}

async function compactSoon($: EngineInterface, instructions: string, why: string) {
  $.clock.after(1500, () => {
    void (async () => {
      try {
        $.ui.toast(`limits-aware: compacting (${why})`)
        const res = await $.session.compact({ instructions })
        if ('skip' in res && res.skip) $.ui.log(`limits-aware: compaction skipped: ${res.skip}`)
      } catch {
        // a new turn started first: try again when that one ends
        pending = pending ?? instructions
      }
    })()
  })
}

export const register: Register = (on, options) => {
  const mode = String(options.autoCompact ?? 'fallback')
  const minContext = Number(options.minContextPercent ?? 30)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'limits', description: 'Show session and weekly limit usage (no limits spent)' })
    if (mode !== 'off') {
      await $.tool.register({
        name: TOOL,
        description:
          'Schedules /compact to run as soon as this turn ends. Call it as the last step of a limits ' +
          'wrap-up (WRAP or STOP band), after the handoff note and memory notes are saved. ' +
          '`focus` names anything the summary must keep beyond the standard checklist.',
        inputSchema: {
          type: 'object',
          properties: { focus: { type: 'string', description: 'What the summary must keep or stress' } },
        },
        isDeferred: false,
      })
    }
    return next(e)
  })

  on('command.run', { command: 'limits' }, async $ => {
    try {
      const ran = await $.process.run(['node', `${$.plugin.root}/scripts/claude-limits.mjs`, 'check', '--live'], {
        timeoutMs: 30_000,
      })
      return { text: ran.stdout.trim() || 'limits-aware: no reading (is node on PATH?)' }
    } catch {
      return { text: 'limits-aware: could not run the check (is node on PATH?)' }
    }
  })

  on('tool.call', { tool: 'mcp__limits-aware__compact_after_turn' }, async (_$, e) => {
    const raw = e['focus']
    const focus = typeof raw === 'string' ? raw : ''
    pending = focus ? `${BASE} Also keep: ${focus}` : BASE
    return { result: 'Compaction scheduled: it runs when this turn ends. End the turn with a short summary for the user.' }
  }).catch(() => ({ deny: 'limits-aware: could not schedule the compaction; ask the user to run /compact.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || mode === 'off') return done

    if (pending) {
      const instructions = pending
      pending = undefined
      const v = await verdict($)
      autoDoneFor = v?.windows?.five_hour?.resets_at ?? null
      await compactSoon($, instructions, headline(v))
      return done
    }

    if (mode !== 'fallback' || e.isAborted) return done
    const v = await verdict($)
    if (!v || (v.band !== 'wrap' && v.band !== 'stop')) return done
    const resetsAt = v.windows?.five_hour?.resets_at ?? null
    if (sameWindow(autoDoneFor, resetsAt)) return done
    const { context } = await $.session.usage()
    if ((context.percent ?? 0) < minContext) return done
    if (!sameWindow(nudgedFor, resetsAt)) {
      nudgedFor = resetsAt
      void $.prompt.submit({
        text:
          `Limits are at ${headline(v)} (band ${v.band.toUpperCase()}). Following limits-aware-workflow: ` +
          'stop new work, run the pre-compact checklist (handoff note, memory notes, git state, temporary files), ' +
          `then call mcp__limits-aware__${TOOL} so the conversation is compacted when this turn ends.`,
      })
      return done
    }
    autoDoneFor = resetsAt
    await compactSoon($, BASE, `${headline(v)}, no notes call`)
    return done
  })
}
