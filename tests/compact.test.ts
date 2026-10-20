import { expect, mock, test } from 'claude-code/testing'

type Band = 'ok' | 'caution' | 'wrap' | 'stop'

// Stands for the engine and the check script beneath the plugin.
function world(on: Parameters<Parameters<typeof test>[1]>[1], band: Band, contextPercent = 50, rejectFirst = 0, reason = 'a turn is running') {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  const compacts: string[] = []
  const prompts: string[] = []
  const commands: string[] = []
  const files = new Map<string, string>()
  let rejections = rejectFirst
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.run', (_, e) => {
    commands.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  on('command.register', () => ({ value: { command: 'limits' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__limits-aware__compact_after_turn' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ band, windows: { five_hour: { pct: 88, resets_at: 1000 }, seven_day: { pct: 20 } } }),
      stderr: '',
    },
  }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 100000, window: 200000, percent: contextPercent }, rateLimits: [] },
  }))
  on('session.compact', (_, e) => {
    if (rejections > 0) { rejections -= 1; throw new Error(reason) }
    compacts.push(e.instructions ?? '')
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: {} }))
  const log = () => files.get('/home/u/.claude/limits/compact.log') ?? ''
  return { clock, compacts, prompts, commands, files, log }
}

const turnEnd = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

test('compacts after the turn when Claude asks, keeping its focus', async ($, on) => {
  const w = world(on, 'wrap')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__limits-aware__compact_after_turn', focus: 'the PR link' })
  expect(w.compacts.length).toBe(0)
  await $.turn.complete(turnEnd)
  await w.clock.advance(2000)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0]).toContain('the PR link')
})

test('fallback asks for notes first, then compacts on the next turn end', async ($, on) => {
  const w = world(on, 'wrap')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turnEnd)
  await w.clock.advance(2000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('compact_after_turn')
  expect(w.compacts.length).toBe(0)
  await $.turn.complete(turnEnd)
  await w.clock.advance(2000)
  expect(w.compacts.length).toBe(1)
  // once per window: a third turn end does nothing more
  await $.turn.complete(turnEnd)
  await w.clock.advance(2000)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1)
})

test('does nothing in the OK band or with a small context', async ($, on) => {
  const w = world(on, 'ok')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turnEnd)
  await w.clock.advance(2000)
  expect(w.prompts.length + w.compacts.length).toBe(0)
})

test('leaves a small conversation alone even in WRAP', async ($, on) => {
  const w = world(on, 'wrap', 10)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turnEnd)
  await w.clock.advance(2000)
  expect(w.prompts.length + w.compacts.length).toBe(0)
})

test('subagent turns never compact', async ($, on) => {
  const w = world(on, 'stop')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...turnEnd, agentId: 'a1' })
  await w.clock.advance(2000)
  expect(w.prompts.length + w.compacts.length).toBe(0)
})

test('retries while the session is busy, then compacts', async ($, on) => {
  const w = world(on, 'wrap', 50, 2)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__limits-aware__compact_after_turn', focus: 'x' })
  await $.turn.complete(turnEnd)
  await w.clock.advance(20000)
  expect(w.compacts.length).toBe(1)
  expect(w.log()).toContain('try 1 rejected')
  expect(w.log()).toContain('compacted (try 3)')
  // done: the next turn end does not compact again
  await $.turn.complete(turnEnd)
  await w.clock.advance(20000)
  expect(w.compacts.length).toBe(1)
})

test('queues /compact when the direct call keeps failing', async ($, on) => {
  const w = world(on, 'wrap', 50, 100)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__limits-aware__compact_after_turn', focus: 'keep the PR link' })
  await $.turn.complete(turnEnd)
  await w.clock.advance(60000)
  expect(w.compacts.length).toBe(0)
  expect(w.commands.length).toBe(1)
  expect(w.commands[0]).toContain('compact')
  expect(w.commands[0]).toContain('keep the PR link')
})

