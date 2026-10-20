#!/usr/bin/env node
// Wires claude-limits into one or more Claude config dirs' settings.json:
// the status line (feeds the snapshot) and three hooks (PostToolUse,
// UserPromptSubmit, SessionStart). Idempotent; backs up settings.json first.
//
//   node scripts/install.mjs                     # $CLAUDE_CONFIG_DIR or ~/.claude
//   node scripts/install.mjs ~/.claude ~/.claude-work
//   node scripts/install.mjs --statusline-only   # plugin users: the plugin brings the hooks
//   node scripts/install.mjs --remove ~/.claude  # take it out again
//
// An existing status line that isn't ours is left alone (the hooks still work,
// fed by the background /usage read); pass --statusline to replace it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'claude-limits.mjs').replace(/\\/g, '/')
const MARK = 'claude-limits.mjs'
const q = `"${script}"`

const args = process.argv.slice(2)
const remove = args.includes('--remove')
const statusOnly = args.includes('--statusline-only')
const forceStatus = args.includes('--statusline')
const expand = p => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)
let dirs = args.filter(a => !a.startsWith('--')).map(expand)
if (dirs.length === 0) dirs = [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')]

const hookEntry = (event) => ({
  ...(event === 'PostToolUse' ? { matcher: '*' } : {}),
  hooks: [{ type: 'command', command: `node ${q} hook`, timeout: 10 }],
})
const ours = h => JSON.stringify(h).includes(MARK)

for (const dir of dirs) {
  const file = path.join(dir, 'settings.json')
  if (!fs.existsSync(dir)) { console.log(`skip ${dir}: no such config dir`); continue }
  let s = {}
  if (fs.existsSync(file)) {
    s = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.copyFileSync(file, `${file}.bak-limits`)
  }
  s.hooks ||= {}
  for (const event of ['PostToolUse', 'UserPromptSubmit', 'SessionStart']) {
    const list = (s.hooks[event] || []).filter(h => !ours(h))
    if (!remove && !statusOnly) list.push(hookEntry(event))
    if (list.length) s.hooks[event] = list; else delete s.hooks[event]
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks

  let note = ''
  const sl = s.statusLine
  if (remove) {
    if (sl && ours(sl)) delete s.statusLine
  } else if (!sl || ours(sl) || forceStatus) {
    s.statusLine = { type: 'command', command: `node ${q} statusline`, padding: 0 }
  } else {
    note = ' (kept your own status line; hooks fall back to the background /usage read)'
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
  console.log(`${remove ? 'removed from' : 'installed in'} ${file}${note}`)
}
