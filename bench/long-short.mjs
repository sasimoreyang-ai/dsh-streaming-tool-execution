#!/usr/bin/env node
/** 例外形态：长工具(1500ms)的块先闭合，后面跟两个短工具(50ms)。
 *  关键路径 = 长工具。若插件有效，长工具应提前启动，整轮缩短。 */
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

async function* streamCall(index, id, name, msPerChunk) {
  yield blockStart(index)
  let args = ''
  for (const piece of ['{"a":', '1,', '"b":', '2}']) {
    await sleep(msPerChunk)
    args += piece
    yield blockDelta(index, id, name, piece)
  }
  yield blockEnd(index, id, name, args)
}

async function oneTurn({ enabled, callMs, longMs, shortMs, agentName }) {
  const ctx = new Context()
  const marks = { longStart: undefined, longBlockEnd: undefined, shortStart: undefined, longRuns: 0, shortRuns: 0 }
  let requests = 0
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
    const harness = ctx.agentLoop
    if (enabled) await ctx.plugin(plugin, { streamingToolExecution: true })

    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type !== 'chunk') return
      const c = frame.chunk
      if (c.type === 'block-end' && c.block?.type === 'probe_long') marks.longBlockEnd = now()
    })

    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      async *stream() {
        requests++
        if (requests > 1) { yield { type: 'text-delta', index: 0, text: 'done' }; yield finish('stop'); return }
        yield* streamCall(0, 'c-long', 'probe_long', callMs)
        yield* streamCall(1, 'c-s1', 'probe_short', callMs)
        yield* streamCall(2, 'c-s2', 'probe_short', callMs)
        yield finish('tool-calls')
      }
    }())

    const agent = await harness.create(agentName, { provider: 'mock', model: 'fixture' })
    const mkTool = (name, ms, isLong) => ctx.tools.register({
      name, description: name, parameters: { type: 'object' },
      output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
      isConcurrencySafe: () => true,
      execute: async () => {
        if (isLong) { marks.longRuns++; marks.longStart = now(); await sleep(longMs); return 'ok' }
        marks.shortRuns++; marks.shortStart = marks.shortStart === undefined ? now() : marks.shortStart
        await sleep(shortMs); return 'ok'
      },
    })
    mkTool('probe_long', longMs, true)
    mkTool('probe_short', shortMs, false)

    const idle = new Promise(resolve => {
      const off = ctx.on('agent/status', p => {
        if (p.agent === agent && p.status === 'idle') { off(); resolve() }
      })
    })
    const t0 = now()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'bench' }], source: { kind: 'user' } }))
    await idle
    return {
      ok: true, enabled,
      longStart: marks.longStart === undefined ? undefined : +(marks.longStart - t0).toFixed(2),
      longBlockEnd: marks.longBlockEnd === undefined ? undefined : +(marks.longBlockEnd - t0).toFixed(2),
      shortStart: marks.shortStart === undefined ? undefined : +(marks.shortStart - t0).toFixed(2),
      turnEnd: +(now() - t0).toFixed(2),
      longRuns: marks.longRuns, shortRuns: marks.shortRuns,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

const rows = []
for (let repeat = 0; repeat < 5; repeat++) {
  for (const enabled of [false, true]) {
    rows.push(await oneTurn({ enabled, callMs: 20, longMs: 1500, shortMs: 50, agentName: `ls-${enabled}-${repeat}` }))
  }
}
const p50 = a => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null }
const off = rows.filter(r => !r.enabled), on = rows.filter(r => r.enabled)
console.log(JSON.stringify({
  longStartBase: p50(off.map(r => r.longStart)), longStartOn: p50(on.map(r => r.longStart)),
  shortStartBase: p50(off.map(r => r.shortStart)), shortStartOn: p50(on.map(r => r.shortStart)),
  turnEndBase: p50(off.map(r => r.turnEnd)), turnEndOn: p50(on.map(r => r.turnEnd)),
  gainMs: +(p50(off.map(r => r.turnEnd)) - p50(on.map(r => r.turnEnd))).toFixed(2),
  bodiesOk: on.every(r => r.longRuns === 1 && r.shortRuns === 2) && off.every(r => r.longRuns === 1 && r.shortRuns === 2),
}, null, 2))