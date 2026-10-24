#!/usr/bin/env node
// Read-only reproduction of stored v1.1-live LONG outcomes and matched random-entry baseline.
// Usage: npx tsx scripts/research/live-baseline.mts --from=ISO --to=ISO
import nextEnv from '@next/env'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { BAR_MS, HORIZONS, SYMBOLS, circularPValue, episodes, mean, tradeReturn,
  validateSnapshots, type RawSnapshot } from './live-baseline-core'
import { auditPrefix } from './prefix-audit'

nextEnv.loadEnvConfig(process.cwd())
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(from|to|output|permutations|seed)=(.+)$/.exec(arg)
  if (!match) throw new Error(`Unknown argument: ${arg}`)
  return [match[1], match[2]]
}))
if (!args.from || !args.to) throw new Error('Explicit --from and --to candle-close ISO timestamps are required')
const from = Date.parse(args.from), to = Date.parse(args.to)
if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Invalid time window')
const iterations = Number(args.permutations ?? 5000), seed = Number(args.seed ?? 20261021)
if (!Number.isSafeInteger(iterations) || iterations < 100 || !Number.isSafeInteger(seed)) throw new Error('Invalid permutation settings')
const output = args.output ?? 'reports/live-baseline-audit.json'
const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!base || !key) throw new Error('Read-only audit requires URL and server-only SUPABASE_SERVICE_ROLE_KEY')
const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }

async function readAll(table: string, params: Record<string, string>) {
  const rows: Record<string, unknown>[] = []
  let expected: number | null = null
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${base}/rest/v1/${table}`)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const response = await fetch(url, { headers: { ...headers, Range: `${offset}-${offset + 999}` },
      signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`Read ${table} failed: HTTP ${response.status}`)
    if (expected === null) expected = Number(response.headers.get('content-range')?.split('/')[1])
    const page = await response.json() as Record<string, unknown>[]
    rows.push(...page)
    if (page.length < 1000) break
  }
  if (!Number.isFinite(expected) || rows.length !== expected) throw new Error(`${table}: pagination ${rows.length}/${expected}`)
  return rows
}

const extendedTo = to + 17 * BAR_MS // Next-open exit after 16 complete bars.
const snapshots = await readAll('market_snapshots', {
  select: 'symbol,source_timestamp,open,high,low,close,volume', exchange: 'eq.binance',
  timeframe: 'eq.15m', source_timestamp: `gte.${new Date(from).toISOString()}`,
  and: `(source_timestamp.lte.${new Date(extendedTo).toISOString()})`,
  order: 'symbol.asc,source_timestamp.asc',
}) as RawSnapshot[]
const signals = await readAll('radar_signals', {
  select: 'id,symbol,signal_timestamp,entry_price,signal_score,decision,model_version,timeframe',
  decision: 'eq.LONG', model_version: 'eq.v1.1-live', timeframe: 'eq.15m',
  signal_timestamp: `gte.${new Date(from).toISOString()}`,
  and: `(signal_timestamp.lte.${new Date(to).toISOString()})`,
  order: 'symbol.asc,signal_timestamp.asc,id.asc',
}) as Array<{ id: number; symbol: string; signal_timestamp: string; entry_price: number; signal_score: number }>
const outcomes = await readAll('signal_outcomes', {
  select: 'signal_id,horizon,outcome,realized_return', order: 'signal_id.asc,horizon.asc',
}) as Array<{ signal_id: number; horizon: string; outcome: string; realized_return: number | null }>
if (!signals.length) throw new Error('No LONG signals in window')
const signalIds = new Set(signals.map(signal => signal.id))
const windowOutcomes = outcomes.filter(outcome => signalIds.has(outcome.signal_id))

const candles = new Map<string, ReturnType<typeof validateSnapshots>>()
for (const symbol of SYMBOLS) candles.set(symbol, validateSnapshots(
  snapshots.filter(row => row.symbol === symbol), symbol, from, extendedTo,
))
const windowBars = (to - from) / BAR_MS + 1
const indices = new Map(SYMBOLS.map(symbol => [symbol, [] as number[]]))
for (const signal of signals) {
  if (!indices.has(signal.symbol)) throw new Error(`Unexpected signal symbol: ${signal.symbol}`)
  const index = (Date.parse(signal.signal_timestamp) - from) / BAR_MS
  if (!Number.isInteger(index) || index < 0 || index >= windowBars) throw new Error(`Signal off candle grid: ${signal.id}`)
  const candle = candles.get(signal.symbol)![index]
  if (Math.abs(Number(signal.entry_price) - candle.close) > Math.max(1e-8, candle.close * 1e-10)) {
    throw new Error(`Signal entry does not match source close: ${signal.id}`)
  }
  indices.get(signal.symbol)!.push(index)
}
const outcomeMap = new Map(windowOutcomes.map(row => [`${row.signal_id}:${row.horizon}`, row]))
const prefixAudit = SYMBOLS.map(symbol => auditPrefix(symbol, candles.get(symbol)!, indices.get(symbol)!, windowBars))
let mismatchCount = 0, missingCount = 0
const results = []
for (const horizon of HORIZONS) {
  const closeReturns = new Map(SYMBOLS.map(symbol => [symbol, Array.from({ length: windowBars }, (_, i) =>
    tradeReturn(candles.get(symbol)!, i, horizon.bars, 'close'))]))
  const openReturns = new Map(SYMBOLS.map(symbol => [symbol, Array.from({ length: windowBars }, (_, i) =>
    tradeReturn(candles.get(symbol)!, i, horizon.bars, 'next_open'))]))
  const actualClose: number[] = [], actualOpen: number[] = []
  const bySymbol = []
  for (const symbol of SYMBOLS) {
    const positions = indices.get(symbol)!
    const closes = closeReturns.get(symbol)!, opens = openReturns.get(symbol)!
    const selectedClose = positions.map(i => closes[i]), selectedOpen = positions.map(i => opens[i])
    actualClose.push(...selectedClose); actualOpen.push(...selectedOpen)
    bySymbol.push({ symbol, signals: positions.length, episodes: episodes(positions, horizon.bars),
      signal_close_mean: mean(selectedClose), baseline_close_mean: mean(closes),
      signal_next_open_mean: mean(selectedOpen), baseline_next_open_mean: mean(opens) })
  }
  for (const signal of signals) {
    const stored = outcomeMap.get(`${signal.id}:${horizon.name}`)
    if (!stored || stored.realized_return === null) { missingCount++; continue }
    const i = (Date.parse(signal.signal_timestamp) - from) / BAR_MS
    const recalculated = closeReturns.get(signal.symbol)![i]
    if (Math.abs(Number(stored.realized_return) - recalculated) > 1e-10) mismatchCount++
  }
  const total = signals.length
  const matchedClose = bySymbol.reduce((sum, row) => sum + row.baseline_close_mean * row.signals, 0) / total
  const matchedOpen = bySymbol.reduce((sum, row) => sum + row.baseline_next_open_mean * row.signals, 0) / total
  const closeMean = mean(actualClose), openMean = mean(actualOpen)
  results.push({ horizon: horizon.name, signals: total,
    independent_episodes: bySymbol.reduce((sum, row) => sum + row.episodes, 0),
    close_to_close: { signal_mean: closeMean, matched_baseline: matchedClose,
      excess: closeMean - matchedClose, p: circularPValue(closeMean, matchedClose, indices,
        closeReturns, iterations, seed + horizon.bars) },
    next_open_to_next_open: { signal_mean: openMean, matched_baseline: matchedOpen,
      excess: openMean - matchedOpen, signal_net_20bps: openMean - 0.002,
      signal_net_30bps: openMean - 0.003 }, by_symbol: bySymbol })
}
if (missingCount || mismatchCount) throw new Error(`Stored outcomes: ${missingCount} missing, ${mismatchCount} mismatched; report withheld`)
const sha = (rows: unknown) => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
const auditCodeHash = createHash('sha256')
for (const file of ['scripts/research/live-baseline.mts', 'scripts/research/live-baseline-core.ts',
  'scripts/research/prefix-audit.ts', 'lib/live-window.ts', 'lib/features.ts', 'lib/scoring.ts']) {
  auditCodeHash.update(file).update(readFileSync(file))
}
const report = { report_name: 'radar-crypto-live-baseline-audit', generated_at: new Date().toISOString(),
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  audit_code_sha256: auditCodeHash.digest('hex'),
  model_version: 'v1.1-live', window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    last_required_candle: new Date(extendedTo).toISOString(), symbols: SYMBOLS,
    candles_per_symbol: windowBars + 17, signals: signals.length, stored_outcome_mismatches: mismatchCount },
  inputs_sha256: { snapshots: sha(snapshots), signals: sha(signals), outcomes: sha(windowOutcomes) },
  prefix_audit: prefixAudit,
  method: { snapshot_grid: 'Exact 15m close timestamps; missing/duplicate/invalid OHLCV aborts.',
    close_entry: 'Production outcome: signal candle close to horizon candle close.',
    next_open_entry: 'Signal at candle i close, enter i+1 open, exit i+bars+1 open.',
    costs: '20 and 30 bps round trip subtracted from next-open gross returns.',
    baseline: 'All eligible candle entries on the same symbol/window, weighted by signal count.',
    permutation: `${iterations} seeded circular shifts shared across assets; preserves signal clusters.` }, results }
await mkdir(output.slice(0, Math.max(0, output.lastIndexOf('/'))) || '.', { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(`Audit: ${signals.length} LONG signals, ${windowBars + 17} candles/asset, 0 outcome mismatches`)
for (const row of results) console.log(`${row.horizon}: close excess ${(row.close_to_close.excess * 100).toFixed(4)}%, p(two-sided)=${row.close_to_close.p.two_sided.toFixed(4)}; next-open net 20bps ${(row.next_open_to_next_open.signal_net_20bps * 100).toFixed(4)}%`)
console.log(`Wrote ${output} (aggregate only; source rows remain private)`)
