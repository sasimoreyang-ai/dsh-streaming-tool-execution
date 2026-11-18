import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

test('exclusive block and its suffix are prepared and dispatched only by the native batch', async () => {
  const calls = []
  const scheduler = {
    prepare(input) { return { kind: 'dispatch', exec: input } },
    dispatch(input) { calls.push(input.name); return input.name },
  }
  const events = new Map()
  const agent = { id: 'a' }, signal = new AbortController().signal
  apply({ tools: { [Symbol('@deepseek-ai/dsh-tools.scheduler')]: scheduler,
    executionMode: input => ({ kind: input.name === 'write' ? 'exclusive' : 'parallel' }) },
    logger: () => console, agentLoop: { config: { maxParallelToolCalls: { get: () => 4 } } },
    on: (key, fn) => events.set(key, fn), effect: () => {},
  }, { streamingToolExecution: true })
  events.get('agent/request')({ agent, turn: 1, step: 1, signal }, () => {})
  const names = ['read', 'write', 'tail']
  for (const name of names) events.get('agent/assistant-stream')({ agent, frame: { type: 'chunk',
    chunk: { type: 'block-end', block: { type: 'tool-call', id: name, name, arguments: '{}' } } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['read'])
  for (const name of names) {
    const prepared = await scheduler.prepare({ agent, signal, name, callId: name, arguments: {} })
    await scheduler.dispatch(prepared.exec)
  }
  assert.deepEqual(calls, names)
})
