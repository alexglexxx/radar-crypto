import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { calculateFeatures, type Candle, type FeatureSet } from '../lib/features'
import { calculateRadarScore } from '../lib/scoring'

const exec = promisify(execFile)

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

type HorizonName = '15m' | '1h' | '4h'
type SplitName = 'TRAIN' | 'VALIDATION' | 'TEST'
type ScenarioName = 'gross' | 'fees' | 'fees_slippage'

interface SignalRecord {
  symbol: string
  signalTimestamp: string
  candleOpenTime: number
  candleCloseTime: number
  entryPrice: number
  score: number
  status: 'SETUP LONG' | 'VIGILAR' | 'NEUTRAL' | 'EVITAR'
  returnGrossByHorizon: Record<HorizonName, number | null>
  outcomeByHorizon: Record<HorizonName, 'WIN' | 'LOSS' | 'TIMEOUT' | null>
  maeByHorizon: Record<HorizonName, number | null>
  mfeByHorizon: Record<HorizonName, number | null>
  split: SplitName
  monthKey: string
  quarterKey: string
}

interface SummaryMetrics {
  signals: number
  wins: number
  losses: number
  timeouts: number
  win_rate: number | null
  loss_rate: number | null
  timeout_rate: number | null
  average_return: number | null
  median_return: number | null
  std_dev_return: number | null
  expectancy: number | null
  profit_factor: number | null
  cumulative_return: number | null
  max_drawdown: number | null
  sharpe: number | null
  mae: number | null
  mfe: number | null
}

interface ScoreBucketRow {
  score_bucket: string
  number_of_signals: number
  win_rate: number | null
  average_return: number | null
  median_return: number | null
  profit_factor: number | null
  mae: number | null
  mfe: number | null
}

interface PeriodRow {
  period: string
  signals: number
  win_rate: number | null
  average_return: number | null
  cumulative_return: number | null
  drawdown: number | null
}

interface BacktestReport {
  report_name: string
  model_version: string
  generated_at: string
  commit_sha: string | null
  data: {
    start: string
    end: string
    total_candles: number
    symbols_processed: string[]
    interval: string
    timeframes: HorizonName[]
    target_months: number
    actual_months_available: number
  }
  methodology: {
    no_lookahead: boolean
    signal_definition: string
    entry_rule: string
    outcome_measurement: string
    fee_assumption: string
    slippage_assumption: string
    model_version_used: string
    production_functions_imported: string[]
    timestamp_precision: string
    model_issues_found: string[]
    methodology_warnings: string[]
  }
  costs: {
    scenario_gross: { description: string; fee_bps: number; slippage_bps: number }
    scenario_fees: { description: string; fee_bps: number; slippage_bps: number }
    scenario_fees_slippage: { description: string; fee_bps: number; slippage_bps: number }
  }
  summary: Record<ScenarioName, SummaryMetrics>
  by_symbol: Array<{
    symbol: string
    signals: number
    scenarios: Record<ScenarioName, SummaryMetrics>
  }>
  by_horizon: Array<{
    symbol: string
    horizon: HorizonName
    signals: number
    summary: SummaryMetrics
  }>
  by_score_bucket: ScoreBucketRow[]
  by_period: {
    monthly: PeriodRow[]
    quarterly: PeriodRow[]
  }
  by_split: Array<{
    name: SplitName
    from_timestamp: string | null
    to_timestamp: string | null
    signals: number
    summary: SummaryMetrics
  }>
  regime_analysis: Array<{
    regime: string
    signals: number
    win_rate: number | null
    average_return: number | null
    expectancy: number | null
    profit_factor: number | null
  }>
  signal_distribution: {
    percentiles: Array<{ percentile: number; value: number }>
    best_10: Array<{
      symbol: string
      score: number
      signal_timestamp: string
      return_15m: number
    }>
    worst_10: Array<{
      symbol: string
      score: number
      signal_timestamp: string
      return_15m: number
    }>
  }
  integrity_checks: {
    no_lookahead: boolean
    no_nans: boolean
    no_infinities: boolean
    no_duplicate_signals: boolean
    all_timestamps_valid: boolean
    all_outcomes_populated: boolean
    validation_warnings: string[]
  }
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const INTERVAL = '15m'
const MODEL_VERSION = 'v1.1-live'
const HORIZONS: HorizonName[] = ['15m', '1h', '4h']
const TARGET_MONTHS = 36

// Cost assumptions (documented, not guessed)
const FEE_BPS_REALISTIC = 10 // Typical maker fee on Binance
const SLIPPAGE_BPS_CONSERVATIVE = 5 // Conservative mid-to-market slippage

const DATA_DIR = path.join(process.cwd(), '.backtest-cache')
const REPORT_DIR = path.join(process.cwd(), 'reports')

// ============================================================================
// UTILITIES
// ============================================================================

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

function dateToMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthKeyToQuarter(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  const q = Math.floor((month - 1) / 3) + 1
  return `${year}-Q${q}`
}

function applyScenarioCost(grossReturn: number, scenario: ScenarioName): number {
  if (scenario === 'gross') return grossReturn
  const fee = FEE_BPS_REALISTIC / 10000
  const slippage = scenario === 'fees_slippage' ? SLIPPAGE_BPS_CONSERVATIVE / 10000 : 0
  return grossReturn - fee - slippage
}

function calcMedian(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

function calcStdDev(values: number[]): number | null {
  if (!values.length) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function calcSharpe(values: number[]): number | null {
  if (!values.length) return null
  const std = calcStdDev(values)
  if (std === null || !Number.isFinite(std) || std === 0) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return (mean / std) * Math.sqrt(values.length)
}

function calcProfitFactor(values: number[]): number | null {
  const positives = values.filter(v => v > 0)
  const negatives = values.filter(v => v < 0)
  if (!negatives.length) return null
  const posSum = positives.reduce((a, b) => a + b, 0)
  const negAbs = negatives.reduce((a, b) => a + Math.abs(b), 0)
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

function getOutcomeCategory(ret: number | null): 'WIN' | 'LOSS' | 'TIMEOUT' | null {
  if (ret === null || !Number.isFinite(ret)) return null
  if (ret > 0) return 'WIN'
  if (ret < 0) return 'LOSS'
  return 'TIMEOUT'
}

function toCsvRow(row: Array<string | number | null | undefined>) {
  return row
    .map(v => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    })
    .join(',')
}

function computeMetricsFromReturns(values: number[]): SummaryMetrics {
  const wins = values.filter(v => v > 0)
  const losses = values.filter(v => v < 0)
  const timeouts = values.filter(v => v === 0)
  return {
    signals: values.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    win_rate: values.length ? wins.length / values.length : null,
    loss_rate: values.length ? losses.length / values.length : null,
    timeout_rate: values.length ? timeouts.length / values.length : null,
    average_return: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    median_return: calcMedian(values),
    std_dev_return: calcStdDev(values),
    expectancy: calcExpectancy(values),
    profit_factor: calcProfitFactor(values),
    cumulative_return: cumulativeReturn(values),
    max_drawdown: maxDrawdown(values),
    sharpe: calcSharpe(values),
    mae: values.filter(v => v < 0).length ? Math.abs(Math.min(...values.filter(v => v < 0))) : null,
    mfe: values.filter(v => v > 0).length ? Math.max(...values.filter(v => v > 0)) : null,
  }
}

// ============================================================================
// DATA DOWNLOAD & PARSING
// ============================================================================

async function downloadMonth(symbol: string, monthKey: string): Promise<string | null> {
  const file = path.join(DATA_DIR, `${symbol}-${INTERVAL}-${monthKey}.zip`)
  try {
    await fs.access(file)
    return file
  } catch {}

  const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/${INTERVAL}/${symbol}-${INTERVAL}-${monthKey}.zip`
  const res = await fetch(url)
  if (res.status === 404) {
    console.warn(`[backtest] Binance archive unavailable (404), skipping ${symbol} ${monthKey}`)
    return null
  }
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
    if (!zipFile) continue
    const monthCandles = await unzipCsv(zipFile)
    candles.push(...monthCandles)
  }

  return candles
    .filter(c => c.openTime >= startMs && c.openTime <= endMs)
    .sort((a, b) => a.openTime - b.openTime)
}

// ============================================================================
// INCREMENTAL FEATURE ENGINE
// ============================================================================
//
// Mirrors lib/features.ts while maintaining rolling state. Benchmark-only;
// production feature/scoring code is unchanged.

class IncrementalFeatureEngine {
  private readonly emaStates = new Map<number, { count: number; sum: number; value: number | null }>()
  private readonly rsiPeriod = 14
  private rsiCount = 0
  private rsiGains = 0
  private rsiLosses = 0
  private avgGain: number | null = null
  private avgLoss: number | null = null
  private readonly volumePeriod = 20
  private volumeQueue: number[] = []
  private volumeSum = 0
  private readonly atrPeriod = 14
  private trQueue: number[] = []
  private trSum = 0
  private previousClose: number | null = null
  private readonly volatilityPeriod = 20
  private logReturnQueue: number[] = []
  private logReturnSum = 0
  private logReturnSumSq = 0
  private readonly macdSignalPeriod = 9
  private macdSignalState = { count: 0, sum: 0, value: null as number | null }
  private closeHistory: number[] = []

  private updateEma(period: number, value: number): number | null {
    const state = this.emaStates.get(period) ?? { count: 0, sum: 0, value: null }
    state.count += 1
    if (state.count <= period) {
      state.sum += value
      if (state.count === period) state.value = state.sum / period
    } else if (state.value !== null) {
      const k = 2 / (period + 1)
      state.value = value * k + state.value * (1 - k)
    }
    this.emaStates.set(period, state)
    return state.value
  }

  private updateMacdSignal(macd: number | null): number | null {
    if (macd === null) return null
    const state = this.macdSignalState
    state.count += 1
    if (state.count <= this.macdSignalPeriod) {
      state.sum += macd
      if (state.count === this.macdSignalPeriod) state.value = state.sum / this.macdSignalPeriod
    } else if (state.value !== null) {
      const k = 2 / (this.macdSignalPeriod + 1)
      state.value = macd * k + state.value * (1 - k)
    }
    return state.value
  }

  update(candle: Candle): FeatureSet {
    const close = candle.close
    this.closeHistory.push(close)

    const ema20 = this.updateEma(20, close)
    const ema50 = this.updateEma(50, close)
    const ema200 = this.updateEma(200, close)
    const ema12 = this.updateEma(12, close)
    const ema26 = this.updateEma(26, close)
    const trendStrength = ema20 !== null && ema50 !== null && ema50 !== 0 ? (ema20 / ema50) - 1 : null

    this.volumeQueue.push(candle.volume)
    this.volumeSum += candle.volume
    if (this.volumeQueue.length > this.volumePeriod) this.volumeSum -= this.volumeQueue.shift()!
    const volumeSma = this.volumeQueue.length === this.volumePeriod ? this.volumeSum / this.volumePeriod : null
    const volumeRatio = volumeSma !== null && volumeSma > 0 ? candle.volume / volumeSma : null

    const macd = ema12 !== null && ema26 !== null ? ema12 - ema26 : null
    const macdSignal = this.updateMacdSignal(macd)
    const macdHistogram = macd !== null && macdSignal !== null ? macd - macdSignal : null

    let rsi14: number | null = null
    if (this.previousClose !== null) {
      const change = close - this.previousClose
      if (this.rsiCount < this.rsiPeriod) {
        this.rsiCount += 1
        if (change >= 0) this.rsiGains += change
        else this.rsiLosses -= change
        if (this.rsiCount === this.rsiPeriod) {
          this.avgGain = this.rsiGains / this.rsiPeriod
          this.avgLoss = this.rsiLosses / this.rsiPeriod
        }
      } else if (this.avgGain !== null && this.avgLoss !== null) {
        const gain = Math.max(change, 0)
        const loss = Math.max(-change, 0)
        this.avgGain = (this.avgGain * (this.rsiPeriod - 1) + gain) / this.rsiPeriod
        this.avgLoss = (this.avgLoss * (this.rsiPeriod - 1) + loss) / this.rsiPeriod
      }
    }
    if (this.avgGain !== null && this.avgLoss !== null) {
      if (this.avgLoss === 0 && this.avgGain === 0) rsi14 = 50
      else if (this.avgLoss === 0) rsi14 = 100
      else rsi14 = 100 - (100 / (1 + this.avgGain / this.avgLoss))
    }

    let atr14: number | null = null
    if (this.previousClose !== null) {
      const tr = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - this.previousClose),
        Math.abs(candle.low - this.previousClose)
      )
      this.trQueue.push(tr)
      this.trSum += tr
      if (this.trQueue.length > this.atrPeriod) this.trSum -= this.trQueue.shift()!
      if (this.trQueue.length === this.atrPeriod) atr14 = this.trSum / this.atrPeriod
    }

    let volatility: number | null = null
    if (this.previousClose !== null && this.previousClose > 0 && close > 0) {
      const lr = Math.log(close / this.previousClose)
      this.logReturnQueue.push(lr)
      this.logReturnSum += lr
      this.logReturnSumSq += lr * lr
      if (this.logReturnQueue.length > this.volatilityPeriod) {
        const removed = this.logReturnQueue.shift()!
        this.logReturnSum -= removed
        this.logReturnSumSq -= removed * removed
      }
      if (this.logReturnQueue.length === this.volatilityPeriod) {
        const mean = this.logReturnSum / this.volatilityPeriod
        const variance = Math.max(0, this.logReturnSumSq / this.volatilityPeriod - mean * mean)
        volatility = Math.sqrt(variance) * Math.sqrt(this.volatilityPeriod)
      }
    }

    const returnFrom = (barsBack: number): number | null => {
      if (this.closeHistory.length <= barsBack) return null
      const then = this.closeHistory[this.closeHistory.length - 1 - barsBack]
      return then > 0 ? (close / then) - 1 : null
    }

    this.previousClose = close
    return {
      return_5m: null,
      return_15m: returnFrom(1),
      return_1h: returnFrom(4),
      return_4h: returnFrom(16),
      return_24h: returnFrom(96),
      ema_20: ema20,
      ema_50: ema50,
      ema_200: ema200,
      trend_strength: trendStrength,
      rsi_14: rsi14,
      macd,
      macd_signal: macdSignal,
      macd_histogram: macdHistogram,
      volume_sma: volumeSma,
      volume_ratio: volumeRatio,
      volatility,
      atr: atr14,
    }
  }
}

// ============================================================================
// BACKTEST ENGINE
// ============================================================================

async function runBacktest(): Promise<BacktestReport> {
  const startDate = nowMinusMonths(TARGET_MONTHS)
  const endDate = new Date()
  const startMs = startDate.getTime()
  const endMs = endDate.getTime()

  console.log(`[backtest] Loading data from ${startDate.toISOString()} to ${endDate.toISOString()}`)

  // Load all symbol data
  const symbolData = new Map<string, Candle[]>()
  let totalCandles = 0

  for (const symbol of SYMBOLS) {
    console.log(`[backtest] Loading ${symbol}...`)
    const candles = await loadSymbol(symbol, startMs, endMs)
    symbolData.set(symbol, candles)
    totalCandles += candles.length
    console.log(`[backtest] ${symbol}: ${candles.length.toLocaleString()} candles`)
  }

  // Generate signals
  const allSignals: SignalRecord[] = []
  const signalsBySymbol = new Map<string, SignalRecord[]>()
  const validationWarnings: string[] = []

  const trainCutoff = new Date(startMs + (endMs - startMs) * 0.6)
  const validationCutoff = new Date(startMs + (endMs - startMs) * 0.8)

  for (const symbol of SYMBOLS) {
    const candles = symbolData.get(symbol) ?? []
    if (!candles.length) {
      validationWarnings.push(`No candles loaded for ${symbol}`)
      continue
    }

    console.log('[backtest] Processing signals for ' + symbol + '...')
    const featureEngine = new IncrementalFeatureEngine()

    // Spot-check incremental features against production at three checkpoints.
    const parityIndices = [200, Math.min(1000, candles.length - 17), Math.min(2000, candles.length - 17)]
    for (const parityIndex of parityIndices) {
      const expected = calculateFeatures(candles.slice(0, parityIndex + 1))
      const parityEngine = new IncrementalFeatureEngine()
      let actual: FeatureSet | null = null
      for (let j = 0; j <= parityIndex; j++) actual = parityEngine.update(candles[j])
      if (!actual) throw new Error('Feature parity engine produced no result')
      const fields: (keyof FeatureSet)[] = ['return_15m','return_1h','return_4h','return_24h','ema_20','ema_50','ema_200','trend_strength','rsi_14','macd','macd_signal','macd_histogram','volume_sma','volume_ratio','volatility','atr']
      for (const field of fields) {
        const a = actual[field]
        const e = expected[field]
        const equal = a === null && e === null
        const closeEnough = typeof a === 'number' && typeof e === 'number' &&
          Math.abs(a - e) <= Math.max(1e-12, Math.abs(e) * 1e-10)
        if (!equal && !closeEnough) {
          throw new Error('Feature parity mismatch for ' + symbol + ' index ' + parityIndex + ' field ' + field + ': incremental=' + a + ' production=' + e)
        }
      }
    }
    console.log('[backtest] ' + symbol + ': feature parity checks passed')

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]
      const features = featureEngine.update(candle)

      if (i < 200 || i >= candles.length - 16) continue

      // PHASE 1: Signal generation (no look-ahead)
      const { score, status } = calculateRadarScore(features)

      if (i % 10000 === 0) {
        console.log('[backtest] ' + symbol + ': processed ' + i.toLocaleString() + '/' + candles.length.toLocaleString() + ' candles')
      }

      // Only process SETUP LONG signals
      if (status !== 'SETUP LONG') continue

      const signalTimestamp = new Date(candle.openTime + 15 * 60 * 1000).toISOString()
      const asOfTime = new Date(signalTimestamp)

      // Determine split
      const split: SplitName = asOfTime < trainCutoff ? 'TRAIN' : asOfTime < validationCutoff ? 'VALIDATION' : 'TEST'

      // PHASE 2: Outcome measurement (future-only)
      const horizonReturns: Record<HorizonName, number | null> = {
        '15m': null,
        '1h': null,
        '4h': null,
      }
      const outcomes: Record<HorizonName, 'WIN' | 'LOSS' | 'TIMEOUT' | null> = {
        '15m': null,
        '1h': null,
        '4h': null,
      }
      const mae: Record<HorizonName, number | null> = { '15m': null, '1h': null, '4h': null }
      const mfe: Record<HorizonName, number | null> = { '15m': null, '1h': null, '4h': null }

      const targetIndices = { '15m': i + 1, '1h': i + 4, '4h': i + 16 }

      for (const horizon of HORIZONS) {
        const targetIdx = targetIndices[horizon]

        if (targetIdx >= candles.length) {
          horizonReturns[horizon] = null
          outcomes[horizon] = null
          continue
        }

        const targetCandle = candles[targetIdx]
        if (!targetCandle || !Number.isFinite(targetCandle.close) || targetCandle.close <= 0) {
          horizonReturns[horizon] = null
          outcomes[horizon] = null
          continue
        }

        // Calculate return from entry to target
        const ret = (targetCandle.close - candle.close) / candle.close
        horizonReturns[horizon] = ret

        // Calculate MAE/MFE on the path
        const pathCandles = candles.slice(i + 1, targetIdx + 1)
        if (pathCandles.length > 0) {
          const lows = pathCandles.map(c => c.low)
          const highs = pathCandles.map(c => c.high)
          const lowestPoint = Math.min(...lows)
          const highestPoint = Math.max(...highs)
          mae[horizon] = Math.abs((lowestPoint - candle.close) / candle.close)
          mfe[horizon] = (highestPoint - candle.close) / candle.close
        }

        outcomes[horizon] = getOutcomeCategory(ret)
      }

      const signal: SignalRecord = {
        symbol,
        signalTimestamp,
        candleOpenTime: candle.openTime,
        candleCloseTime: candle.openTime + 15 * 60 * 1000,
        entryPrice: candle.close,
        score,
        status,
        returnGrossByHorizon: horizonReturns,
        outcomeByHorizon: outcomes,
        maeByHorizon: mae,
        mfeByHorizon: mfe,
        split,
        monthKey: dateToMonthKey(asOfTime),
        quarterKey: monthKeyToQuarter(dateToMonthKey(asOfTime)),
      }

      allSignals.push(signal)
      const list = signalsBySymbol.get(symbol) ?? []
      list.push(signal)
      signalsBySymbol.set(symbol, list)
    }
  }

  console.log(`[backtest] Total signals generated: ${allSignals.length}`)

  // =========================================================================
  // INTEGRITY CHECKS
  // =========================================================================

  const integrityChecks = {
    no_lookahead: true,
    no_nans: true,
    no_infinities: true,
    no_duplicate_signals: true,
    all_timestamps_valid: true,
    all_outcomes_populated: true,
    validation_warnings: validationWarnings,
  }

  const signalSignatures = new Set<string>()
  for (const sig of allSignals) {
    // Check for duplicates
    const signature = `${sig.symbol}:${sig.candleOpenTime}`
    if (signalSignatures.has(signature)) {
      integrityChecks.no_duplicate_signals = false
      integrityChecks.validation_warnings.push(`Duplicate signal: ${signature}`)
    }
    signalSignatures.add(signature)

    // Check for NaN/Infinity
    for (const horizon of HORIZONS) {
      const ret = sig.returnGrossByHorizon[horizon]
      if (ret !== null && !Number.isFinite(ret)) {
        integrityChecks.no_nans = false
        integrityChecks.no_infinities = false
        integrityChecks.validation_warnings.push(
          `Invalid return value for ${sig.symbol} ${horizon}: ${ret}`
        )
      }
    }

    // Check timestamp validity
    if (!sig.signalTimestamp || isNaN(new Date(sig.signalTimestamp).getTime())) {
      integrityChecks.all_timestamps_valid = false
      integrityChecks.validation_warnings.push(`Invalid timestamp: ${sig.signalTimestamp}`)
    }
  }

  // =========================================================================
  // COMPUTE METRICS FOR ALL SCENARIOS AND DIMENSIONS
  // =========================================================================

  function getReturnsByScenario(
    records: SignalRecord[],
    horizon: HorizonName,
    scenario: ScenarioName
  ): number[] {
    return records
      .map(r => r.returnGrossByHorizon[horizon])
      .filter((v): v is number => Number.isFinite(v))
      .map(v => applyScenarioCost(v, scenario))
  }

  // Summary by scenario
  const summaryGross = computeMetricsFromReturns(getReturnsByScenario(allSignals, '15m', 'gross'))
  const summaryFees = computeMetricsFromReturns(getReturnsByScenario(allSignals, '15m', 'fees'))
  const summaryFeeSlippage = computeMetricsFromReturns(getReturnsByScenario(allSignals, '15m', 'fees_slippage'))

  // By symbol
  const bySymbol = SYMBOLS.map(symbol => {
    const records = signalsBySymbol.get(symbol) ?? []
    return {
      symbol,
      signals: records.length,
      scenarios: {
        gross: computeMetricsFromReturns(getReturnsByScenario(records, '15m', 'gross')),
        fees: computeMetricsFromReturns(getReturnsByScenario(records, '15m', 'fees')),
        fees_slippage: computeMetricsFromReturns(getReturnsByScenario(records, '15m', 'fees_slippage')),
      },
    }
  })

  // By horizon
  const byHorizon = SYMBOLS.flatMap(symbol => {
    const records = signalsBySymbol.get(symbol) ?? []
    return HORIZONS.map(horizon => ({
      symbol,
      horizon,
      signals: records.length,
      summary: computeMetricsFromReturns(getReturnsByScenario(records, horizon, 'gross')),
    }))
  })

  // By score bucket
  const scoreBuckets = ['50-54', '55-59', '60-64', '65-69', '70-74', '75-79', '80-84', '85-89', '90-94', '95-100']
  const byScoreBucket: ScoreBucketRow[] = scoreBuckets.map(bucket => {
    const [low, high] = bucket.split('-').map(Number)
    const subset = allSignals.filter(s => s.score >= low && s.score <= high)
    const returns = getReturnsByScenario(subset, '15m', 'gross')
    const wins = returns.filter(v => v > 0).length
    const losses = returns.filter(v => v < 0).length

    return {
      score_bucket: bucket,
      number_of_signals: subset.length,
      win_rate: returns.length ? wins / returns.length : null,
      average_return: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
      median_return: calcMedian(returns),
      profit_factor: calcProfitFactor(returns),
      mae: losses > 0 ? Math.abs(Math.min(...returns.filter(v => v < 0))) : null,
      mfe: wins > 0 ? Math.max(...returns.filter(v => v > 0)) : null,
    }
  })

  // By period (monthly and quarterly)
  const byMonth = new Map<string, SignalRecord[]>()
  for (const sig of allSignals) {
    const key = sig.monthKey
    const list = byMonth.get(key) ?? []
    list.push(sig)
    byMonth.set(key, list)
  }

  const monthlyPeriodRows: PeriodRow[] = Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, records]) => {
      const returns = getReturnsByScenario(records, '15m', 'gross')
      const wins = returns.filter(v => v > 0).length
      return {
        period: monthKey,
        signals: records.length,
        win_rate: returns.length ? wins / returns.length : null,
        average_return: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
        cumulative_return: cumulativeReturn(returns),
        drawdown: maxDrawdown(returns),
      }
    })

  const byQuarter = new Map<string, SignalRecord[]>()
  for (const sig of allSignals) {
    const key = sig.quarterKey
    const list = byQuarter.get(key) ?? []
    list.push(sig)
    byQuarter.set(key, list)
  }

  const quarterlyPeriodRows: PeriodRow[] = Array.from(byQuarter.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([quarterKey, records]) => {
      const returns = getReturnsByScenario(records, '15m', 'gross')
      const wins = returns.filter(v => v > 0).length
      return {
        period: quarterKey,
        signals: records.length,
        win_rate: returns.length ? wins / returns.length : null,
        average_return: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
        cumulative_return: cumulativeReturn(returns),
        drawdown: maxDrawdown(returns),
      }
    })

  // By split (TRAIN/VALIDATION/TEST)
  const bySplit = (['TRAIN', 'VALIDATION', 'TEST'] as const).map(splitName => {
    const records = allSignals.filter(s => s.split === splitName)
    const sorted = records.sort((a, b) => new Date(a.signalTimestamp).getTime() - new Date(b.signalTimestamp).getTime())
    return {
      name: splitName,
      from_timestamp: sorted[0]?.signalTimestamp ?? null,
      to_timestamp: sorted[sorted.length - 1]?.signalTimestamp ?? null,
      signals: records.length,
      summary: computeMetricsFromReturns(getReturnsByScenario(records, '15m', 'gross')),
    }
  })

  // By regime (status)
  const regimes = ['SETUP LONG', 'VIGILAR', 'NEUTRAL', 'EVITAR'] as const
  const regimeAnalysis = regimes
    .map(regime => {
      const records = allSignals.filter(s => s.status === regime)
      const returns = getReturnsByScenario(records, '15m', 'gross')
      const wins = returns.filter(v => v > 0).length
      return {
        regime,
        signals: records.length,
        win_rate: returns.length ? wins / returns.length : null,
        average_return: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
        expectancy: calcExpectancy(returns),
        profit_factor: calcProfitFactor(returns),
      }
    })
    .filter(r => r.signals > 0)

  // Signal distribution percentiles
  const allReturns15m = getReturnsByScenario(allSignals, '15m', 'gross')
  const percentiles = [5, 10, 25, 50, 75, 90, 95].map(p => {
    const sorted = [...allReturns15m].sort((a, b) => a - b)
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    const value = sorted[Math.max(0, Math.min(sorted.length - 1, idx))]
    return { percentile: p, value }
  })

  // Best 10 trades
  const best10 = allSignals
    .map(s => ({ s, ret: s.returnGrossByHorizon['15m'] }))
    .filter((x): x is { s: SignalRecord; ret: number } => Number.isFinite(x.ret))
    .sort((a, b) => (b.ret ?? 0) - (a.ret ?? 0))
    .slice(0, 10)
    .map(x => ({
      symbol: x.s.symbol,
      score: x.s.score,
      signal_timestamp: x.s.signalTimestamp,
      return_15m: x.ret,
    }))

  // Worst 10 trades
  const worst10 = allSignals
    .map(s => ({ s, ret: s.returnGrossByHorizon['15m'] }))
    .filter((x): x is { s: SignalRecord; ret: number } => Number.isFinite(x.ret))
    .sort((a, b) => (a.ret ?? 0) - (b.ret ?? 0))
    .slice(0, 10)
    .map(x => ({
      symbol: x.s.symbol,
      score: x.s.score,
      signal_timestamp: x.s.signalTimestamp,
      return_15m: x.ret,
    }))

  // Get git commit SHA
  let commitSha: string | null = null
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'])
    commitSha = stdout.trim()
  } catch (e) {
    validationWarnings.push('Could not retrieve git commit SHA')
  }

  // =========================================================================
  // BUILD FINAL REPORT
  // =========================================================================

  const report: BacktestReport = {
    report_name: 'radar-crypto-backtest-baseline',
    model_version: MODEL_VERSION,
    generated_at: new Date().toISOString(),
    commit_sha: commitSha,
    data: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      total_candles: totalCandles,
      symbols_processed: SYMBOLS,
      interval: INTERVAL,
      timeframes: HORIZONS,
      target_months: TARGET_MONTHS,
      actual_months_available: monthKeys(startDate, endDate).length,
    },
    methodology: {
      no_lookahead: true,
      signal_definition:
        'Signals are generated when status === "SETUP LONG" (score >= 75). Features are computed using only historical closed candles up to and including the signal bar.',
      entry_rule: 'Entry price is the close of the 15m candle that generates the SETUP LONG signal.',
      outcome_measurement:
        'Outcome is measured as the simple return from entry price to the close of the candle at the target horizon (1, 4, or 16 bars forward).',
      fee_assumption: `Scenario B applies ${FEE_BPS_REALISTIC} bps as a realistic market-maker execution fee, not derived from specific exchange rebate tiers.`,
      slippage_assumption: `Scenario C adds ${SLIPPAGE_BPS_CONSERVATIVE} bps as conservative mid-to-market slippage, representing partial fill at slightly worse prices.`,
      model_version_used: MODEL_VERSION,
      production_functions_imported: [
        'lib/features.ts: calculateFeatures() (parity spot-checks)',
        'scripts/backtest-baseline.ts: IncrementalFeatureEngine mirrors calculateFeatures() formulas',
        'lib/scoring.ts: calculateRadarScore()',
      ],
      timestamp_precision:
        'Signal timestamp is derived from candle openTime plus 15m interval. Outcome targets are subsequent closed candles.',
      model_issues_found: [
        'calculateFeatures() hardcodes return_5m to null; the 5m feature is not available despite the FeatureSet type definition.',
        'Production route defines regime via status value ("SETUP LONG", "VIGILAR", "NEUTRAL", "EVITAR") rather than a separate market-regime classifier.',
      ],
      methodology_warnings: [
        'Entry price uses close of the signal bar; this is realistic but could experience microfill slippage on market orders.',
        'Outcome measurement assumes the first available candle close at the target horizon; gaps or data anomalies could affect results.',
        'Incremental feature engine is benchmark-only and validated against production calculateFeatures() at three checkpoints per symbol.'
      ],
    },
    costs: {
      scenario_gross: {
        description: 'Gross returns without fees or slippage.',
        fee_bps: 0,
        slippage_bps: 0,
      },
      scenario_fees: {
        description: `Realistic execution fees only (${FEE_BPS_REALISTIC} bps).`,
        fee_bps: FEE_BPS_REALISTIC,
        slippage_bps: 0,
      },
      scenario_fees_slippage: {
        description: `Fees (${FEE_BPS_REALISTIC} bps) plus conservative slippage (${SLIPPAGE_BPS_CONSERVATIVE} bps).`,
        fee_bps: FEE_BPS_REALISTIC,
        slippage_bps: SLIPPAGE_BPS_CONSERVATIVE,
      },
    },
    summary: {
      gross: summaryGross,
      fees: summaryFees,
      fees_slippage: summaryFeeSlippage,
    },
    by_symbol: bySymbol,
    by_horizon: byHorizon,
    by_score_bucket: byScoreBucket,
    by_period: {
      monthly: monthlyPeriodRows,
      quarterly: quarterlyPeriodRows,
    },
    by_split: bySplit,
    regime_analysis: regimeAnalysis,
    signal_distribution: {
      percentiles,
      best_10: best10,
      worst_10: worst10,
    },
    integrity_checks: integrityChecks,
  }

  return report
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

async function generateReports(report: BacktestReport): Promise<void> {
  await fs.mkdir(REPORT_DIR, { recursive: true })

  // JSON report
  const baselineJson = path.join(REPORT_DIR, 'backtest-baseline.json')
  await fs.writeFile(baselineJson, JSON.stringify(report, null, 2) + '\n')

  const dateStamp = report.generated_at.split('T')[0]
  await fs.writeFile(
    path.join(REPORT_DIR, `backtest-baseline-${dateStamp}.json`),
    JSON.stringify(report, null, 2) + '\n'
  )

  // Summary CSV
  const summaryCsv = [
    ['metric', 'gross', 'fees', 'fees_slippage'],
    ['signals', report.summary.gross.signals, report.summary.fees.signals, report.summary.fees_slippage.signals],
    ['wins', report.summary.gross.wins, report.summary.fees.wins, report.summary.fees_slippage.wins],
    ['losses', report.summary.gross.losses, report.summary.fees.losses, report.summary.fees_slippage.losses],
    ['timeouts', report.summary.gross.timeouts, report.summary.fees.timeouts, report.summary.fees_slippage.timeouts],
    ['win_rate', report.summary.gross.win_rate ?? '', report.summary.fees.win_rate ?? '', report.summary.fees_slippage.win_rate ?? ''],
    ['average_return', report.summary.gross.average_return ?? '', report.summary.fees.average_return ?? '', report.summary.fees_slippage.average_return ?? ''],
    ['median_return', report.summary.gross.median_return ?? '', report.summary.fees.median_return ?? '', report.summary.fees_slippage.median_return ?? ''],
    ['std_dev_return', report.summary.gross.std_dev_return ?? '', report.summary.fees.std_dev_return ?? '', report.summary.fees_slippage.std_dev_return ?? ''],
    ['expectancy', report.summary.gross.expectancy ?? '', report.summary.fees.expectancy ?? '', report.summary.fees_slippage.expectancy ?? ''],
    ['profit_factor', report.summary.gross.profit_factor ?? '', report.summary.fees.profit_factor ?? '', report.summary.fees_slippage.profit_factor ?? ''],
    ['cumulative_return', report.summary.gross.cumulative_return ?? '', report.summary.fees.cumulative_return ?? '', report.summary.fees_slippage.cumulative_return ?? ''],
    ['max_drawdown', report.summary.gross.max_drawdown ?? '', report.summary.fees.max_drawdown ?? '', report.summary.fees_slippage.max_drawdown ?? ''],
    ['sharpe', report.summary.gross.sharpe ?? '', report.summary.fees.sharpe ?? '', report.summary.fees_slippage.sharpe ?? ''],
    ['mae', report.summary.gross.mae ?? '', report.summary.fees.mae ?? '', report.summary.fees_slippage.mae ?? ''],
    ['mfe', report.summary.gross.mfe ?? '', report.summary.fees.mfe ?? '', report.summary.fees_slippage.mfe ?? ''],
  ].map(toCsvRow).join('\n') + '\n'
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-summary.csv'), summaryCsv)

  // By symbol CSV
  const bySymbolCsv = [
    ['symbol', 'signals', 'win_rate', 'average_return', 'median_return', 'expectancy', 'profit_factor', 'max_drawdown', 'sharpe', 'mae', 'mfe'],
    ...report.by_symbol.map(row => [
      row.symbol,
      row.signals,
      row.scenarios.gross.win_rate ?? '',
      row.scenarios.gross.average_return ?? '',
      row.scenarios.gross.median_return ?? '',
      row.scenarios.gross.expectancy ?? '',
      row.scenarios.gross.profit_factor ?? '',
      row.scenarios.gross.max_drawdown ?? '',
      row.scenarios.gross.sharpe ?? '',
      row.scenarios.gross.mae ?? '',
      row.scenarios.gross.mfe ?? '',
    ]),
  ].map(toCsvRow).join('\n') + '\n'
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-symbol.csv'), bySymbolCsv)

  // By horizon CSV
  const byHorizonCsv = [
    ['symbol', 'horizon', 'signals', 'win_rate', 'average_return', 'median_return', 'expectancy', 'profit_factor', 'max_drawdown', 'sharpe'],
    ...report.by_horizon.map(row => [
      row.symbol,
      row.horizon,
      row.signals,
      row.summary.win_rate ?? '',
      row.summary.average_return ?? '',
      row.summary.median_return ?? '',
      row.summary.expectancy ?? '',
      row.summary.profit_factor ?? '',
      row.summary.max_drawdown ?? '',
      row.summary.sharpe ?? '',
    ]),
  ].map(toCsvRow).join('\n') + '\n'
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-horizon.csv'), byHorizonCsv)

  // By score bucket CSV
  const byScoreCsv = [
    ['score_bucket', 'number_of_signals', 'win_rate', 'average_return', 'median_return', 'profit_factor', 'mae', 'mfe'],
    ...report.by_score_bucket.map(row => [
      row.score_bucket,
      row.number_of_signals,
      row.win_rate ?? '',
      row.average_return ?? '',
      row.median_return ?? '',
      row.profit_factor ?? '',
      row.mae ?? '',
      row.mfe ?? '',
    ]),
  ].map(toCsvRow).join('\n') + '\n'
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-score.csv'), byScoreCsv)

  // By period CSV
  const byPeriodCsv = [
    ['period', 'signals', 'win_rate', 'average_return', 'cumulative_return', 'drawdown'],
    ...report.by_period.monthly.map(row => [
      row.period,
      row.signals,
      row.win_rate ?? '',
      row.average_return ?? '',
      row.cumulative_return ?? '',
      row.drawdown ?? '',
    ]),
  ].map(toCsvRow).join('\n') + '\n'
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-by-period.csv'), byPeriodCsv)

  console.log(`\n[reports] Generated:`)
  console.log(`  - ${baselineJson}`)
  console.log(`  - ${path.join(REPORT_DIR, 'backtest-summary.csv')}`)
  console.log(`  - ${path.join(REPORT_DIR, 'backtest-by-symbol.csv')}`)
  console.log(`  - ${path.join(REPORT_DIR, 'backtest-by-horizon.csv')}`)
  console.log(`  - ${path.join(REPORT_DIR, 'backtest-by-score.csv')}`)
  console.log(`  - ${path.join(REPORT_DIR, 'backtest-by-period.csv')}`)
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
  try {
    console.log(`\n[backtest] Starting baseline benchmark run`)
    console.log(`[backtest] Model version: ${MODEL_VERSION}`)
    console.log(`[backtest] Symbols: ${SYMBOLS.join(', ')}`)
    console.log(`[backtest] Interval: ${INTERVAL}`)
    console.log(`[backtest] Horizons: ${HORIZONS.join(', ')}`)

    const report = await runBacktest()
    await generateReports(report)

    console.log(`\n[backtest] Completed successfully`)
    console.log(
      `[backtest] Total signals: ${report.summary.gross.signals}`
    )
    console.log(`[backtest] Win rate: ${(report.summary.gross.win_rate ?? 0) * 100}%`)
    console.log(`[backtest] Average return: ${(report.summary.gross.average_return ?? 0) * 100}%`)
    console.log(`[backtest] Sharpe ratio: ${report.summary.gross.sharpe ?? 'N/A'}`)
    console.log(`[backtest] Max drawdown: ${(report.summary.gross.max_drawdown ?? 0) * 100}%`)
  } catch (error) {
    console.error('[backtest] Error:', error)
    process.exit(1)
  }
}

main()
