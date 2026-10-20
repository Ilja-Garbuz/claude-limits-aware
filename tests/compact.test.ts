import { expect, mock, test } from 'claude-code/testing'

type Band = 'ok' | 'caution' | 'wrap' | 'stop'

// Stands for the engine and the check script beneath the plugin.
function world(on: Parameters<Parameters<typeof test>[1]>[1], band: Band, contextPercent = 50) {
  const clock = mock.clock(on)
  const compacts: string[] = []
  const prompts: string[] = []
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
    compacts.push(e.instructions ?? '')
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: {} }))
  return { clock, compacts, prompts }
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
