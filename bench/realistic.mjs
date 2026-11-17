#!/usr/bin/env node
/**
 * Realistic-pattern benchmark: how large Δ (post-block-end streaming) really is
 * for the three shapes a real turn can take.
 *
 *   single-tail      : one tool call, nothing streams after it (only finish/usage)
 *   three-sequential : three tool calls whose arguments stream one after another
 *   text-after       : the artificial shape used in the main matrix (text after tool call)
 *
 * The plugin's gain is min(T, Δ) by construction, so the point of this script is
 * to measure Δ for each shape instead of assuming it.
 *
 * Usage: node bench/realistic.mjs [--repeats 5] [--out bench/out]
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

const blockStart = index => ({ type: 'block-start', index, blockType: 'tool-call' })
const blockDelta = (index, id, name, args) => ({ type: 'tool-call-delta', index, id, name, argumentsDelta: args })
const blockEnd = (index, id, name, args) => ({ type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } })
const finish = kind => ({ type: 'finish', reason: { kind } })

/** Argument bytes a real tool call carries; streamed as several deltas. */
const ARGS_CHUNKS = ['{"path":', '"README.md"', ',"limit":', '200}']

async function* streamOneCall(index, msPerChunk) {
  const id = `call-${index}`
  yield blockStart(index)
  let args = ''
  for (const piece of ARGS_CHUNKS) {
    await sleep(msPerChunk)
    args += piece
    yield blockDelta(index, id, 'probe', piece)
  }
  yield blockEnd(index, id, 'probe', args)
}

async function oneTurn({ enabled, pattern, callMs, toolMs, agentName }) {
  const ctx = new Context()
  const marks = { toolStarts: [], blockEnds: [], firstChunk: undefined }
  let requests = 0
  let bodyRuns = 0
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
    const harness = ctx.agentLoop
    if (enabled) await ctx.plugin(plugin, { streamingToolExecution: true })

    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type !== 'chunk') return
      if (marks.firstChunk === undefined) marks.firstChunk = now()
      const chunk = frame.chunk
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') marks.blockEnds.push(now())
    })

    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      async *stream() {
        requests++
        if (requests > 3) throw new Error('unexpected loop')
        if (requests > 1) {
          yield { type: 'text-delta', index: 0, text: 'done' }
          yield finish('stop')
          return
        }
        if (pattern === 'single-tail') {
          yield* streamOneCall(0, callMs)
        } else if (pattern === 'three-sequential') {
          yield* streamOneCall(0, callMs)
          yield* streamOneCall(1, callMs)
          yield* streamOneCall(2, callMs)
        } else if (pattern === 'text-after') {
          yield* streamOneCall(0, callMs)
          for (let i = 0; i < 8; i++) {
            await sleep(50)
            yield { type: 'text-delta', index: 1, text: '.' }
          }
        }
        yield finish('tool-calls')
      }
    }())

    const agent = await harness.create(agentName, { provider: 'mock', model: 'fixture' })
    ctx.tools.register({
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object' },
      output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
      isConcurrencySafe: () => true,
      execute: async () => {
        bodyRuns++
        marks.toolStarts.push(now())
        await sleep(toolMs)
        return 'ok'
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
    const turnEnd = now() - t0

    const firstBlockEnd = marks.blockEnds.length === 0 ? undefined : marks.blockEnds[0] - t0
    const firstToolStart = marks.toolStarts.length === 0 ? undefined : marks.toolStarts[0] - t0
    return {
      ok: true, enabled, pattern, callMs, toolMs,
      calls: pattern === 'three-sequential' ? 3 : 1,
      ttft: marks.firstChunk === undefined ? undefined : +(marks.firstChunk - t0).toFixed(2),
      firstBlockEnd: firstBlockEnd === undefined ? undefined : +firstBlockEnd.toFixed(2),
      firstToolStart: firstToolStart === undefined ? undefined : +firstToolStart.toFixed(2),
      delta: firstBlockEnd === undefined || firstToolStart === undefined ? undefined : +(firstToolStart - firstBlockEnd).toFixed(2),
      turnEnd: +turnEnd.toFixed(2),
      bodyRuns,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

const stat = values => {
  const list = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (list.length === 0) return {}
  const pick = q => +list[Math.min(list.length - 1, Math.floor(q * list.length))].toFixed(2)
  return { n: list.length, p50: pick(0.5), min: +list[0].toFixed(2), max: +list.at(-1).toFixed(2) }
}

const repeats = Number(argOf('repeats', 5))
const outDir = argOf('out', 'bench/out')
mkdirSync(outDir, { recursive: true })

// callMs = per-delta argument streaming time; 20ms ≈ a slow provider, 4 deltas per call
const cases = [
  { pattern: 'single-tail', callMs: 20, toolMs: 500 },
  { pattern: 'single-tail', callMs: 50, toolMs: 500 },
  { pattern: 'three-sequential', callMs: 20, toolMs: 500 },
  { pattern: 'three-sequential', callMs: 50, toolMs: 500 },
  { pattern: 'text-after', callMs: 20, toolMs: 500 },
]

await oneTurn({ enabled: false, pattern: 'single-tail', callMs: 5, toolMs: 5, agentName: 'warmup' })
await oneTurn({ enabled: true, pattern: 'single-tail', callMs: 5, toolMs: 5, agentName: 'warmup2' })

const rows = []
for (const item of cases) {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const enabled of [false, true]) {
      const row = await oneTurn({ ...item, enabled, agentName: `real-${item.pattern}-${enabled}-${repeat}` })
      rows.push(row)
      appendFileSync(join(outDir, 'samples.jsonl'), JSON.stringify({ mode: 'realistic', scenario: `${item.pattern}/call${item.callMs}`, repeat, ...row }) + '\n')
    }
  }
}

const table = []
for (const scenario of [...new Set(rows.map(r => `${r.pattern}/call${r.callMs}`))]) {
  const off = rows.filter(r => `${r.pattern}/call${r.callMs}` === scenario && !r.enabled)
  const on = rows.filter(r => `${r.pattern}/call${r.callMs}` === scenario && r.enabled)
  const offTurn = stat(off.map(r => r.turnEnd))
  const onTurn = stat(on.map(r => r.turnEnd))
  table.push({
    scenario,
    calls: off[0].calls,
    toolMs: off[0].toolMs,
    deltaP50: stat(off.map(r => r.delta)).p50,
    offTurnEndP50: offTurn.p50,
    onTurnEndP50: onTurn.p50,
    gainMs: +(offTurn.p50 - onTurn.p50).toFixed(2),
    gainPct: +(((offTurn.p50 - onTurn.p50) / offTurn.p50) * 100).toFixed(2),
    boundMs: +Math.min(off[0].toolMs, stat(off.map(r => r.delta)).p50 ?? 0).toFixed(2),
    bodiesOk: on.every(r => r.bodyRuns === r.calls) && off.every(r => r.bodyRuns === r.calls),
  })
}
writeFileSync(join(outDir, 'realistic.json'), JSON.stringify(table, null, 2))
console.log(JSON.stringify({ mode: 'realistic', repeats, rows: table.length }))
for (const row of table) console.log(JSON.stringify(row))
