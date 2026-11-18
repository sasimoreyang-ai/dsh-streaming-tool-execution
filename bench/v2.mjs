#!/usr/bin/env node
/**
 * v2 unified benchmark runner — implements bench/PLAN.md.
 *
 * Modes:
 *   node bench/v2.mjs all        [--repeats 5] [--out bench/out-v2]
 *   node bench/v2.mjs latency    (F1..F4 matrix)
 *   node bench/v2.mjs long-short (F3 dedicated, larger tool)
 *   node bench/v2.mjs concurrency(F5: 1/4/8 sessions, F3 shape)
 *   node bench/v2.mjs control    (text-only, exclusive)
 *
 * Emits: samples JSONL + plan-v2.json with per-form results and judge verdicts.
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
const argOf = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? f : process.argv[i + 1] }

const blockStart = i => ({ type: 'block-start', index: i, blockType: 'tool-call' })
const blockDelta = (i, id, name, a) => ({ type: 'tool-call-delta', index: i, id, name, argumentsDelta: a })
const blockEnd = (i, id, name, a) => ({ type: 'block-end', index: i, block: { type: 'tool-call', id, name, arguments: a } })
const finish = kind => ({ type: 'finish', reason: { kind } })
const ARGS = ['{"a":', '1,', '"b":', '2}']

async function* streamCall(index, id, name, msPerChunk) {
  yield blockStart(index)
  let args = ''
  for (const piece of ARGS) {
    await sleep(msPerChunk)
    args += piece
    yield blockDelta(index, id, name, piece)
  }
  yield blockEnd(index, id, name, args)
}

/**
 * One measured turn.
 * shape: f1-single-tail | f2-equal-seq | f3-long-short | f4-text-after
 */
async function oneTurn({ enabled, shape, callMs, longMs, shortMs, textMs, textChunks, toolShortMs, maxParallel, sessions, agentName }) {
  const ctx = new Context()
  const mark = { firstChunk: undefined, blockEnds: [], messageCommit: undefined, runDetail: [],
    toolStart: {}, toolEnd: {}, events: [], runs: {}, errors: [] }
  let requests = 0
  const callSpec = { f1: [1], f2: [3], f3: [3], f4: [1] }[shape]
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
    const harness = ctx.agentLoop
    if (enabled) await ctx.plugin(plugin, { streamingToolExecution: true })

    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const m = mark
      if (frame.type !== 'chunk') return
      if (m.firstChunk === undefined) m.firstChunk = now()
      const c = frame.chunk
      if (c.type === 'block-end' && c.block?.type === 'tool-call') m.blockEnds.push({ id: c.block.id, at: now() })
    })
    ctx.on('session/event', (_s, e) => {
      if (['assistant/message', 'tool/call', 'tool/result'].includes(e.type)) mark.events.push({ type: e.type, at: now(), callId: e.callId })
    })
    ctx.on('agent/error', p => mark.errors.push(String(p.error)))

    const seen = new Set()
    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      async *stream(options) {
        requests++
        const key = String(options.sessionId ?? requests)
        if (seen.has(key)) { yield { type: 'text-delta', index: 0, text: 'done' }; yield finish('stop'); return }
        seen.add(key)
        if (shape === 'f1-single-tail') {
          yield* streamCall(0, 'c0', 'probe', callMs)
        } else if (shape === 'f2-equal-seq') {
          for (const i of [0, 1, 2]) yield* streamCall(i, `c${i}`, 'probe', callMs)
        } else if (shape === 'f3-long-short') {
          yield* streamCall(0, 'c-long', 'probe_long', callMs)
          yield* streamCall(1, 'c-s1', 'probe_short', callMs)
          yield* streamCall(2, 'c-s2', 'probe_short', callMs)
        } else if (shape === 'f4-text-after') {
          yield* streamCall(0, 'c0', 'probe', callMs)
          for (let i = 0; i < textChunks; i++) { await sleep(textMs); yield { type: 'text-delta', index: 1, text: '.' } }
        }
        yield finish('tool-calls')
      }
    }())

    const register = (name, ms, safe) => ctx.tools.register({
      name, description: name, parameters: { type: 'object' },
      output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
      isConcurrencySafe: () => safe,
      execute: async (_args, exec) => {
        const agentKey = sessions === undefined ? 'single' : String(exec.agent.id)
      mark.runDetail.push({ agent: agentKey, name })
        mark.runs[agentKey] ??= 0
        mark.runs[agentKey]++
        mark.toolStart[agentKey] ??= []
        mark.toolStart[agentKey].push(now())
        await sleep(ms)
        mark.toolEnd[agentKey] ??= []
        mark.toolEnd[agentKey].push(now())
        return 'ok'
      },
    })
    if (shape === 'f3-long-short') {
      register('probe_long', longMs ?? toolShortMs, true)
      register('probe_short', shortMs ?? toolShortMs, true)
    } else {
      register('probe', toolShortMs, true)
    }

    const agents = []
    const count = sessions ?? 1
    for (let i = 0; i < count; i++) {
      agents.push(await harness.create(`${agentName}-${i}`, { provider: 'mock', model: 'fixture' }))
    }
    const idlePromise = agent => new Promise(resolve => {
      const off = ctx.on('agent/status', p => {
        if (p.agent === agent && p.status === 'idle') { off(); resolve(now()) }
      })
    })
    const idles = agents.map(a => idlePromise(a))
    const t0 = now()
    for (const a of agents) {
      a.followup(createUserMessage({ content: [{ type: 'text', text: 'bench' }], source: { kind: 'user' } }))
    }
    const idleTimes = await Promise.all(idles)
    const turnEnd = now() - t0

    const t = v => v === undefined ? undefined : +(v - t0).toFixed(2)
    const eventsAt = type => {
      const hit = mark.events.find(e => e.type === type)
      return hit === undefined ? undefined : +(hit.at - t0).toFixed(2)
    }
    const firstBlockEnd = mark.blockEnds.length === 0 ? undefined : +(mark.blockEnds[0].at - t0).toFixed(2)
    const lastBlockEnd = mark.blockEnds.length === 0 ? undefined : +(mark.blockEnds.at(-1).at - t0).toFixed(2)
    const perAgentToolStart = Object.fromEntries(Object.entries(mark.toolStart).map(([k, v]) => [k, t(Math.min(...v))]))
    return {
      ok: mark.errors.length === 0 && Object.values(mark.runs).every(n => n > 0),
      enabled, shape, callMs, longMs, shortMs, textMs, textChunks, maxParallel, sessions: count,
      calls: shape === 'f2-equal-seq' || shape === 'f3-long-short' ? 3 : 1,
      ttft: t(mark.firstChunk),
      firstBlockEnd, lastBlockEnd,
      perAgentToolStart,
      messageCommit: eventsAt('assistant/message'),
      toolCallCommit: eventsAt('tool/call'),
      toolResultCommit: eventsAt('tool/result'),
      turnEnd: +turnEnd.toFixed(2),
      idleTimes: idleTimes.map(x => +(x - t0).toFixed(2)),
      runs: mark.runs,
      runDetail: mark.runDetail,
      errors: mark.errors,
      durableOrderOk: eventsAt('assistant/message') <= eventsAt('tool/call') && eventsAt('tool/call') <= eventsAt('tool/result'),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

const p50 = a => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null }
const p95 = a => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(0.95 * s.length))].toFixed(2) : null }
const avg = a => { const s = [...a].filter(Number.isFinite); return s.length ? +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2) : null }

function judgeSemantic(rows, callCount, sessions) {
  const ok = { S1: true, S2: true, S3: true, S4: true, S5: true }
  for (const r of rows) {
    for (const [agentKey, n] of Object.entries(r.runs)) {
      if (n !== callCount) ok.S1 = false
    }
    if (!r.durableOrderOk) ok.S2 = false
  }
  const ttftBase = p50(rows.filter(r => !r.enabled).map(r => r.ttft))
  const ttftOn = p50(rows.filter(r => r.enabled).map(r => r.ttft))
  if (ttftBase !== null && ttftOn !== null && Math.abs(ttftOn - ttftBase) > 2) ok.S3 = false
  return ok
}

async function latencyMode({ repeats, outDir }) {
  const shapes = [
    { shape: 'f1-single-tail', callMs: 20, toolShortMs: 500, label: 'F1 单工具·尾部' },
    { shape: 'f2-equal-seq', callMs: 20, toolShortMs: 500, label: 'F2 等长顺序流' },
    { shape: 'f2-equal-seq', callMs: 50, toolShortMs: 500, label: 'F2 等长顺序流(慢 delta)' },
    { shape: 'f3-long-short', callMs: 20, longMs: 1500, shortMs: 50, toolShortMs: 50, label: 'F3 长短混合' },
    { shape: 'f3-long-short', callMs: 50, longMs: 1500, shortMs: 50, toolShortMs: 50, label: 'F3 长短混合(慢 delta)' },
    { shape: 'f4-text-after', callMs: 20, textMs: 50, textChunks: 8, toolShortMs: 500, label: 'F4 文本后置(机制上界)' },
  ]
  const rows = []
  await oneTurn({ enabled: false, shape: 'f1-single-tail', callMs: 5, toolShortMs: 10, agentName: 'w1' })
  await oneTurn({ enabled: true, shape: 'f1-single-tail', callMs: 5, toolShortMs: 10, agentName: 'w2' })
  for (const spec of shapes) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = repeat % 2 === 0 ? [false, true] : [true, false]
      for (const enabled of order) {
        const row = await oneTurn({ ...spec, enabled, agentName: `lat-${spec.shape}-${spec.callMs}-${enabled}-${repeat}` })
        const record = { mode: 'latency', label: spec.label, scenario: `${spec.shape}/call${spec.callMs}`, repeat, ...row }
        rows.push(record)
        appendFileSync(join(outDir, 'samples-v2.jsonl'), JSON.stringify(record) + '\n')
      }
    }
  }
  const results = []
  for (const spec of shapes) {
    const scenario = `${spec.shape}/call${spec.callMs}`
    const rs = rows.filter(r => r.label === spec.label)
    const off = rs.filter(r => !r.enabled), on = rs.filter(r => r.enabled)
    const deltaFirst = p50(off.map(r => (r.toolStart?.single ?? r.messageCommit) - r.firstBlockEnd))
    const gain = +(p50(off.map(r => r.turnEnd)) - p50(on.map(r => r.turnEnd))).toFixed(2)
    const baseTurn = p50(off.map(r => r.turnEnd))
    results.push({
      label: spec.label, scenario,
      deltaFirstMs: deltaFirst,
      offTurnEndP50: baseTurn, onTurnEndP50: p50(on.map(r => r.turnEnd)),
      gainMs: gain, gainPct: +((gain / baseTurn) * 100).toFixed(2),
      offToolStartP50: p50(off.map(r => r.perAgentToolStart.single)),
      onToolStartP50: p50(on.map(r => r.perAgentToolStart.single)),
      semantic: judgeSemantic(rs, spec.shape === 'f2-equal-seq' || spec.shape === 'f3-long-short' ? 3 : 1),
    })
  }
  return { mode: 'latency', results, samples: rows.length }
}

async function longShortMode({ repeats, outDir }) {
  const configs = [
    { longMs: 800, shortMs: 50 },
    { longMs: 1500, shortMs: 50 },
    { longMs: 3000, shortMs: 50 },
  ]
  const rows = []
  await oneTurn({ enabled: false, shape: 'f3-long-short', callMs: 5, longMs: 10, shortMs: 5, toolShortMs: 5, agentName: 'w1' })
  await oneTurn({ enabled: true, shape: 'f3-long-short', callMs: 5, longMs: 10, shortMs: 5, toolShortMs: 5, agentName: 'w2' })
  for (const cfg of configs) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = repeat % 2 === 0 ? [false, true] : [true, false]
      for (const enabled of order) {
        const row = await oneTurn({ enabled, shape: 'f3-long-short', callMs: 20, toolShortMs: cfg.shortMs, ...cfg, agentName: `ls-${cfg.longMs}-${enabled}-${repeat}` })
        const record = { mode: 'long-short', scenario: `long${cfg.longMs}/short${cfg.shortMs}`, repeat, ...row }
        rows.push(record)
        appendFileSync(join(outDir, 'samples-v2.jsonl'), JSON.stringify(record) + '\n')
      }
    }
  }
  const results = []
  for (const cfg of configs) {
    const scenario = `long${cfg.longMs}/short${cfg.shortMs}`
    const rs = rows.filter(r => r.scenario === scenario)
    const off = rs.filter(r => !r.enabled), on = rs.filter(r => r.enabled)
    const gain = +(p50(off.map(r => r.turnEnd)) - p50(on.map(r => r.turnEnd))).toFixed(2)
    results.push({
      scenario,
      offTurnEndP50: p50(off.map(r => r.turnEnd)), onTurnEndP50: p50(on.map(r => r.turnEnd)),
      gainMs: gain, gainPct: +((gain / p50(off.map(r => r.turnEnd))) * 100).toFixed(2),
      longStartOff: p50(off.map(r => r.perAgentToolStart.single)), longStartOn: p50(on.map(r => r.perAgentToolStart.single)),
      bodiesOk: rs.every(r => Object.values(r.runs).every(n => n === r.calls)),
      semantic: judgeSemantic(rs, 3),
    })
  }
  return { mode: 'long-short', results, samples: rows.length }
}

async function concurrencyMode({ repeats, outDir }) {
  const rows = []
  await oneTurn({ enabled: false, shape: 'f3-long-short', callMs: 5, longMs: 10, shortMs: 5, toolShortMs: 5, sessions: 1, agentName: 'w1' })
  await oneTurn({ enabled: true, shape: 'f3-long-short', callMs: 5, longMs: 10, shortMs: 5, toolShortMs: 5, sessions: 1, agentName: 'w2' })
  for (const sessions of [1, 4, 8]) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = repeat % 2 === 0 ? [false, true] : [true, false]
      for (const enabled of order) {
        const row = await oneTurn({ enabled, shape: 'f3-long-short', callMs: 20, longMs: 800, shortMs: 50, toolShortMs: 50, sessions, agentName: `cc-${sessions}-${enabled}-${repeat}` })
        const record = { mode: 'concurrency', scenario: `sessions${sessions}`, repeat, ...row }
        rows.push(record)
        appendFileSync(join(outDir, 'samples-v2.jsonl'), JSON.stringify(record) + '\n')
      }
    }
  }
  const results = []
  for (const sessions of [1, 4, 8]) {
    const rs = rows.filter(r => r.sessions === sessions)
    const off = rs.filter(r => !r.enabled), on = rs.filter(r => r.enabled)
    results.push({
      sessions,
      offWallP50: p50(off.map(r => r.turnEnd)), onWallP50: p50(on.map(r => r.turnEnd)),
      gainMs: +(p50(off.map(r => r.turnEnd)) - p50(on.map(r => r.turnEnd))).toFixed(2),
      gainPct: +(((p50(off.map(r => r.turnEnd)) - p50(on.map(r => r.turnEnd))) / p50(off.map(r => r.turnEnd))) * 100).toFixed(2),
      offP95: p95(off.map(r => r.turnEnd)), onP95: p95(on.map(r => r.turnEnd)),
      bodiesOk: rs.every(r => Object.values(r.runs).every(n => n === 1)),
      semantic: judgeSemantic(rs, 3),
    })
  }
  return { mode: 'concurrency', results, samples: rows.length }
}

async function controlMode({ repeats, outDir }) {
  const rows = []
  for (const kind of ['text-only', 'exclusive-tool']) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = repeat % 2 === 0 ? [false, true] : [true, false]
      for (const enabled of order) {
        const row = await oneTurn({
          enabled, agentName: `ctl-${kind}-${enabled}-${repeat}`,
          shape: kind === 'exclusive-tool' ? 'f1-single-tail' : 'f4-text-after',
          callMs: 20, toolShortMs: kind === 'exclusive-tool' ? 300 : 10,
          textMs: 50, textChunks: 8,
        })
        const record = { mode: 'control', scenario: kind, repeat, ...row }
        rows.push(record)
        appendFileSync(join(outDir, 'samples-v2.jsonl'), JSON.stringify(record) + '\n')
      }
    }
  }
  const results = []
  for (const scenario of [...new Set(rows.map(r => r.scenario))]) {
    const off = rows.filter(r => r.scenario === scenario && !r.enabled)
    const on = rows.filter(r => r.scenario === scenario && r.enabled)
    const baseTurn = p50(off.map(r => r.turnEnd))
    const onTurn = p50(on.map(r => r.turnEnd))
    results.push({ scenario, offTurnP50: baseTurn, onTurnP50: onTurn,
      deltaMs: +(onTurn - baseTurn).toFixed(2), deltaPct: +(((onTurn - baseTurn) / baseTurn) * 100).toFixed(2) })
  }
  return { mode: 'control', results, samples: rows.length }
}

const mode = process.argv[2] ?? 'all'
const repeats = Number(argOf('repeats', 5))
const outDir = argOf('out', 'bench/out-v2')
mkdirSync(outDir, { recursive: true })

const parts = []
if (mode === 'all' || mode === 'latency') parts.push(await latencyMode({ repeats, outDir }))
if (mode === 'all' || mode === 'long-short') parts.push(await longShortMode({ repeats, outDir }))
if (mode === 'all' || mode === 'concurrency') parts.push(await concurrencyMode({ repeats, outDir }))
if (mode === 'all' || mode === 'control') parts.push(await controlMode({ repeats, outDir }))

const plan = { repeats, parts }
writeFileSync(join(outDir, 'plan-v2.json'), JSON.stringify(plan, null, 2))
console.log(JSON.stringify(plan, null, 2))
