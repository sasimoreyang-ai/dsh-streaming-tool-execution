#!/usr/bin/env node
/**
 * Deterministic A/B benchmark for mindagent-dsh-streaming-tool-execution.
 *
 * Runs the REAL rc.1 agent loop and REAL NativeToolExecutor with a scripted
 * model adapter, so the only variable between arms is `streamingToolExecution`.
 * No network, no API cost, no model nondeterminism.
 *
 * Usage:
 *   node bench/run.mjs latency [--repeats 5] [--out bench/out]
 *   node bench/run.mjs concurrency [--repeats 5]
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../index.js'

const now = () => performance.now()
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}

function* toolCallBlocks(count, name = 'probe') {
  for (let index = 0; index < count; index++) {
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: `call-${index}`, name, argumentsDelta: '{}' }
    yield { type: 'block-end', index, block: { type: 'tool-call', id: `call-${index}`, name, arguments: '{}' } }
  }
}

/**
 * One measured turn.
 * Timeline: request -> first chunk (ttft) -> tool-call block closed -> tool body
 * starts/ends -> assistant/message commits -> tool/call+tool/result commit -> idle.
 */
async function oneTurn({ enabled, callCount, chunkMs, remainingChunks, toolMs, agentName }) {
  const ctx = new Context()
  const marks = { toolStarts: [], toolEnds: [], blocks: [], chunks: 0, firstChunk: undefined, blockEnd: undefined }
  const durable = []
  let requests = 0
  let bodyRuns = 0

  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
    const harness = ctx.agentLoop
    if (enabled) await ctx.plugin(plugin, { streamingToolExecution: true })

    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type !== 'chunk') return
      marks.chunks++
      if (marks.firstChunk === undefined) marks.firstChunk = now()
      const chunk = frame.chunk
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        marks.blocks.push(now())
        if (marks.blockEnd === undefined) marks.blockEnd = now()
      }
    })
    ctx.on('session/event', (_session, event) => {
      if (['assistant/message', 'tool/call', 'tool/result'].includes(event.type)) {
        durable.push({ type: event.type, at: now() })
      }
    })

    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      async *stream() {
        requests++
        if (requests > 4) throw new Error('unexpected model loop')
        if (requests === 1) {
          yield* toolCallBlocks(callCount)
          for (let i = 0; i < remainingChunks; i++) {
            await sleep(chunkMs)
            yield { type: 'text-delta', index: callCount, text: '.' }
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())

    const agent = await harness.create(agentName, { provider: 'mock', model: 'fixture' })
    ctx.tools.register({
      name: 'probe',
      description: 'benchmark probe',
      parameters: { type: 'object' },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      execute: async () => {
        bodyRuns++
        marks.toolStarts.push(now())
        try {
          await sleep(toolMs)
          return 'ok'
        } finally {
          marks.toolEnds.push(now())
        }
      },
    })

    const idle = new Promise(resolve => {
      const off = ctx.on('agent/status', payload => {
        if (payload.agent === agent && payload.status === 'idle') { off(); resolve() }
      })
    })
    const t0 = now()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'bench' }], source: { kind: 'user' } }))
    await idle
    const tEnd = now()

    const at = list => (list.length === 0 ? undefined : Math.min(...list) - t0)
    const durableAt = type => {
      const hit = durable.find(event => event.type === type)
      return hit === undefined ? undefined : hit.at - t0
    }
    return {
      ok: true,
      enabled,
      callCount,
      chunkMs,
      remainingChunks,
      toolMs,
      ttft: marks.firstChunk === undefined ? undefined : +(marks.firstChunk - t0).toFixed(2),
      blockEnd: marks.blockEnd === undefined ? undefined : +(marks.blockEnd - t0).toFixed(2),
      toolStart: at(marks.toolStarts),
      toolEnd: at(marks.toolEnds),
      messageCommit: durableAt('assistant/message'),
      toolCallCommit: durableAt('tool/call'),
      toolResultCommit: durableAt('tool/result'),
      turnEnd: +(tEnd - t0).toFixed(2),
      bodyRuns,
      requests,
      durableOrderOk: durableAt('assistant/message') <= durableAt('tool/call')
        && durableAt('tool/call') <= durableAt('tool/result'),
      toolBeforeMessage: at(marks.toolStarts) !== undefined
        && durableAt('assistant/message') !== undefined
        && at(marks.toolStarts) < durableAt('assistant/message'),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Several agents inside ONE Context, to stress shared-service state. */
async function oneConcurrentBatch({ enabled, sessions, chunkMs, remainingChunks, toolMs }) {
  const ctx = new Context()
  const perAgent = new Map()
  let bodyRuns = 0
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
    const harness = ctx.agentLoop
    if (enabled) await ctx.plugin(plugin, { streamingToolExecution: true })

    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const mark = perAgent.get(agent)
      if (!mark || frame.type !== 'chunk') return
      if (mark.ttft === undefined) mark.ttft = now() - mark.t0
    })
    const seenSessions = new Set()
    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      async *stream(options) {
        const sessionKey = String(options.sessionId ?? '')
        if (seenSessions.has(sessionKey)) {
          yield { type: 'text-delta', index: 0, text: 'done' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        seenSessions.add(sessionKey)
        yield* toolCallBlocks(1)
        for (let i = 0; i < remainingChunks; i++) {
          await sleep(chunkMs)
          yield { type: 'text-delta', index: 1, text: '.' }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }())
    ctx.tools.register({
      name: 'probe',
      description: 'benchmark probe',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
      isConcurrencySafe: () => true,
      execute: async (_args, exec) => {
        bodyRuns++
        const mark = perAgent.get(exec.agent)
        if (mark && mark.toolStart === undefined) mark.toolStart = now() - mark.t0
        await sleep(toolMs)
        return 'ok'
      },
    })

    const agents = []
    for (let i = 0; i < sessions; i++) {
      agents.push(await harness.create(`concurrent-${enabled ? 'on' : 'off'}-${i}`, { provider: 'mock', model: 'fixture' }))
    }
    const t0 = now()
    const idles = agents.map(agent => {
      perAgent.set(agent, { t0 })
      return new Promise(resolve => {
        const off = ctx.on('agent/status', payload => {
          if (payload.agent === agent && payload.status === 'idle') {
            const mark = perAgent.get(agent)
            if (mark.turnEnd === undefined) mark.turnEnd = now() - t0
            off(); resolve()
          }
        })
      })
    })
    for (const agent of agents) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'bench' }], source: { kind: 'user' } }))
    }
    await Promise.all(idles)
    const wall = now() - t0
    const turns = [...perAgent.values()].map(mark => mark.turnEnd).filter(v => v !== undefined)
    const ttfts = [...perAgent.values()].map(mark => mark.ttft).filter(v => v !== undefined)
    const starts = [...perAgent.values()].map(mark => mark.toolStart).filter(v => v !== undefined)
    const p = (list, q) => {
      const sorted = [...list].sort((a, b) => a - b)
      return sorted.length === 0 ? undefined : +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2)
    }
    return {
      ok: true,
      enabled,
      sessions,
      chunkMs,
      remainingChunks,
      toolMs,
      wall: +wall.toFixed(2),
      bodyRuns,
      ttftP50: p(ttfts, 0.5),
      toolStartP50: p(starts, 0.5),
      turnEndP50: p(turns, 0.5),
      turnEndP95: p(turns, 0.95),
      turnEndMax: turns.length === 0 ? undefined : +Math.max(...turns).toFixed(2),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

function stats(list) {
  const sorted = [...list].filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return { n: 0 }
  const pick = q => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2)
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  return { n: sorted.length, min: sorted[0], p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1), mean: +mean.toFixed(2) }
}

async function latency({ repeats, outDir }) {
  const decodeConfigs = [
    { chunkMs: 20, remainingChunks: 3 },   // ~60ms remaining decode
    { chunkMs: 20, remainingChunks: 8 },   // ~160ms
    { chunkMs: 50, remainingChunks: 8 },   // ~400ms
  ]
  const toolDurations = [200, 500, 1000]
  const callCounts = [1, 3]

  // warmup (JIT + module init), discarded
  await oneTurn({ enabled: false, callCount: 1, chunkMs: 10, remainingChunks: 1, toolMs: 10, agentName: 'warmup' })
  await oneTurn({ enabled: true, callCount: 1, chunkMs: 10, remainingChunks: 1, toolMs: 10, agentName: 'warmup2' })

  const rows = []
  for (const decode of decodeConfigs) {
    for (const toolMs of toolDurations) {
      for (const callCount of callCounts) {
        for (let repeat = 0; repeat < repeats; repeat++) {
          // interleave arms per repeat so drift affects both equally
          for (const enabled of [false, true]) {
            const row = await oneTurn({
              enabled, callCount, ...decode, toolMs,
              agentName: `lat-${enabled ? 'on' : 'off'}-${decode.chunkMs}-${decode.remainingChunks}-${toolMs}-${callCount}-${repeat}`,
            })
            rows.push({ mode: 'latency', scenario: `${decode.chunkMs}ms×${decode.remainingChunks}/tool${toolMs}/calls${callCount}`, repeat, ...row })
            appendFileSync(join(outDir, 'samples.jsonl'), JSON.stringify(rows.at(-1)) + '\n')
          }
        }
      }
    }
  }

  // aggregate per scenario
  const scenarios = [...new Set(rows.map(r => r.scenario))]
  const table = []
  for (const scenario of scenarios) {
    const base = rows.filter(r => r.scenario === scenario && r.enabled === false)
    const on = rows.filter(r => r.scenario === scenario && r.enabled === true)
    const pick = (list, key) => stats(list.map(r => r[key]))
    const b = { turnEnd: pick(base, 'turnEnd'), toolStart: pick(base, 'toolStart'), ttft: pick(base, 'ttft'), messageCommit: pick(base, 'messageCommit') }
    const o = { turnEnd: pick(on, 'turnEnd'), toolStart: pick(on, 'toolStart'), ttft: pick(on, 'ttft'), messageCommit: pick(on, 'messageCommit') }
    table.push({
      scenario,
      baseTurnEndP50: b.turnEnd.p50, onTurnEndP50: o.turnEnd.p50,
      gainMs: +(b.turnEnd.p50 - o.turnEnd.p50).toFixed(2),
      gainPct: +(((b.turnEnd.p50 - o.turnEnd.p50) / b.turnEnd.p50) * 100).toFixed(2),
      baseToolStartP50: b.toolStart.p50, onToolStartP50: o.toolStart.p50,
      toolStartGainMs: +(b.toolStart.p50 - o.toolStart.p50).toFixed(2),
      baseTtftP50: b.ttft.p50, onTtftP50: o.ttft.p50,
      bodyRunsOk: on.every(r => r.bodyRuns === (r.callCount ?? 1)) && base.every(r => r.bodyRuns === (r.callCount ?? 1)),
      orderOk: on.every(r => r.durableOrderOk) && base.every(r => r.durableOrderOk),
      toolBeforeMessage: on.filter(r => r.toolBeforeMessage).length,
      samples: on.length,
    })
  }
  writeFileSync(join(outDir, 'latency.json'), JSON.stringify(table, null, 2))
  return table
}

async function concurrency({ repeats, outDir }) {
  const rows = []
  for (const sessions of [1, 4, 8]) {
    for (const toolMs of [200, 500]) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const enabled of [false, true]) {
          const row = await oneConcurrentBatch({ enabled, sessions, chunkMs: 20, remainingChunks: 8, toolMs })
          rows.push({ mode: 'concurrency', scenario: `sessions${sessions}/tool${toolMs}`, repeat, ...row })
          appendFileSync(join(outDir, 'samples.jsonl'), JSON.stringify(rows.at(-1)) + '\n')
        }
      }
    }
  }
  const scenarios = [...new Set(rows.map(r => r.scenario))]
  const table = []
  for (const scenario of scenarios) {
    const base = rows.filter(r => r.scenario === scenario && r.enabled === false)
    const on = rows.filter(r => r.scenario === scenario && r.enabled === true)
    table.push({
      scenario,
      baseWallP50: stats(base.map(r => r.wall)).p50,
      onWallP50: stats(on.map(r => r.wall)).p50,
      baseTurnEndP50: stats(base.map(r => r.turnEndP50)).p50,
      onTurnEndP50: stats(on.map(r => r.turnEndP50)).p50,
      baseTurnEndP95: stats(base.map(r => r.turnEndP95)).p50,
      onTurnEndP95: stats(on.map(r => r.turnEndP95)).p50,
      bodyRunsOk: on.every(r => r.bodyRuns === r.sessions) && base.every(r => r.bodyRuns === r.sessions),
      samples: on.length,
    })
  }
  writeFileSync(join(outDir, 'concurrency.json'), JSON.stringify(table, null, 2))
  return table
}

/**
 * Control arms: the plugin must not change the turn when there is nothing to
 * overlap (text-only) or when the call is exclusive (speculation must abstain).
 */
async function oneControlTurn({ enabled, kind, chunkMs, remainingChunks, toolMs, agentName }) {
  const ctx = new Context()
  const marks = { toolStart: undefined, finallyRan: 0 }
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
    const harness = ctx.agentLoop
    if (enabled) await ctx.plugin(plugin, { streamingToolExecution: true })
    const seen = new Set()
    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      async *stream(options) {
        const sessionKey = String(options.sessionId ?? '')
        const first = !seen.has(sessionKey)
        seen.add(sessionKey)
        if (kind === 'exclusive-tool' && first) {
          yield* toolCallBlocks(1)
        }
        const chunks = first ? remainingChunks : 1
        for (let i = 0; i < chunks; i++) {
          await sleep(chunkMs)
          yield { type: 'text-delta', index: kind === 'exclusive-tool' && first ? 1 : 0, text: '.' }
        }
        yield { type: 'finish', reason: { kind: kind === 'exclusive-tool' && first ? 'tool-calls' : 'stop' } }
      }
    }())
    if (kind === 'exclusive-tool') {
      ctx.tools.register({
        name: 'probe',
        description: 'benchmark probe',
        parameters: { type: 'object' },
        output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
        isConcurrencySafe: () => false,
        execute: async () => {
          marks.toolStart = now()
          await sleep(toolMs)
          return 'ok'
        },
      })
    }
    const agent = await harness.create(agentName, { provider: 'mock', model: 'fixture' })
    const idle = new Promise(resolve => {
      const off = ctx.on('agent/status', payload => {
        if (payload.agent === agent && payload.status === 'idle') { off(); resolve() }
      })
    })
    const t0 = now()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'bench' }], source: { kind: 'user' } }))
    await idle
    return {
      ok: true, enabled, kind,
      turnEnd: +(now() - t0).toFixed(2),
      toolStart: marks.toolStart === undefined ? undefined : +(marks.toolStart - t0).toFixed(2),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function control({ repeats, outDir }) {
  const rows = []
  const cases = [
    { kind: 'text-only', chunkMs: 20, remainingChunks: 8, toolMs: 0 },
    { kind: 'text-only', chunkMs: 50, remainingChunks: 8, toolMs: 0 },
    { kind: 'exclusive-tool', chunkMs: 20, remainingChunks: 8, toolMs: 300 },
  ]
  for (const item of cases) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const enabled of [false, true]) {
        const row = await oneControlTurn({ enabled, ...item, agentName: `ctl-${item.kind}-${enabled}-${repeat}` })
        rows.push({ mode: 'control', scenario: `${item.kind}/chunk${item.chunkMs}${item.kind === 'exclusive-tool' ? `/tool${item.toolMs}` : ''}`, repeat, ...row })
        appendFileSync(join(outDir, 'samples.jsonl'), JSON.stringify(rows.at(-1)) + '\n')
      }
    }
  }
  const table = []
  for (const scenario of [...new Set(rows.map(r => r.scenario))]) {
    const off = rows.filter(r => r.scenario === scenario && r.enabled === false)
    const on = rows.filter(r => r.scenario === scenario && r.enabled === true)
    const offTurn = stats(off.map(r => r.turnEnd))
    const onTurn = stats(on.map(r => r.turnEnd))
    table.push({
      scenario,
      offTurnP50: offTurn.p50, onTurnP50: onTurn.p50,
      deltaMs: +(onTurn.p50 - offTurn.p50).toFixed(2),
      deltaPct: +(((onTurn.p50 - offTurn.p50) / offTurn.p50) * 100).toFixed(2),
      offToolStart: stats(off.map(r => r.toolStart)).p50,
      onToolStart: stats(on.map(r => r.toolStart)).p50,
      samples: on.length,
    })
  }
  writeFileSync(join(outDir, 'control.json'), JSON.stringify(table, null, 2))
  return table
}

const mode = process.argv[2] ?? 'latency'
const repeats = Number(argOf('repeats', 5))
const outDir = argOf('out', 'bench/out')
mkdirSync(outDir, { recursive: true })
const table = mode === 'concurrency' ? await concurrency({ repeats, outDir })
  : mode === 'control' ? await control({ repeats, outDir })
    : await latency({ repeats, outDir })
console.log(JSON.stringify({ mode, repeats, rows: table.length }, null, 2))
for (const row of table) console.log(JSON.stringify(row))
