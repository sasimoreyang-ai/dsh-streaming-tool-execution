import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../index.js'

function* call(id = 'one', name = 'read_fixture', index = 0) {
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id, name, argumentsDelta: '{}' }
  yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: '{}' } }
}
const finish = kind => ({ type: 'finish', reason: { kind } })

async function setup(t, script, enabled = true, maxParallelToolCalls = 10) {
  const ctx = new Context()
  const releases = []
  const gate = () => {
    const value = Promise.withResolvers()
    releases.push(value.resolve)
    return value
  }
  t.after(async () => { releases.forEach(release => release()); await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls })
  const harness = ctx.agentLoop
  const originalResolve = Object.getOwnPropertyDescriptor(ctx.tools, 'resolve')
  const originalExecute = Object.getOwnPropertyDescriptor(ctx.tools, 'execute')
  const fork = await ctx.plugin(plugin, { streamingToolExecution: enabled })
  const errors = []
  const events = []
  ctx.on('agent/error', payload => errors.push(payload.error))
  ctx.on('session/event', (_session, event) => events.push(event))
  let requests = 0
  ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
    async *stream(options) {
      requests++
      if (requests > 5) throw Error('Unexpected model loop')
      if (requests === 1 || script.repeat) yield* script(options, requests)
      else yield finish('stop')
    }
  }())
  const agent = await harness.create('stream-test', { provider: 'mock', model: 'fixture' })
  const register = (name, execute, parallel = true, options) => ctx.tools.register({
    name, description: 'test tool', parameters: { type: 'object' },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => parallel, execute,
  }, options)
  const run = (target = agent) => {
    const idle = new Promise(resolve => {
      const off = ctx.on('agent/status', payload => {
        if (payload.agent === target && payload.status === 'idle') { off(); resolve() }
      })
    })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'test' }], source: { kind: 'user' } }))
    return idle
  }
  return { ctx, agent, fork, errors, events, register, run, gate, originalResolve, originalExecute }
}

test('real rc.1 loop overlaps decode and executes all policy stages once in durable order', { timeout: 5000 }, async t => {
  let streamGate
  const h = await setup(t, async function* () { yield* call(); await streamGate.promise; yield finish('tool-calls') })
  streamGate = h.gate()
  const started = h.gate()
  let calls = 0
  const counts = { pre: 0, execute: 0, post: 0, result: 0 }
  h.ctx.on('tools/pre-execute', async (_exec, next) => { counts.pre++; return next() })
  h.ctx.on('tools/execute', async (_exec, next) => { counts.execute++; return next() })
  h.ctx.on('tools/post-execute', async (_exec, _result, next) => { counts.post++; return next() })
  h.ctx.on('tools/result', () => { counts.result++ })
  h.register('read_fixture', async () => { calls++; started.resolve(); return 'ok' })
  const idle = h.run()
  await started.promise
  assert.equal(h.events.some(event => event.type === 'assistant/message'), false)
  assert.equal(counts.post, 0)
  streamGate.resolve()
  await idle
  assert.deepEqual(h.errors, [])
  assert.equal(calls, 1)
  assert.deepEqual(counts, { pre: 1, execute: 1, post: 1, result: 1 })
  const types = h.events.map(event => event.type)
  assert.ok(types.indexOf('assistant/message') < types.indexOf('tool/call'))
  assert.ok(types.indexOf('tool/call') < types.indexOf('tool/result'))
  await h.fork.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.ctx.tools, 'resolve'), h.originalResolve)
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.ctx.tools, 'execute'), h.originalExecute)
})

test('disabled plugin uses stock execution after the stream completes', { timeout: 5000 }, async t => {
  let h
  let calls = 0
  h = await setup(t, async function* () {
    yield* call()
    await delay(20)
    assert.equal(calls, 0)
    yield finish('tool-calls')
  }, false)
  h.register('read_fixture', async () => { calls++; return 'ok' })
  await h.run()
  assert.deepEqual(h.errors, [])
  assert.equal(calls, 1)
})

test('exclusive call and all following calls wait for message settlement', { timeout: 5000 }, async t => {
  const starts = []
  const h = await setup(t, async function* () {
    yield* call('a')
    yield* call('b', 'write_fixture', 1)
    yield* call('c', 'read_fixture', 2)
    await delay(20)
    assert.deepEqual(starts, ['a'])
    yield finish('tool-calls')
  })
  h.register('read_fixture', async (_args, exec) => { starts.push(exec.callId); return 'ok' })
  h.register('write_fixture', async (_args, exec) => { starts.push(exec.callId); return 'ok' }, false)
  await h.run()
  assert.deepEqual(h.errors, [])
  assert.deepEqual(starts, ['a', 'b', 'c'])
  assert.deepEqual(h.events.filter(e => e.type === 'tool/call').map(e => e.data.callId), ['a', 'b', 'c'])
})

test('step admission is evaluated once and passed to speculative conditional tools', { timeout: 5000 }, async t => {
  let started
  const h = await setup(t, async function* () { yield* call(); await started.promise; yield finish('tool-calls') })
  started = h.gate()
  let conditions = 0
  h.register('read_fixture', async (_args, exec) => { assert.ok(exec.toolSet); started.resolve(); return 'ok' }, true,
    { when: () => { conditions++; return true } })
  await h.run()
  assert.deepEqual(h.errors, [])
  // One condition evaluation per model step, including the final stop response.
  assert.equal(conditions, 2)
})

test('inactive tools never execute, even if the model emits their name', { timeout: 5000 }, async t => {
  let calls = 0
  const h = await setup(t, async function* () { yield* call(); yield finish('tool-calls') })
  h.register('read_fixture', async () => { calls++; return 'bad' }, true, { when: () => false })
  await h.run()
  assert.equal(calls, 0)
  assert.deepEqual(h.errors, [])
  assert.equal(h.events.find(e => e.type === 'tool/result').data.message.isError, true)
})

test('a custom scoped executor retains ownership and executes after stream settlement', { timeout: 5000 }, async t => {
  let calls = 0
  let batches = 0
  const h = await setup(t, async function* () {
    yield* call()
    await delay(20)
    assert.equal(calls, 0)
    assert.equal(batches, 0)
    yield finish('tool-calls')
  })
  await h.ctx.plugin(Object.assign(inner => {
    const scope = createScope(inner, h.agent)
    const native = new NativeToolExecutor(scope.ctx)
    scope.ctx.tools.setExecutor({
      describe: tools => native.describe(tools),
      execute: input => { batches++; return native.execute(input) },
    })
  }, { inject: ['tools', 'systemPrompt'] }))
  h.register('read_fixture', async () => { calls++; return 'ok' })
  await h.run()
  assert.deepEqual(h.errors, [])
  assert.equal(calls, 1)
  assert.equal(batches, 1)
})

test('concurrent agents can reuse the same call id without claiming each other', { timeout: 5000 }, async t => {
  let bothStarted
  const seen = new Set()
  const script = async function* (options) {
    if (seen.has(options.sessionId)) { yield finish('stop'); return }
    seen.add(options.sessionId)
    yield* call('shared-id')
    await bothStarted.promise
    yield finish('tool-calls')
  }
  script.repeat = true
  const h = await setup(t, script)
  bothStarted = h.gate()
  const starts = []
  h.register('read_fixture', async (_args, exec) => {
    starts.push(exec.agent.id)
    if (starts.length === 2) bothStarted.resolve()
    return exec.agent.id
  })
  const second = await h.ctx.agentLoop.create('second', { provider: 'mock', model: 'fixture' })
  await Promise.all([h.run(), h.run(second)])
  assert.deepEqual(h.errors, [])
  assert.deepEqual(starts.sort(), ['second', 'stream-test'])
  assert.equal(h.events.filter(e => e.type === 'tool/result').length, 2)
})

test('max-tokens aborts and drains speculation without committing tool results', { timeout: 5000 }, async t => {
  let started
  let cleaned = false
  const h = await setup(t, async function* () { yield* call(); await started.promise; yield finish('max-tokens') })
  started = h.gate()
  h.register('read_fixture', async (_args, exec) => {
    started.resolve()
    try { await delay(10000, undefined, { signal: exec.signal }); return 'bad' }
    finally { await delay(20); cleaned = true }
  })
  await h.run()
  assert.equal(cleaned, true)
  assert.equal(h.events.some(e => e.type === 'tool/result'), false)
})

test('unloading aborts running speculation and restores native pipeline methods', { timeout: 5000 }, async t => {
  let streamGate
  const h = await setup(t, async function* () { yield* call(); await streamGate.promise; yield finish('max-tokens') })
  streamGate = h.gate()
  const started = h.gate()
  let cleaned = false
  const pipeline = h.ctx.tools.selectExecutor(h.agent).pipeline
  const prepare = pipeline.prepare
  const dispatch = pipeline.dispatch
  h.register('read_fixture', async (_args, exec) => {
    started.resolve()
    try { await delay(10000, undefined, { signal: exec.signal }); return 'bad' }
    finally { cleaned = true }
  })
  const idle = h.run()
  await started.promise
  await h.fork.dispose()
  assert.equal(cleaned, true)
  assert.equal(pipeline.prepare, prepare)
  assert.equal(pipeline.dispatch, dispatch)
  streamGate.resolve()
  await idle
})

test('caller cancellation drains tools before the real loop becomes idle', { timeout: 5000 }, async t => {
  let started
  let cleaned = false
  const h = await setup(t, async function* (options) {
    yield* call()
    await started.promise
    await delay(10000, undefined, { signal: options.signal })
  })
  started = h.gate()
  h.register('read_fixture', async (_args, exec) => {
    started.resolve()
    try { await delay(10000, undefined, { signal: exec.signal }); return 'bad' }
    finally { await delay(30); cleaned = true }
  })
  const idle = h.run()
  await started.promise
  h.agent.cancel({ kind: 'user' })
  await idle
  assert.equal(cleaned, true)
})

test('failed attempt drains before retry and reused call ids execute once per attempt', { timeout: 5000 }, async t => {
  let started
  let cleaned = false
  let calls = 0
  const script = async function* (_options, request) {
    if (request === 3) { yield finish('stop'); return }
    if (request === 2) assert.equal(cleaned, true)
    yield* call()
    if (request === 1) {
      await started.promise
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'retry fixture' } } }
    } else yield finish('tool-calls')
  }
  script.repeat = true
  const h = await setup(t, script)
  started = h.gate()
  h.ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
  h.register('read_fixture', async (_args, exec) => {
    calls++
    if (calls === 1) {
      started.resolve()
      try { await delay(10000, undefined, { signal: exec.signal }) }
      finally { await delay(20); cleaned = true }
    }
    return 'ok'
  })
  await h.run()
  assert.deepEqual(h.errors, [])
  assert.equal(calls, 2)
  assert.equal(h.events.filter(e => e.type === 'tool/result').length, 1)
})

test('monotonic guards still deny speculative tools and publish one result', { timeout: 5000 }, async t => {
  const h = await setup(t, async function* () { yield* call(); await delay(10); yield finish('tool-calls') })
  let calls = 0
  h.register('read_fixture', async () => { calls++; return 'bad' })
  h.ctx.tools.guard(() => 'fixture denial')
  await h.run()
  assert.equal(calls, 0)
  assert.deepEqual(h.errors, [])
  assert.equal(h.events.filter(e => e.type === 'tool/result').length, 1)
  assert.equal(h.events.find(e => e.type === 'tool/result').data.message.isError, true)
})

test('policy gates are ordered while accepted tool bodies overlap', { timeout: 5000 }, async t => {
  let gate
  const h = await setup(t, async function* () {
    yield* call('a'); yield* call('b', 'read_fixture', 1)
    await delay(20)
    assert.deepEqual(prepared, ['a'])
    gate.resolve()
    yield finish('tool-calls')
  })
  gate = h.gate()
  const prepared = []
  const bodies = []
  h.ctx.on('tools/pre-execute', async (exec, next) => {
    prepared.push(exec.callId)
    if (exec.callId === 'a') await gate.promise
    return next()
  })
  h.register('read_fixture', async (_args, exec) => { bodies.push(exec.callId); return 'ok' })
  await h.run()
  assert.deepEqual(h.errors, [])
  assert.deepEqual(prepared, ['a', 'b'])
  assert.deepEqual(bodies, ['a', 'b'])
})

test('parallel capacity replenishes while decode is open and results retain model order', { timeout: 5000 }, async t => {
  let release
  let twoStarted
  let thirdStarted
  let active = 0
  let peak = 0
  const h = await setup(t, async function* () {
    yield* call('a'); yield* call('b', 'read_fixture', 1); yield* call('c', 'read_fixture', 2)
    await twoStarted.promise
    assert.equal(active, 2)
    release.resolve()
    await thirdStarted.promise
    yield finish('tool-calls')
  }, true, 2)
  release = h.gate(); twoStarted = h.gate(); thirdStarted = h.gate()
  const calls = []
  h.register('read_fixture', async (_args, exec) => {
    calls.push(exec.callId)
    active++; peak = Math.max(peak, active)
    if (active === 2) twoStarted.resolve()
    if (exec.callId === 'c') thirdStarted.resolve()
    if (exec.callId !== 'c') await release.promise
    active--
    return exec.callId
  })
  await h.run()
  assert.deepEqual(h.errors, [])
  assert.equal(peak, 2)
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.equal(h.events.filter(e => e.type === 'tool/result').length, 3)
})

test('unloading during native batch consumption drains without re-running queued bodies', { timeout: 5000 }, async t => {
  let bothStarted
  const h = await setup(t, async function* () {
    yield* call('a'); yield* call('b', 'read_fixture', 1)
    await bothStarted.promise
    yield finish('tool-calls')
  })
  bothStarted = h.gate()
  const batchStarted = h.gate()
  h.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/call') batchStarted.resolve() })
  let calls = 0
  let cleaned = 0
  h.register('read_fixture', async (_args, exec) => {
    calls++
    if (calls === 2) bothStarted.resolve()
    try { await delay(10000, undefined, { signal: exec.signal }); return 'bad' }
    finally { cleaned++ }
  })
  const idle = h.run()
  await batchStarted.promise
  await h.fork.dispose()
  await idle
  assert.equal(calls, 2)
  assert.equal(cleaned, 2)
  assert.deepEqual(h.errors, [])
})

test('approval without an approval channel denies early execution', { timeout: 5000 }, async t => {
  const h = await setup(t, async function* () { yield* call(); yield finish('tool-calls') })
  let calls = 0
  h.ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'approval required' }))
  h.register('read_fixture', async () => { calls++; return 'bad' })
  await h.run()
  assert.equal(calls, 0)
  assert.deepEqual(h.errors, [])
  assert.equal(h.events.find(e => e.type === 'tool/result').data.message.isError, true)
})


test('unload after speculative dispatch and before normal stream finish never replays the body', { timeout: 5000 }, async t => {
  let gate
  const h = await setup(t, async function* () { yield* call(); await gate.promise; yield finish('tool-calls') })
  gate = h.gate()
  const started = h.gate()
  let calls = 0
  h.register('read_fixture', async () => { calls++; started.resolve(); return 'ok' })
  const idle = h.run()
  await started.promise
  await h.fork.dispose()
  gate.resolve()
  await idle
  assert.equal(calls, 1)
  assert.deepEqual(h.errors, [])
})
