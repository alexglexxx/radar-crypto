import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Candle } from '../../lib/features'
import { calculateRadarScore } from '../../lib/scoring'
import { calculateFeatureSeries } from './production-features'

const exec = promisify(execFile)
const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(s => s.trim()).filter(Boolean)
const MONTHS = Number(process.env.MONTHS ?? 24)
const INTERVAL_MS = 15 * 60_000
const HOLD_BARS = 16 // Entry at next candle open; exit 4 hours after that entry.
const HOLD_MS = HOLD_BARS * INTERVAL_MS
const COSTS_BPS = [15, 20, 25]
const PRIMARY_COST_BPS = 15
const THRESHOLDS = [60, 65, 70, 75, 80, 85]
const MIN_TRAIN_TRADES = 100
const DATA_DIR = path.join(process.cwd(), '.backtest-cache-production')
const REPORT_DIR = path.join(process.cwd(), 'reports')

type Row = {
  symbol: string
  time: number
  entryTime: number
  exitTime: number
  score: number
  grossReturn: number
  regime: 'bull' | 'bear' | 'sideways'
  atrPct: number | null
}
type Stats = {
  threshold?: number
  trades: number
  winRate: number | null
  expectancy: number | null
  profitFactor: number | null
  totalReturn: number
  maxDrawdown?: number | null
}

function monthKeys(start: Date, end: Date): string[] {
  const out: string[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cursor <= last) {
    out.push(cursor.getUTCFullYear() + '-' + String(cursor.getUTCMonth() + 1).padStart(2, '0'))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

function addMonths(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
}

function buildFolds(start: Date, months: number) {
  const folds: { trainStart: number; testStart: number; testEnd: number; label: number }[] = []
  for (let offset = 0; offset + 15 <= months; offset += 3) {
    folds.push({
      trainStart: addMonths(start, offset).getTime(),
      testStart: addMonths(start, offset + 12).getTime(),
      testEnd: addMonths(start, offset + 15).getTime(),
      label: folds.length + 1,
    })
  }
  return folds
}

async function download(symbol: string, month: string): Promise<string | null> {
  const file = path.join(DATA_DIR, symbol + '-15m-' + month + '.zip')
  try { await fs.access(file); return file } catch {}
  const url = 'https://data.binance.vision/data/spot/monthly/klines/' + symbol + '/15m/' + symbol + '-15m-' + month + '.zip'
  const response = await fetch(url)
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Binance archive HTTP ' + response.status + ': ' + url)
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()))
  return file
}

async function unzip(file: string): Promise<Candle[]> {
  const dir = path.join(DATA_DIR, 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  try {
    await exec('unzip', ['-oq', file, '-d', dir])
    const csv = (await fs.readdir(dir)).find(name => name.endsWith('.csv'))
    if (!csv) throw new Error('No CSV in archive ' + file)
    const lines = (await fs.readFile(path.join(dir, csv), 'utf8')).trim().split(/\r?\n/)
    const firstDataRow = lines[0]?.toLowerCase().includes('open time') ? 1 : 0
    const candles: Candle[] = []
    for (let i = firstDataRow; i < lines.length; i++) {
      const fields = lines[i].split(',')
      if (fields.length < 6) continue
      const rawTime = Number(fields[0])
      const openTime = rawTime > 1e14 ? Math.floor(rawTime / 1000) : rawTime
      const [open, high, low, close, volume] = fields.slice(1, 6).map(Number)
      if ([openTime, open, high, low, close, volume].every(Number.isFinite)) {
        candles.push({ openTime, open, high, low, close, volume })
      }
    }
    return candles
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function loadCandles(symbol: string, start: number, end: number): Promise<Candle[]> {
  const all: Candle[] = []
  for (const month of monthKeys(new Date(start), new Date(end))) {
    const file = await download(symbol, month)
    if (file) all.push(...await unzip(file))
  }
  return all.filter(c => c.openTime >= start && c.openTime <= end).sort((a, b) => a.openTime - b.openTime)
}

function validateCandles(symbol: string, candles: Candle[], start: number, end: number) {
  const expected = Math.floor((end - start) / INTERVAL_MS) + 1
  if (candles.length !== expected) {
    throw new Error('Coverage failure ' + symbol + ': ' + candles.length + '/' + expected + ' 15m candles. Refusing partial-data research.')
  }
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.volume >= 0 &&
      c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high))) {
      throw new Error('Invalid OHLCV ' + symbol + ' at ' + new Date(c.openTime).toISOString())
    }
    if (i > 0) {
      const delta = c.openTime - candles[i - 1].openTime
      if (delta !== INTERVAL_MS) throw new Error('Gap/duplicate/irregular candle ' + symbol + ': ' + delta + 'ms at ' + new Date(c.openTime).toISOString())
    }
  }
  return { symbol, expected, actual: candles.length, gaps: 0, start: new Date(start).toISOString(), end: new Date(end).toISOString() }
}

function buildRows(symbol: string, candles: Candle[]): Row[] {
  const features = calculateFeatureSeries(candles)
  const rows: Row[] = []
  // Warm up the 200-bar EMA and require a real next-open entry and exit candle.
  for (let i = 200; i + HOLD_BARS + 1 < candles.length; i++) {
    const f = features[i]
    const scored = calculateRadarScore(f)
    const entryIndex = i + 1
    const exitIndex = entryIndex + HOLD_BARS
    const ema50 = f.ema_50
    const ema200 = f.ema_200
    const regime: Row['regime'] = ema50 !== null && ema200 !== null
      ? (ema50 > ema200 * 1.01 ? 'bull' : ema50 < ema200 * 0.99 ? 'bear' : 'sideways')
      : 'sideways'
    rows.push({
      symbol,
      time: candles[i].openTime,
      entryTime: candles[entryIndex].openTime,
      exitTime: candles[exitIndex].openTime,
      score: scored.score,
      grossReturn: candles[exitIndex].open / candles[entryIndex].open - 1,
      regime,
      atrPct: f.atr !== null && candles[i].close > 0 ? f.atr / candles[i].close : null,
    })
  }
  return rows
}

function netReturn(row: Row, costBps: number) {
  return row.grossReturn - costBps / 10_000
}

function stats(rows: Row[], costBps: number, threshold?: number): Stats {
  const chosen = rows.filter(r => threshold === undefined || r.score >= threshold)
  let wins = 0, sum = 0, profit = 0, loss = 0
  for (const row of chosen) {
    const result = netReturn(row, costBps)
    sum += result
    if (result > 0) { wins++; profit += result } else loss -= result
  }
  return {
    ...(threshold === undefined ? {} : { threshold }),
    trades: chosen.length,
    winRate: chosen.length ? wins / chosen.length : null,
    expectancy: chosen.length ? sum / chosen.length : null,
    profitFactor: loss > 0 ? profit / loss : profit > 0 ? null : 0,
    totalReturn: sum,
  }
}

function nonOverlapping(rows: Row[], costBps: number, threshold: number): Stats {
  const selected: Row[] = []
  for (const symbol of SYMBOLS) {
    const ordered = rows.filter(r => r.symbol === symbol && r.score >= threshold).sort((a, b) => a.entryTime - b.entryTime)
    let nextEntry = -Infinity
    for (const row of ordered) {
      if (row.entryTime < nextEntry) continue
      selected.push(row)
      nextEntry = row.exitTime
    }
  }
  selected.sort((a, b) => a.entryTime - b.entryTime || a.symbol.localeCompare(b.symbol))
  const result = stats(selected, costBps, threshold)
  let equity = 1, peak = 1, maxDrawdown = 0
  for (const row of selected) {
    equity *= 1 + netReturn(row, costBps)
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }
  result.maxDrawdown = maxDrawdown
  return result
}

function bySymbol(rows: Row[], threshold: number, costBps: number) {
  return SYMBOLS.map(symbol => ({
    symbol,
    overlapping: stats(rows.filter(r => r.symbol === symbol), costBps, threshold),
    nonOverlapping: nonOverlapping(rows.filter(r => r.symbol === symbol), costBps, threshold),
  }))
}

function scoreBuckets(rows: Row[], costBps: number) {
  const buckets = [
    { label: '50-59', min: 50, max: 59 },
    { label: '60-69', min: 60, max: 69 },
    { label: '70-74', min: 70, max: 74 },
    { label: '75-79', min: 75, max: 79 },
    { label: '80-84', min: 80, max: 84 },
    { label: '85-89', min: 85, max: 89 },
    { label: '90-100', min: 90, max: 100 },
  ]
  return buckets.map(bucket => {
    const sample = rows.filter(r => r.score >= bucket.min && r.score <= bucket.max)
    return { ...bucket, ...stats(sample, costBps), note: 'Overlapping signal observations; diagnostic only, not a portfolio return.' }
  })
}

function costSensitivity(rows: Row[], threshold: number) {
  return COSTS_BPS.map(costBps => ({
    roundTripCostBps: costBps,
    overlapping: stats(rows, costBps, threshold),
    nonOverlappingPerSymbol: nonOverlapping(rows, costBps, threshold),
  }))
}

function roundPct(value: number | null) {
  return value === null ? 'N/A' : (value * 100).toFixed(3) + '%'
}

async function main() {
  if (!Number.isInteger(MONTHS) || MONTHS < 15) {
    throw new Error('MONTHS must be an integer >= 15 for 12-month training and 3-month OOS folds.')
  }
  if (SYMBOLS.length === 0) throw new Error('SYMBOLS must contain at least one Binance spot symbol.')
  const now = new Date()
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = currentMonth.getTime() - INTERVAL_MS
  const startDate = addMonths(currentMonth, -MONTHS)
  const start = startDate.getTime()
  const allRows: Row[] = []
  const coverage: ReturnType<typeof validateCandles>[] = []

  for (const symbol of SYMBOLS) {
    console.log('[production-walkforward] loading ' + symbol + ' 15m candles')
    const candles = await loadCandles(symbol, start, end)
    coverage.push(validateCandles(symbol, candles, start, end))
    const rows = buildRows(symbol, candles)
    allRows.push(...rows)
    console.log('[production-walkforward] ' + symbol + ': candles=' + candles.length + ' scored=' + rows.length)
  }

  const folds = buildFolds(startDate, MONTHS)
  if (folds.length === 0) throw new Error('No folds could be built.')
  const foldResults: any[] = []
  for (const fold of folds) {
    // Training outcomes must exit before the OOS window begins. This purges leakage at the split.
    const train = allRows.filter(r => r.time >= fold.trainStart && r.exitTime < fold.testStart)
    const test = allRows.filter(r => r.time >= fold.testStart && r.time < fold.testEnd && r.exitTime < fold.testEnd)
    const candidates = THRESHOLDS.map(threshold => ({
      threshold,
      metrics: nonOverlapping(train, PRIMARY_COST_BPS, threshold),
    })).filter(candidate => candidate.metrics.trades >= MIN_TRAIN_TRADES)
      .sort((a, b) => (b.metrics.expectancy ?? -Infinity) - (a.metrics.expectancy ?? -Infinity))
    const selectedThreshold = candidates[0]?.threshold ?? 75
    const selected = nonOverlapping(test, PRIMARY_COST_BPS, selectedThreshold)
    const fixed75 = nonOverlapping(test, PRIMARY_COST_BPS, 75)
    const foldResult = {
      fold: fold.label,
      train: new Date(fold.trainStart).toISOString() + '..' + new Date(fold.testStart).toISOString(),
      test: new Date(fold.testStart).toISOString() + '..' + new Date(fold.testEnd).toISOString(),
      selectedThreshold,
      trainCandidates: candidates,
      oosSelectedNonOverlappingPerSymbol: selected,
      oosProductionSetupLong75: fixed75,
      oosOverlappingAtSelectedThreshold: stats(test, PRIMARY_COST_BPS, selectedThreshold),
      oosBySymbolAtSelectedThreshold: bySymbol(test, selectedThreshold, PRIMARY_COST_BPS),
      costSensitivityAtSelectedThreshold: costSensitivity(test, selectedThreshold),
      scoreCalibration: scoreBuckets(test, PRIMARY_COST_BPS),
      regimeAt75: ['bull', 'sideways', 'bear'].map(regime => ({
        regime,
        ...nonOverlapping(test.filter(r => r.regime === regime), PRIMARY_COST_BPS, 75),
      })),
    }
    foldResults.push(foldResult)
    console.log('[production-walkforward] fold=' + fold.label +
      ' selected=' + selectedThreshold +
      ' OOS selected exp=' + roundPct(selected.expectancy) +
      ' trades=' + selected.trades +
      ' fixed75 exp=' + roundPct(fixed75.expectancy) +
      ' fixed75 trades=' + fixed75.trades)
  }

  const selectedOos = foldResults.map(f => f.oosSelectedNonOverlappingPerSymbol as Stats)
  const fixedOos = foldResults.map(f => f.oosProductionSetupLong75 as Stats)
  const positiveSelectedFolds = selectedOos.filter(s => (s.expectancy ?? -Infinity) > 0).length
  const positiveFixedFolds = fixedOos.filter(s => (s.expectancy ?? -Infinity) > 0).length
  const positiveFixedAt25BpsFolds = foldResults.filter(f => (f.costSensitivityAtSelectedThreshold.find((x: any) => x.roundTripCostBps === 25)?.nonOverlappingPerSymbol.expectancy ?? -Infinity) > 0 && f.selectedThreshold === 75).length
  const enoughOosSamples = fixedOos.every(s => s.trades >= 30)
  const report = {
    reportName: 'radar-crypto-production-score-walkforward-15m',
    generatedAt: new Date().toISOString(),
    qualification: {
      status: positiveFixedFolds >= Math.ceil(foldResults.length * 0.75) && positiveFixedAt25BpsFolds >= Math.ceil(foldResults.length * 0.5) && enoughOosSamples ? 'candidate_for_further_validation' : 'not_qualified',
      note: 'This is a research gate, not proof of profitability. Qualification is based on the unchanged production SETUP LONG threshold of 75, not the train-selected threshold.',
      fixed75PositiveOosFolds: positiveFixedFolds,
      fixed75PositiveAt25BpsFolds: positiveFixedAt25BpsFolds,
      everyFoldHasAtLeast30OosTrades: enoughOosSamples,
      totalOosFolds: foldResults.length,
    },
    methodology: {
      researchOnly: true,
      productionFeaturesAndScoringImportedForScoring: true,
      productionFilesModified: false,
      timeframe: '15m Binance spot klines',
      signal: 'calculateRadarScore(calculateFeatures(candles through signal candle))',
      entry: 'next candle open, after signal candle has closed',
      exit: 'open 16 x 15m bars after entry; 4-hour holding period',
      costs: '15/20/25 bps round-trip sensitivity; 15 bps primary proxy (assumption, not exchange-specific fee quote)',
      thresholdSelection: 'training-only non-overlapping per-symbol net expectancy, minimum 100 training trades; OOS threshold is diagnostic only and cannot qualify production',
      overlapPolicy: 'primary event metric enforces no overlapping positions per symbol; different symbols can overlap, so aggregate statistics are signal-quality diagnostics, not a capital-constrained portfolio backtest',
      purge: 'training trades must exit before OOS starts; OOS trades must exit before OOS ends',
      calibration: 'score buckets are overlapping event diagnostics; do not treat as portfolio returns',
      folds: 'rolling 12-month training window and 3-month OOS windows, stepped by 3 months',
    },
    configuration: { symbols: SYMBOLS, months: MONTHS, thresholds: THRESHOLDS, primaryCostBps: PRIMARY_COST_BPS, costSensitivityBps: COSTS_BPS },
    coverage,
    summary: {
      fixed75PositiveOosFolds: positiveFixedFolds,
      fixed75PositiveAt25BpsFolds: positiveFixedAt25BpsFolds,
      selectedThresholdPositiveOosFolds: positiveSelectedFolds,
      totalOosFolds: foldResults.length,
      fixed75Oos: foldResults.map(f => ({ fold: f.fold, ...f.oosProductionSetupLong75 })),
    },
    folds: foldResults,
  }

  await fs.mkdir(REPORT_DIR, { recursive: true })
  const reportPath = path.join(REPORT_DIR, 'backtest-production-score-walkforward-15m.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log('[production-walkforward] report=' + reportPath)
  console.log('[production-walkforward] unchanged production threshold positive OOS folds=' + positiveFixedFolds + '/' + foldResults.length)
  if (report.qualification.status !== 'candidate_for_further_validation') {
    console.error('[production-walkforward] QUALIFICATION FAILED: ' + report.qualification.status)
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error('[production-walkforward] Error:', error)
  process.exitCode = 1
})
