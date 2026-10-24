#!/usr/bin/env node
// Historical v1.1-live replay on complete Binance monthly archives (no database access).
// Usage: npx tsx scripts/research/run-historical-baseline.mts --from-month=2023-10 --to-month=2026-09
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { candleCloseTime } from '../../lib/live-window'
import { loadArchivedCandles, type ArchiveFile } from './binance-archive'
import { SYMBOLS } from './live-baseline-core'
import { TAIL_BARS, WARMUP_BARS, analyzeHistory, replaySignals, type HistoricalSignal } from './historical-baseline'

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(from-month|to-month|holdout-end-month|output|permutations|seed)=(.+)$/.exec(arg)
  if (!match) throw new Error(`Unknown argument: ${arg}`)
  return [match[1], match[2]]
}))
const monthStart = (key: string, offset = 0) => {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  if (!match) throw new Error(`Month must be YYYY-MM: ${key}`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1)
}
const fromMonth = args['from-month'] ?? '2023-10', toMonth = args['to-month'] ?? '2026-09'
const holdoutMonth = args['holdout-end-month'] ?? '2024-09'
const startMs = monthStart(fromMonth), endMs = monthStart(toMonth, 1) - 1
const holdoutEnd = monthStart(holdoutMonth, 1) - 1
if (endMs >= Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) {
  throw new Error('Monthly archives cover finished months only; choose an earlier --to-month')
}
const iterations = Number(args.permutations ?? 2000), seed = Number(args.seed ?? 20261024)
if (!Number.isSafeInteger(iterations) || iterations < 100 || !Number.isSafeInteger(seed)) throw new Error('Invalid permutation settings')
const output = args.output ?? 'reports/historical-baseline.json'

const series = new Map<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]>()
const volatility = new Map<string, (number | null)[]>()
const manifest: ArchiveFile[] = []
const coverage = [], exclusions = []
const signals: HistoricalSignal[] = []
for (const symbol of SYMBOLS) {
  const loaded = await loadArchivedCandles(symbol, startMs, endMs)
  manifest.push(...loaded.manifest)
  coverage.push({ symbol, expected: (endMs + 1 - startMs) / 900_000, observed: loaded.candles.length,
    first_open: new Date(loaded.candles[0].openTime).toISOString(),
    last_open: new Date(loaded.candles[loaded.candles.length - 1].openTime).toISOString() })
  console.log(`${symbol}: ${loaded.candles.length} candles verified, replaying v1.1-live...`)
  const replay = replaySignals(symbol, loaded.candles)
  signals.push(...replay.signals)
  volatility.set(symbol, replay.volatility)
  exclusions.push({ symbol, ...replay.excluded, long_signals: replay.signals.length })
  series.set(symbol, loaded.candles.map(c => ({ time: candleCloseTime(c), open: c.open, high: c.high,
    low: c.low, close: c.close, volume: c.volume })))
}

const results = analyzeHistory(series, signals, volatility, { iterations, seed, holdoutEnd })
const codeHash = createHash('sha256')
for (const file of ['scripts/research/run-historical-baseline.mts', 'scripts/research/historical-baseline.ts',
  'scripts/research/binance-archive.ts', 'scripts/research/historical-coverage.ts',
  'scripts/research/live-baseline-core.ts', 'lib/live-window.ts', 'lib/features.ts', 'lib/scoring.ts']) {
  codeHash.update(file).update(readFileSync(file))
}
const report = {
  report_name: 'radar-crypto-historical-baseline', generated_at: new Date().toISOString(),
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  audit_code_sha256: codeHash.digest('hex'), model_version: 'v1.1-live',
  window: { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString(),
    holdout_end: new Date(holdoutEnd).toISOString(), symbols: SYMBOLS },
  data: { source: 'data.binance.vision spot monthly klines 15m',
    manifest_sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    coverage, exclusions, files: manifest },
  preregistered: {
    hypothesis: 'H1: in the holdout (window start to holdout_end, never used for score-bucket analysis), the 4h next-open excess of score 80-100 LONG signals is >= that of score 75-79.',
    decision: 'H1 holds -> the live 80-100 inversion is treated as window/regime-specific; H1 fails -> it is treated as structural.',
  },
  method: {
    signal: `replayLiveSignal on each closed candle with the live 249-candle window; first ${WARMUP_BARS} and last ${TAIL_BARS} candles excluded by construction.`,
    primary_execution: 'Signal at candle i close, enter i+1 open, exit i+bars+1 open; 20 and 30 bps round trip.',
    comparator: 'Close-to-close (stored production outcome definition) reported only as comparator.',
    baseline: 'Every eligible candle of the same symbol and window, weighted by signal count.',
    permutation: `${iterations} seeded circular shifts shared across assets; score contrasts use label permutation (optimistic under overlap).`,
  },
  results,
}
await mkdir(output.slice(0, Math.max(0, output.lastIndexOf('/'))) || '.', { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
for (const row of results) {
  console.log(`${row.horizon}: ${row.signals} LONG, next-open excess ${(Number(row.next_open.excess) * 100).toFixed(4)}% ` +
    `(p=${row.next_open.p.two_sided.toFixed(4)}), net 20bps ${(Number(row.next_open.net_20bps) * 100).toFixed(4)}%`)
}
console.log(`Wrote ${output}`)
