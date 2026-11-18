#!/usr/bin/env node
/** 调试：F3 单轮，打印全部 session/event 与 agent/error */
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../index.js'

const now = () => performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const blockStart = i => ({ type: 'block-start', index: i, blockType: 'tool-call' })
const blockDelta = (i, id, name, a) => ({ type: 'tool-call-delta', index: i, id, name, argumentsDelta: a })
const blockEnd = (i, id, name, a) => ({ type: 'block-end', index: i, block: { type: 'tool-call', id, name, arguments: a } })
const finish = kind => ({ type: 'finish', reason: { kind } })

const ctx = new Context()
const events = []
let requests = 0
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
await ctx.plugin(plugin, { streamingToolExecution: true })
const agent = await ctx.agentLoop.create('dbg', { provider: 'mock', model: 'fixture' })
ctx.on('session/event', (_s, e) => {
  events.push({ type: e.type, callId: e.callId ?? undefined, name: e.name ?? undefined, at: now() })
})
ctx.on('agent/error', p => events.push({ type: 'AGENT_ERROR', text: String(p.error) }))
ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
  async *stream() {
    requests++
    if (requests > 1) { yield { type: 'text-delta', index: 0, text: 'done' }; yield finish('stop'); return }
    // 与 bench/v2.mjs 的 F3 完全一致
    for (const [index, id, name] of [[0, 'c-long', 'probe_long'], [1, 'c-s1', 'probe_short'], [2, 'c-s2', 'probe_short']]) {
      yield blockStart(index)
      let args = ''
      for (const piece of ['{"a":', '1,', '"b":', '2}']) {
        await sleep(20)
        args += piece
        yield blockDelta(index, id, name, piece)
      }
      yield blockEnd(index, id, name, args)
    }
    yield finish('tool-calls')
  }
}())
const mkTool = (name, ms) => ctx.tools.register({
  name, description: name, parameters: { type: 'object' },
  output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
  isConcurrencySafe: () => true,
  execute: async () => { await sleep(name === 'probe_long' ? 1500 : 50); return 'ok' },
})
mkTool('probe_long', 1500)
mkTool('probe_short', 50)

const idle = new Promise(resolve => {
  const off = ctx.on('agent/status', p => {
    if (p.agent === agent && p.status === 'idle') { off(); resolve() }
  })
})
agent.followup(createUserMessage({ content: [{ type: 'text', text: 'bench' }], source: { kind: 'user' } }))
await idle
console.log('=== 事件序列 ===')
let last = now()
for (const e of events) {
  const t = Number.isFinite(e.at) ? Math.round(e.at) : ''
  console.log(`  ${String(t).padStart(6)}  ${e.type}  ${e.callId ?? ''}  ${e.name ?? ''}  ${e.text ?? ''}`)
}
console.log('=== 工具相关事件计数 ===')
for (const t of ['tool/call', 'tool/result', 'assistant/message', 'AGENT_ERROR']) {
  console.log(`  ${t}: ${(events.filter(e => e.type === t)).length}`)
}
await ctx.fiber.dispose()
