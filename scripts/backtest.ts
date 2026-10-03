import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { calculateFeatures, type Candle } from '../lib/features'
import { calculateRadarScore } from '../lib/scoring'

const exec = promisify(execFile)

type HorizonName = '15m' | '1h' | '4h'

type SignalRecord = {
  symbol: string
  signalTimestamp: string
  entryTime: string
  entryPrice: number
  score: number
  status: string
  regime: string
  returnByHorizon: Record<HorizonName, number | null>
  returnByHorizonGross: Record<HorizonName, number | null>
  outcomeByHorizon: Record<HorizonName, 'WIN' | 'LOSS' | 'TIMEOUT' | null>
  mae: Record<HorizonName, number | null>
  mfe: Record<HorizonName, number | null>
  trainValidationTest: 'TRAIN' | 'VALIDATION' | 'TEST'
  monthKey: string
  quarterKey: string
}

type SummaryMetrics = {
  signals: number
  wins: number
  losses: number
  timeouts: number
  win_rate: number | null
  loss_rate: number | null
  timeout_rate: number | null
  average_return: number | null
  median_return: number | null
  standard_deviation_return: number | null
  expectancy: number | null
  profit_factor: number | null
  cumulative_return: number | null
  max_drawdown: number | null
  sharpe: number | null
  mae: number | null
  mfe: number | null
}

type ScoreBucketRow = {
  score_bucket: string
  number_of_signals: number
  win_rate: number | null
  average_return: number | null
  median_return: number | null
  profit_factor: number | null
  mae: number | null
  mfe: number | null
}

type PeriodRow = {
  period: string
  signals: number
  win_rate: number | null
  average_return: number | null
  cumulative_return: number | null
  drawdown: number | null
}

const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(s => s.trim()).filter(Boolean)
const INTERVAL = '15m'
const MODEL_VERSION = 'v1.1-live'
const HORIZONS: HorizonName[] = ['15m', '1h', '4h']
const FEE_BPS = 10
const SLIPPAGE_BPS = 5
const FEE_RATE = FEE_BPS / 10000
const SLIPPAGE_RATE = SLIPPAGE_BPS / 10000
const DATA_DIR = path.join(process.cwd(), '.backtest-cache')
const REPORT_DIR = path.join(process.cwd(), 'reports')
const TARGET_MONTHS = 36

function monthKeys(start: Date, end: Date): string[] {
  const output: string[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const finish = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cursor <= finish) {
    output.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return output
}

function nowMinusMonths(months: number): Date {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - months)
  return d
}

function startOfMonthUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0))
}

function dateToMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthKeyToQuarter(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  const q = Math.floor((month - 1) / 3) + 1
  return `${year}-Q${q}`
}

async function downloadMonth(symbol: string, monthKey: string): Promise<string> {
  const file = path.join(DATA_DIR, `${symbol}-${INTERVAL}-${monthKey}.zip`)
  try {
    await fs.access(file)
    return file
  } catch {}

  const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/${INTERVAL}/${symbol}-${INTERVAL}-${monthKey}.zip`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance archive ${res.status}: ${url}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(file, bytes)
  return file
}

async function unzipCsv(zipFile: string): Promise<Candle[]> {
  const tempDir = path.join(DATA_DIR, `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tempDir, { recursive: true })
  await exec('unzip', ['-oq', zipFile, '-d', tempDir])
  const files = (await fs.readdir(tempDir)).filter(f => f.endsWith('.csv'))
  if (!files.length) throw new Error(`No CSV inside ${zipFile}`)
  const csv = await fs.readFile(path.join(tempDir, files[0]), 'utf8')
  const lines = csv.trim().split(/\r?\n/)
  const startIndex = lines[0]?.toLowerCase().includes('open time') ? 1 : 0
  const candles: Candle[] = []

  for (let i = startIndex; i < lines.length; i++) {
    const row = lines[i].split(',')
    if (row.length < 6) continue
    const [openTimeRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = row
    const openTime = Number(openTimeRaw)
    const open = Number(openRaw)
    const high = Number(highRaw)
    const low = Number(lowRaw)
    const close = Number(closeRaw)
    const volume = Number(volumeRaw)
    if ([openTime, open, high, low, close, volume].every(Number.isFinite)) {
      candles.push({ openTime, open, high, low, close, volume })
    }
  }

  await fs.rm(tempDir, { recursive: true, force: true })
  return candles
}

async function loadSymbol(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const months = monthKeys(new Date(startMs), new Date(endMs))
  const candles: Candle[] = []
  for (const monthKey of months) {
    const zipFile = await downloadMonth(symbol, monthKey)
    const monthCandles = await unzipCsv(zipFile)
    candles.push(...monthCandles)
  }

  return candles
    .filter(c => c.openTime >= startMs && c.openTime <= endMs)
    .sort((a, b) => a.openTime - b.openTime)
}

function applyFee(ret: number, feeBps = FEE_BPS, slippageBps = SLIPPAGE_BPS) {
  const cost = (feeBps + slippageBps) / 10000
  return ret - cost
}

function calcMedian(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

function calcStd(values: number[]): number | null {
  if (!values.length) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0, ) / values.length
  return Math.sqrt(variance)
}

function calcSharpe(values: number[]): number | null {
  if (!values.length) return null
  const std = calcStd(values)
  if (!Number.isFinite(std) || std === 0) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return (mean / std) * Math.sqrt(values.length)
}

function calcProfitFactor(values: number[]): number | null {
  const positives = values.filter(v => v > 0)
  const negatives = values.filter(v => v < 0)
  const posSum = positives.reduce((a, b) => a + b, 0)
  const negAbs = negatives.reduce((a, b) => a + Math.abs(b), 0)
  if (negAbs === 0) return null
  return posSum / negAbs
}

function calcExpectancy(values: number[]): number | null {
  if (!values.length) return null
  const wins = values.filter(v => v > 0)
  const losses = values.filter(v => v < 0)
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
  const winRate = wins.length / values.length
  const lossRate = losses.length / values.length
  return winRate * avgWin + lossRate * avgLoss
}

function cumulativeReturn(values: number[]): number | null {
  if (!values.length) return null
  let running = 1
  for (const v of values) running *= 1 + v
  return running - 1
}

function maxDrawdown(values: number[]): number | null {
  if (!values.length) return null
  let peak = 1
  let maxDd = 0
  let running = 1
  for (const v of values) {
    running *= 1 + v
    if (running > peak) peak = running
    const dd = (running - peak) / peak
    if (dd < maxDd) maxDd = dd
  }
  return Math.abs(maxDd)
}

function trailingReturnFromPrices(entryPrice: number, targetPrice: number | null): number | null {
  if (targetPrice === null || !Number.isFinite(entryPrice) || !Number.isFinite(targetPrice) || entryPrice <= 0 || targetPrice <= 0) return null
  return (targetPrice - entryPrice) / entryPrice
}

function getSignalCategory(ret: number | null): 'WIN' | 'LOSS' | 'TIMEOUT' | null {
  if (ret === null || !Number.isFinite(ret)) return null
  if (ret > 0) return 'WIN'
  if (ret < 0) return 'LOSS'
  return 'TIMEOUT'
}

function computeStatsByValues(values: number[]): SummaryMetrics {
  const wins = values.filter(v => v > 0)
  const losses = values.filter(v => v < 0)
  const timeouts = values.filter(v => v === 0)
  const averageReturn = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  const medianReturn = calcMedian(values)
  const std = calcStd(values)
  const winRate = values.length ? wins.length / values.length : null
  const lossRate = values.length ? losses.length / values.length : null
  const timeoutRate = values.length ? timeouts.length / values.length : null
  return {
    signals: values.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    win_rate: winRate,
    loss_rate: lossRate,
    timeout_rate: timeoutRate,
    average_return: averageReturn,
    median_return: medianReturn,
    standard_deviation_return: std,
    expectancy: calcExpectancy(values),
    profit_factor: calcProfitFactor(values),
    cumulative_return: cumulativeReturn(values),
    max_drawdown: maxDrawdown(values),
    sharpe: calcSharpe(values),
    mae: values.length ? Math.max(0, ...values.map(v => v < 0 ? Math.abs(v) : 0)) : null,
    mfe: values.length ? Math.max(0, ...values.map(v => v > 0 ? v : 0)) : null,
  }
}

function toCsvRow(obj: Record<string, string | number | null | undefined>) {
  return Object.values(obj).map(v => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')
}

function buildSummary(signalRecords: SignalRecord[], horizon: HorizonName, scenarioLabel: 'RAW' | 'FEE' | 'FEE_SLIPPAGE'): SummaryMetrics {
  const values = signalRecords
    .map(r => (scenarioLabel === 'RAW'
      ? r.returnByHorizon[horizon]
      : scenarioLabel === 'FEE'
        ? (r.returnByHorizon[horizon] === null ? null : applyFee(r.returnByHorizon[horizon]!, FEE_BPS, 0))
        : (r.returnByHorizon[horizon] === null ? null : applyFee(r.returnByHorizon[horizon]!, FEE_BPS, SLIPPAGE_BPS))))
    .filter((v): v is number => Number.isFinite(v))

  const metrics = computeStatsByValues(values)
  return metrics
}

function buildSymbolSummary(signalRecords: SignalRecord[], symbol: string, horizon: HorizonName, scenarioLabel: 'RAW' | 'FEE' | 'FEE_SLIPPAGE') {
  const subset = signalRecords.filter(r => r.symbol === symbol)
  return buildSummary(subset, horizon, scenarioLabel)
}

function buildBucketRows(signalRecords: SignalRecord[], scenarioLabel: 'RAW' | 'FEE' | 'FEE_SLIPPAGE') {
  const scoreBuckets = ['50-54', '55-59', '60-64', '65-69', '70-74', '75-79', '80-84', '85-89', '90-94', '95-100']
  const rows: ScoreBucketRow[] = []
  for (const bucket of scoreBuckets) {
    const [low, high] = bucket.split('-').map(Number)
    const subset = signalRecords.filter(r => {
      const score = r.score
      return score >= low && score <= high
    })
    const values = subset
      .map(r => {
        const ret = scenarioLabel === 'RAW'
          ? r.returnByHorizon['15m']
          : scenarioLabel === 'FEE'
            ? (r.returnByHorizon['15m'] === null ? null : applyFee(r.returnByHorizon['15m']!, FEE_BPS, 0))
            : (r.returnByHorizon['15m'] === null ? null : applyFee(r.returnByHorizon['15m']!, FEE_BPS, SLIPPAGE_BPS))
        return ret
      })
      .filter((v): v is number => Number.isFinite(v))

    rows.push({
      score_bucket: bucket,
      number_of_signals: subset.length,
      win_rate: values.length ? values.filter(v => v > 0).length / values.length : null,
      average_return: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      median_return: calcMedian(values),
      profit_factor: calcProfitFactor(values),
      mae: values.filter(v => v < 0).length ? Math.abs(Math.min(...values.filter(v => v < 0))) : null,
      mfe: values.filter(v => v > 0).length ? Math.max(...values.filter(v => v > 0)) : null,
    })
  }
  return rows
}

function buildPeriodRows(signalRecords: SignalRecord[], scenarioLabel: 'RAW' | 'FEE' | 'FEE_SLIPPAGE') {
  const months = new Map<string, SignalRecord[]>()
  for (const row of signalRecords) {
    const monthKey = row.monthKey
    const list = months.get(monthKey) ?? []
    list.push(row)
    months.set(monthKey, list)
  }

  const rows: PeriodRow[] = []
  for (const [monthKey, subset] of Array.from(months.entries()).sort()) {
    const values = subset
      .map(r => {
        const ret = scenarioLabel === 'RAW'
          ? r.returnByHorizon['15m']
          : scenarioLabel === 'FEE'
            ? (r.returnByHorizon['15m'] === null ? null : applyFee(r.returnByHorizon['15m']!, FEE_BPS, 0))
            : (r.returnByHorizon['15m'] === null ? null : applyFee(r.returnByHorizon['15m']!, FEE_BPS, SLIPPAGE_BPS))
        return ret
      })
      .filter((v): v is number => Number.isFinite(v))

    rows.push({
      period: monthKey,
      signals: subset.length,
      win_rate: values.length ? values.filter(v => v > 0).length / values.length : null,
      average_return: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      cumulative_return: cumulativeReturn(values),
      drawdown: maxDrawdown(values),
    })
  }
  return rows
}

function allPairs<T extends Record<string, any>>(input: T[], key: keyof T) {
  return input
}

async function main() {
  const start = nowMinusMonths(TARGET_MONTHS)
  const end = new Date()
  const startMs = start.getTime()
  const endMs = end.getTime()

  const symbolData = new Map<string, Candle[]>()
  const dataMeta = {
    DATA_START: start.toISOString(),
    DATA_END: end.toISOString(),
    TOTAL_CANDLES: 0,
    MISSING_DATA: 0,
    SYMBOLS_PROCESSED: SYMBOLS,
    MODEL_VERSION,
  }

  for (const symbol of SYMBOLS) {
    const candles = await loadSymbol(symbol, startMs, endMs)
    symbolData.set(symbol, candles)
    dataMeta.TOTAL_CANDLES += candles.length
  }

  const allSignals: SignalRecord[] = []
  const signalRecordsBySymbol = new Map<string, SignalRecord[]>()

  const trainEnd = new Date(start.getTime() + (end.getTime() - start.getTime()) * 0.6)
  const validationEnd = new Date(start.getTime() + (end.getTime() - start.getTime()) * 0.8)

  for (const symbol of SYMBOLS) {
    const candles = symbolData.get(symbol) ?? []
    if (!candles.length) continue
    for (let i = 200; i < candles.length - 16; i++) {
      const candle = candles[i]
      const historical = candles.slice(0, i + 1)
      if (historical.length < 200) continue
      const features = calculateFeatures(historical)
      const { score, status } = calculateRadarScore(features)
      if (status !== 'SETUP LONG') continue

      const signalTimestamp = new Date(candle.openTime + 15 * 60 * 1000).toISOString()
      const entryPrice = candle.close
      const entryTime = new Date(candle.openTime).toISOString()
      const asOf = new Date(signalTimestamp)
      const horizonReturns: Record<HorizonName, number | null> = { '15m': null, '1h': null, '4h': null }
      const outcomeByHorizon: Record<HorizonName, 'WIN' | 'LOSS' | 'TIMEOUT' | null> = { '15m': null, '1h': null, '4h': null }
      const mae: Record<HorizonName, number | null> = { '15m': null, '1h': null, '4h': null }
      const mfe: Record<HorizonName, number | null> = { '15m': null, '1h': null, '4h': null }

      const targetIdxs: Record<HorizonName, number | null> = {
        '15m': i + 1,
        '1h': i + 4,
        '4h': i + 16,
      }

      for (const horizon of HORIZONS) {
        const targetIndex = targetIdxs[horizon]
        if (targetIndex === null || targetIndex >= candles.length) {
          horizonReturns[horizon] = null
          outcomeByHorizon[horizon] = null
          continue
        }

        const targetCandle = candles[targetIndex]
        if (!targetCandle || !Number.isFinite(targetCandle.close)) {
          horizonReturns[horizon] = null
          outcomeByHorizon[horizon] = null
          continue
        }

        const ret = trailingReturnFromPrices(entryPrice, targetCandle.close)
        const path = candles.slice(i + 1, targetIndex + 1)
        const lowReturns = path.map(c => (c.low - entryPrice) / entryPrice)
        const highReturns = path.map(c => (c.high - entryPrice) / entryPrice)
        const adverseExc = lowReturns.length ? Math.min(...lowReturns) : null
        const favorableExc = highReturns.length ? Math.max(...highReturns) : null
        horizonReturns[horizon] = ret
        outcomeByHorizon[horizon] = getSignalCategory(ret)
        mae[horizon] = adverseExc === null ? null : Math.abs(adverseExc)
        mfe[horizon] = favorableExc === null ? null : favorableExc
      }

      const split: 'TRAIN' | 'VALIDATION' | 'TEST' = asOf < trainEnd ? 'TRAIN' : asOf < validationEnd ? 'VALIDATION' : 'TEST'
      const record: SignalRecord = {
        symbol,
        signalTimestamp,
        entryTime,
        entryPrice,
        score,
        status,
        regime: status,
        returnByHorizon: horizonReturns,
        returnByHorizonGross: horizonReturns,
        outcomeByHorizon,
        mae,
        mfe,
        trainValidationTest: split,
        monthKey: dateToMonthKey(new Date(signalTimestamp)),
        quarterKey: monthKeyToQuarter(dateToMonthKey(new Date(signalTimestamp))),
      }

      allSignals.push(record)
      const list = signalRecordsBySymbol.get(symbol) ?? []
      list.push(record)
      signalRecordsBySymbol.set(symbol, list)
    }
  }

  const summaryByScenario = {
    RAW: buildSummary(allSignals, '15m', 'RAW'),
    FEE: buildSummary(allSignals, '15m', 'FEE'),
    FEE_SLIPPAGE: buildSummary(allSignals, '15m', 'FEE_SLIPPAGE'),
  }

  const aggregateBySymbol = SYMBOLS.map(symbol => ({
    symbol,
    signals: signalRecordsBySymbol.get(symbol)?.length ?? 0,
    raw: buildSummary(signalRecordsBySymbol.get(symbol) ?? [], '15m', 'RAW'),
    fees: buildSummary(signalRecordsBySymbol.get(symbol) ?? [], '15m', 'FEE'),
    fees_slippage: buildSummary(signalRecordsBySymbol.get(symbol) ?? [], '15m', 'FEE_SLIPPAGE'),
  }))

  const horizonSummary = SYMBOLS.flatMap(symbol => {
    const rows = [] as Array<{ symbol: string; horizon: HorizonName; summary: SummaryMetrics }>
    for (const horizon of HORIZONS) {
      rows.push({ symbol, horizon, summary: buildSummary(signalRecordsBySymbol.get(symbol) ?? [], horizon, 'RAW') })
    }
    return rows
  })

  const scoreRows = buildBucketRows(allSignals, 'RAW')
  const periodRows = buildPeriodRows(allSignals, 'RAW')

  const monthlyRows = Array.from(new Map(
    Array.from(new Set(allSignals.map(r => r.monthKey)))
      .map(monthKey => {
        const subset = allSignals.filter(r => r.monthKey === monthKey)
        const values = subset.map(r => r.returnByHorizon['15m']).filter((v): v is number => Number.isFinite(v))
        return [monthKey, {
          period: monthKey,
          signals: subset.length,
          win_rate: values.length ? values.filter(v => v > 0).length / values.length : null,
          average_return: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
          cumulative_return: cumulativeReturn(values),
          drawdown: maxDrawdown(values),
        }] as const
      })
  ).values())

  const quarterlyRows = Array.from(new Map(
    Array.from(new Set(allSignals.map(r => r.quarterKey)))
      .map(quarterKey => {
        const subset = allSignals.filter(r => r.quarterKey === quarterKey)
        const values = subset.map(r => r.returnByHorizon['15m']).filter((v): v is number => Number.isFinite(v))
        return [quarterKey, {
          period: quarterKey,
          signals: subset.length,
          win_rate: values.length ? values.filter(v => v > 0).length / values.length : null,
          average_return: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
          cumulative_return: cumulativeReturn(values),
          drawdown: maxDrawdown(values),
        }] as const
      })
  ).values())

  const bySplit = [
    { name: 'TRAIN', records: allSignals.filter(r => r.trainValidationTest === 'TRAIN') },
    { name: 'VALIDATION', records: allSignals.filter(r => r.trainValidationTest === 'VALIDATION') },
    { name: 'TEST', records: allSignals.filter(r => r.trainValidationTest === 'TEST') },
  ].map(x => ({
    name: x.name,
    from: x.records[0]?.signalTimestamp ?? null,
    to: x.records[x.records.length - 1]?.signalTimestamp ?? null,
    signals: x.records.length,
    summary: buildSummary(x.records, '15m', 'RAW'),
  }))

  const allReturns = allSignals.map(r => r.returnByHorizon['15m']).filter((v): v is number => Number.isFinite(v))
  const percentiles = [5, 10, 25, 50, 75, 90, 95].map(p => {
    const sorted = [...allReturns].sort((a, b) => a - b)
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return { percentile: p, value: sorted[Math.max(0, Math.min(sorted.length - 1, idx))] }
  })

  const top10 = [...allSignals]
    .map(r => ({ signal: r, ret: r.returnByHorizon['15m'] }))
    .filter((r): r is { signal: SignalRecord; ret: number } => Number.isFinite(r.ret))
    .sort((a, b) => (b.ret ?? 0) - (a.ret ?? 0))
    .slice(0, 10)
    .map(r => ({ symbol: r.signal.symbol, score: r.signal.score, signal_timestamp: r.signal.signalTimestamp, return_15m: r.ret }))

  const worst10 = [...allSignals]
    .map(r => ({ signal: r, ret: r.returnByHorizon['15m'] }))
    .filter((r): r is { signal: SignalRecord; ret: number } => Number.isFinite(r.ret))
    .sort((a, b) => (a.ret ?? 0) - (b.ret ?? 0))
    .slice(0, 10)
    .map(r => ({ symbol: r.signal.symbol, score: r.signal.score, signal_timestamp: r.signal.signalTimestamp, return_15m: r.ret }))

  const statusSummary = Object.entries({
    'SETUP LONG': allSignals.filter(r => r.status === 'SETUP LONG'),
    VIGILAR: allSignals.filter(r => r.status === 'VIGILAR'),
    NEUTRAL: allSignals.filter(r => r.status === 'NEUTRAL'),
    EVITAR: allSignals.filter(r => r.status === 'EVITAR'),
  }).map(([regime, rows]) => ({
    regime,
    signals: rows.length,
    win_rate: rows.length ? rows.filter(r => (r.returnByHorizon['15m'] ?? 0) > 0).length / rows.length : null,
    avg_return: rows.length ? rows.reduce((acc, r) => acc + (r.returnByHorizon['15m'] ?? 0), 0) / rows.length : null,
    expectancy: rows.length ? calcExpectancy(rows.map(r => r.returnByHorizon['15m'] ?? 0).filter(Number.isFinite)) : null,
    profit_factor: rows.length ? calcProfitFactor(rows.map(r => r.returnByHorizon['15m'] ?? 0).filter(Number.isFinite)) : null,
  }))

  const report = {
    report_name: 'radar-crypto-backtest-baseline',
    model_version: MODEL_VERSION,
    generated_at: new Date().toISOString(),
    commit_sha: (await (async () => {
      try {
        const { stdout } = await exec('git', ['rev-parse', 'HEAD'])
        return stdout.trim()
      } catch {
        return null
      }
    })()),
    data: {
      start: start.toISOString(),
      end: end.toISOString(),
      total_candles: dataMeta.TOTAL_CANDLES,
      missing_data: dataMeta.MISSING_DATA,
      symbols_processed: SYMBOLS,
      interval: INTERVAL,
      timeframes: HORIZONS,
      total_months: TARGET_MONTHS,
    },
    methodology: {
      no_lookahead: true,
      signal_generation: 'Features computed using only closed candles up to the current candle; score and status are produced before using any future returns.',
      entry_price: 'Current candle close on the same 15m bar that triggered the SETUP LONG status.',
      outcome_horizons: HORIZONS,
      train_validation_test: {
        train: { from: start.toISOString(), to: trainEnd.toISOString() },
        validation: { from: trainEnd.toISOString(), to: validationEnd.toISOString() },
        test: { from: validationEnd.toISOString(), to: end.toISOString() },
      },
      fee_assumption: 'Scenario B uses 10 bps fee cost. Scenario C adds 5 bps slippage conservatively. Not derived from exchange-specific historical fills.',
      slippage_assumption: '5 bps conservative slippage applied in addition to the execution fee for Scenario C.',
      timestamp_issues: [
        'The production model uses close-based entry price and future close comparison for outcome measurement. The exact signal timestamp is the close timestamp of the bar that generated SETUP LONG; outcome is measured from the first available future close at the selected horizon.',
      ],
      model_issues_found: [
        'calculateFeatures() hardcodes return_5m to null, so the 5m feature is absent even though the FeatureSet type exposes it.',
        'The production route uses a status value as regime but does not define a separate, formal regime feature. The status is effectively a regime-like signal, not a true market regime classifier.',
        'There is no 30m horizon in production; the existing model uses 15m, 1h, and 4h only.',
      ],
    },
    costs: {
      scenario_a: { description: 'No fees, no slippage', fee_bps: 0, slippage_bps: 0 },
      scenario_b: { description: 'Realistic execution fees only', fee_bps: FEE_BPS, slippage_bps: 0 },
      scenario_c: { description: 'Fees plus conservative slippage', fee_bps: FEE_BPS, slippage_bps: SLIPPAGE_BPS },
    },
    summary: {
      raw: summaryByScenario.RAW,
      fees: summaryByScenario.FEE,
      fees_slippage: summaryByScenario.FEE_SLIPPAGE,
    },
    by_symbol: SYMBOLS.map(symbol => ({
      symbol,
      signals: signalRecordsBySymbol.get(symbol)?.length ?? 0,
      raw: buildSummary(signalRecordsBySymbol.get(symbol) ?? [], '15m', 'RAW'),
      fees: buildSummary(signalRecordsBySymbol.get(symbol) ?? [], '15m', 'FEE'),
      fees_slippage: buildSummary(signalRecordsBySymbol.get(symbol) ?? [], '15m', 'FEE_SLIPPAGE'),
    })),
    by_horizon: horizonSummary.map(h => ({
      symbol: h.symbol,
      horizon: h.horizon,
      signals: signalRecordsBySymbol.get(h.symbol)?.length ?? 0,
      summary: h.summary,
    })),
    by_score_bucket: scoreRows,
    by_period: {
      monthly: monthlyRows,
      quarterly: quarterlyRows,
    },
    regime_analysis: statusSummary,
    signal_distribution: {
      percentiles: percentiles,
      best_10: top10,
      worst_10: worst10,
    },
    by_split,
    issues: {
      MODEL_ISSUES_FOUND: [
        'calculateFeatures() hardcodes return_5m to null, so the 5m feature is absent even though the FeatureSet type exposes it.',
        'The production route uses a status value as regime but does not define a separate, formal regime feature. The status is effectively a regime-like signal, not a true market regime classifier.',
        'There is no 30m horizon in production; the existing model uses 15m, 1h, and 4h only.',
      ],
      TIMESTAMP_ISSUES: [
        'The signal timestamp is the close timestamp of the candle used to generate the signal; outcome is compared using the first future close after the selected horizon, which can create a slight mismatch between signal creation time and exact horizon expiration time.',
      ],
    },
  }

  await fs.mkdir(REPORT_DIR, { recursive: true })

  const summaryCsv = [
    ['metric', 'raw', 'fees', 'fees_slippage'],
    ['signals', summaryByScenario.RAW.signals, summaryByScenario.FEE.signals, summaryByScenario.FEE_SLIPPAGE.signals],
    ['win_rate', summaryByScenario.RAW.win_rate ?? '', summaryByScenario.FEE.win_rate ?? '', summaryByScenario.FEE_SLIPPAGE.win_rate ?? ''],
    ['average_return', summaryByScenario.RAW.average_return ?? '', summaryByScenario.FEE.average_return ?? '', summaryByScenario.FEE_SLIPPAGE.average_return ?? ''],
    ['median_return', summaryByScenario.RAW.median_return ?? '', summaryByScenario.FEE.median_return ?? '', summaryByScenario.FEE_SLIPPAGE.median_return ?? ''],
    ['expectancy', summaryByScenario.RAW.expectancy ?? '', summaryByScenario.FEE.expectancy ?? '', summaryByScenario.FEE_SLIPPAGE.expectancy ?? ''],
    ['profit_factor', summaryByScenario.RAW.profit_factor ?? '', summaryByScenario.FEE.profit_factor ?? '', summaryByScenario.FEE_SLIPPAGE.profit_factor ?? ''],
    ['max_drawdown', summaryByScenario.RAW.max_drawdown ?? '', summaryByScenario.FEE.max_drawdown ?? '', summaryByScenario.FEE_SLIPPAGE.max_drawdown ?? ''],
    ['sharpe', summaryByScenario.RAW.sharpe ?? '', summaryByScenario.FEE.sharpe ?? '', summaryByScenario.FEE_SLIPPAGE.sharpe ?? ''],
  ].map(toCsvRow).join('\n') + '\n'

  const bySymbolCsv = [
    ['symbol', 'signals', 'win_rate', 'average_return', 'median_return', 'expectancy', 'profit_factor', 'max_drawdown', 'sharpe', 'mae', 'mfe'],
    ...aggregateBySymbol.map(r => [
      r.symbol,
      r.signals,
      r.raw.win_rate ?? '',
      r.raw.average_return ?? '',
      r.raw.median_return ?? '',
      r.raw.expectancy ?? '',
      r.raw.profit_factor ?? '',
      r.raw.max_drawdown ?? '',
      r.raw.sharpe ?? '',
      r.raw.mae ?? '',
      r.raw.mfe ?? '',
    ]),
  ].map(toCsvRow).join('\n') + '\n'

  const byHorizonCsv = [
    ['symbol', 'horizon', 'signals', 'win_rate', 'average_return', 'median_return', 'expectancy', 'profit_factor', 'max_drawdown', 'sharpe'],
    ...horizonSummary.map(h => [
      h.symbol,
      h.horizon,
      h.summary.signals,
      h.summary.win_rate ?? '',
      h.summary.average_return ?? '',
      h.summary.median_return ?? '',
      h.summary.expectancy ?? '',
      h.summary.profit_factor ?? '',
      h.summary.max_drawdown ?? '',
      h.summary.sharpe ?? '',
    ]),
  ].map(toCsvRow).join('\n') + '\n'

  const byScoreCsv = [
    ['score_bucket', 'number_of_signals', 'win_rate', 'average_return', 'median_return', 'profit_factor', 'mae', 'mfe'],
    ...scoreRows.map(r => [r.score_bucket, r.number_of_signals, r.win_rate ?? '', r.average_return ?? '', r.median_return ?? '', r.profit_factor ?? '', r.mae ?? '', r.mfe ?? '']),
  ].map(toCsvRow).join('\n') + '\n'

  const byPeriodCsv = [
    ['period', 'signals', 'win_rate', 'average_return', 'cumulative_return', 'drawdown'],
    ...periodRows.map(r => [r.period, r.signals, r.win_rate ?? '', r.average_return ?? '', r.cumulative_return ?? '', r.drawdown ?? '']),
  ].map(toCsvRow).join('\n') + '\n'

  await fs.writeFile(path.join(REPORT_DIR, 'backtest-summary.csv'), summaryCsv)
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-symbol.csv'), bySymbolCsv)
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-horizon.csv'), byHorizonCsv)
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-score.csv'), byScoreCsv)
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-period.csv'), byPeriodCsv)

  const baselineJson = path.join(REPORT_DIR, 'backtest-baseline.json')
  await fs.writeFile(baselineJson, JSON.stringify(report, null, 2) + '\n')

  const toDateStamp = new Date().toISOString().slice(0, 10)
  await fs.writeFile(path.join(REPORT_DIR, `backtest-baseline-${toDateStamp}.json`), JSON.stringify(report, null, 2) + '\n')

  console.log(JSON.stringify({
    data_start: dataMeta.DATA_START,
    data_end: dataMeta.DATA_END,
    total_candles: dataMeta.TOTAL_CANDLES,
    symbols_processed: SYMBOLS,
    total_signals: allSignals.length,
    first_signal: allSignals[0]?.signalTimestamp ?? null,
    last_signal: allSignals[allSignals.length - 1]?.signalTimestamp ?? null,
    summary: summaryByScenario.RAW,
    report_dir: REPORT_DIR,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
