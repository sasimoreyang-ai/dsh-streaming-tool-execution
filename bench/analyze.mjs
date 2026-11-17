#!/usr/bin/env node
/** Aggregate bench/out/*.jsonl into report-ready tables. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'bench/out'
const samples = readFileSync(join(dir, 'samples.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line))

const stat = (values) => {
  const list = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (list.length === 0) return {}
  const pick = q => +list[Math.min(list.length - 1, Math.floor(q * list.length))].toFixed(2)
  return { n: list.length, min: +list[0].toFixed(2), p50: pick(0.5), p95: pick(0.95), max: +list.at(-1).toFixed(2) }
}

const latency = samples.filter(r => r.mode === 'latency' && r.ok)
const buckets = [...new Set(latency.map(r => r.scenario))]
const rows = []
for (const scenario of buckets) {
  const off = latency.filter(r => r.scenario === scenario && r.enabled === false)
  const on = latency.filter(r => r.scenario === scenario && r.enabled === true)
  const offTurn = stat(off.map(r => r.turnEnd))
  const onTurn = stat(on.map(r => r.turnEnd))
  // Delta = from the last tool-call block closing to the stock tool start (remaining decode + settle)
  const delta = stat(off.map(r => r.toolStart - r.blockEnd))
  const tool = off[0].toolMs
  const theoretical = Math.min(tool, delta.p50 ?? 0)
  rows.push({
    scenario,
    chunkMs: off[0].chunkMs,
    remainingChunks: off[0].remainingChunks,
    toolMs: tool,
    calls: off[0].callCount,
    offTurnP50: offTurn.p50, onTurnP50: onTurn.p50,
    gainMs: +(offTurn.p50 - onTurn.p50).toFixed(2),
    gainPct: +(((offTurn.p50 - onTurn.p50) / offTurn.p50) * 100).toFixed(2),
    offToolStartP50: stat(off.map(r => r.toolStart)).p50,
    onToolStartP50: stat(on.map(r => r.toolStart)).p50,
    toolAdvanceMs: +(stat(off.map(r => r.toolStart)).p50 - stat(on.map(r => r.toolStart)).p50).toFixed(2),
    deltaP50: delta.p50,
    theoreticalMs: +theoretical.toFixed(2),
    matchPct: theoretical > 0 ? +(((offTurn.p50 - onTurn.p50) / theoretical) * 100).toFixed(1) : undefined,
    offTtftP50: stat(off.map(r => r.ttft)).p50,
    onTtftP50: stat(on.map(r => r.ttft)).p50,
    bodiesOk: on.every(r => r.bodyRuns === r.callCount) && off.every(r => r.bodyRuns === r.callCount),
    orderOk: on.every(r => r.durableOrderOk) && off.every(r => r.durableOrderOk),
    toolBeforeMessageRuns: `${on.filter(r => r.toolBeforeMessage).length}/${on.length}`,
  })
}

// group gains by remaining-decode bucket for the summary table
const groupOf = (row) => {
  const remaining = row.chunkMs * row.remainingChunks
  return `${remaining}ms`
}
const summary = {}
for (const row of rows) {
  const key = groupOf(row)
  const entry = summary[key] ??= { remaining: +key.replace('ms', ''), gains: [], matches: [], advances: [] }
  entry.gains.push(row.gainMs)
  entry.matches.push(row.matchPct)
  entry.advances.push(row.toolAdvanceMs)
}
const summaryRows = Object.entries(summary).map(([key, entry]) => ({
  remainingDecode: entry.remaining,
  gainP50: stat(entry.gains).p50,
  gainMin: stat(entry.gains).min,
  gainMax: stat(entry.gains).max,
  toolsAdvanceP50: stat(entry.advances).p50,
  theoreticalMatchP50: stat(entry.matches).p50,
})).sort((a, b) => a.remainingDecode - b.remainingDecode)

const concurrency = samples.filter(r => r.mode === 'concurrency' && r.ok)
const concBuckets = [...new Set(concurrency.map(r => r.scenario))]
const concRows = []
for (const scenario of concBuckets) {
  const off = concurrency.filter(r => r.scenario === scenario && r.enabled === false)
  const on = concurrency.filter(r => r.scenario === scenario && r.enabled === true)
  concRows.push({
    scenario,
    sessions: off[0].sessions,
    toolMs: off[0].toolMs,
    offWallP50: stat(off.map(r => r.wall)).p50,
    onWallP50: stat(on.map(r => r.wall)).p50,
    gainPct: +(((stat(off.map(r => r.wall)).p50 - stat(on.map(r => r.wall)).p50) / stat(off.map(r => r.wall)).p50) * 100).toFixed(2),
    offTurnP95: stat(off.map(r => r.turnEndP95)).p50,
    onTurnP95: stat(on.map(r => r.turnEndP95)).p50,
    bodiesOk: on.every(r => r.bodyRuns === r.sessions) && off.every(r => r.bodyRuns === r.sessions),
  })
}

writeFileSync(join(dir, 'report-tables.json'), JSON.stringify({ rows, summaryRows, concRows }, null, 2))

const md = []
md.push('### 表 A：延迟矩阵（每次调用 1 个工具）')
md.push('')
md.push('| 场景（chunk 间隔×剩余块 / 工具耗时） | 基线 turnE2E p50 (ms) | 插件 turnE2E p50 (ms) | 收益 (ms) | 收益 (%) | 基线工具启动 (ms) | 插件工具启动 (ms) | 理论收益 min(T,Δ) | 吻合度 |')
md.push('|---|---|---|---|---|---|---|---|---|')
for (const row of rows.filter(r => r.calls === 1)) {
  md.push(`| ${row.chunkMs}ms×${row.remainingChunks} / ${row.toolMs}ms | ${row.offTurnP50} | ${row.onTurnP50} | ${row.gainMs} | ${row.gainPct}% | ${row.offToolStartP50} | ${row.onToolStartP50} | ${row.theoreticalMs} | ${row.matchPct}% |`)
}
md.push('')
md.push('### 表 B：延迟矩阵（每次调用 3 个并行安全工具）')
md.push('')
md.push('| 场景 | 基线 turnE2E p50 | 插件 turnE2E p50 | 收益 (ms) | 收益 (%) | 基线工具启动 | 插件工具启动 | 理论收益 | 吻合度 | 工具体执行次数 | 落库顺序 |')
md.push('|---|---|---|---|---|---|---|---|---|---|---|')
for (const row of rows.filter(r => r.calls === 3)) {
  md.push(`| ${row.chunkMs}ms×${row.remainingChunks} / ${row.toolMs}ms | ${row.offTurnP50} | ${row.onTurnP50} | ${row.gainMs} | ${row.gainPct}% | ${row.offToolStartP50} | ${row.onToolStartP50} | ${row.theoreticalMs} | ${row.matchPct}% | ${row.bodiesOk ? '1×' : '异常'} | ${row.orderOk ? 'OK' : '异常'} |`)
}
md.push('')
md.push('### 表 C：按剩余解码时长归并')
md.push('')
md.push('| 剩余解码 Δ (ms) | 收益 p50 (ms) | 收益区间 (ms) | 工具启动提前 p50 (ms) | 与理论值吻合度 p50 |')
md.push('|---|---|---|---|---|')
for (const row of summaryRows) {
  md.push(`| ${row.remainingDecode} | ${row.gainP50} | ${row.gainMin}–${row.gainMax} | ${row.toolsAdvanceP50} | ${row.theoreticalMatchP50}% |`)
}
md.push('')
md.push('### 表 D：并发（单进程多会话）')
md.push('')
md.push('| 会话数 / 工具耗时 | 基线墙钟 p50 (ms) | 插件墙钟 p50 (ms) | 收益 (%) | 基线单轮 p95 | 插件单轮 p95 | 工具体执行次数 |')
md.push('|---|---|---|---|---|---|---|')
for (const row of concRows) {
  md.push(`| ${row.sessions} / ${row.toolMs}ms | ${row.offWallP50} | ${row.onWallP50} | ${row.gainPct}% | ${row.offTurnP95} | ${row.onTurnP95} | ${row.bodiesOk ? '每调用 1 次' : '异常'} |`)
}
writeFileSync(join(dir, 'report-tables.md'), md.join('\n') + '\n')
console.log(md.join('\n'))
