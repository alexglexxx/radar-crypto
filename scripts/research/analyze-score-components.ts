import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Candle, FeatureSet } from '../../lib/features'
import { calculateFeatureSeries } from './production-features'
import { calculateRadarScore } from '../../lib/scoring'

const exec = promisify(execFile)
const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(x => x.trim()).filter(Boolean)
const MONTHS = Number(process.env.MONTHS ?? 24)
const STEP = 15 * 60_000
const HOLD = 16
const COSTS = [15, 20, 25]
const CACHE = path.join(process.cwd(), '.backtest-cache-components')
const REPORTS = path.join(process.cwd(), 'reports')

type Component = { trend: number; momentum: number; volume: number; macd: number; rsi: number; volatility: number }
type Observation = { symbol: string; time: number; score: number; gross: number; regime: string; atrPct: number | null; parts: Component }

function clamp(n: number, min: number, max: number) { return Math.min(max, Math.max(min, n)) }
function contribution(f: FeatureSet): Component {
  let trend = 0, momentum = 0, volume = 0, macd = 0, rsi = 0, volatility = 0
  if (f.ema_200 !== null) {
    if (f.ema_20 !== null && f.ema_50 !== null) trend += f.ema_20 > f.ema_50 ? 8 : -8
    if (f.trend_strength !== null) {
      if (f.trend_strength >= 0.01) trend += 10
      else if (f.trend_strength >= 0.003) trend += 5
      else if (f.trend_strength <= -0.01) trend -= 10
      else if (f.trend_strength <= -0.003) trend -= 5
    }
  }
  if (f.return_15m !== null) momentum += clamp(f.return_15m * 1000, -5, 5)
  if (f.return_1h !== null) momentum += clamp(f.return_1h * 400, -8, 8)
  if (f.return_4h !== null) momentum += clamp(f.return_4h * 150, -6, 6)
  if (f.return_24h !== null) momentum += clamp(f.return_24h * 50, -6, 6)
  if (f.volume_ratio !== null) {
    if (f.volume_ratio >= 2) volume += 10
    else if (f.volume_ratio >= 1.3) volume += 7
    else if (f.volume_ratio >= 1.05) volume += 3
    else if (f.volume_ratio < 0.7) volume -= 6
  }
  if (f.macd_histogram !== null) macd += f.macd_histogram > 0 ? 5 : -5
  if (f.rsi_14 !== null) {
    if (f.rsi_14 >= 52 && f.rsi_14 <= 68) rsi += 5
    else if ((f.rsi_14 >= 45 && f.rsi_14 < 52) || (f.rsi_14 > 68 && f.rsi_14 <= 72)) rsi += 1
    else if (f.rsi_14 > 78) rsi -= 6
    else if (f.rsi_14 < 35) rsi -= 5
  }
  if (f.atr !== null && f.ema_200 !== null && f.atr > 0 && f.atr / f.ema_200 > 0.08) volatility -= 5
  return { trend, momentum, volume, macd, rsi, volatility }
}
function monthKeys(start: Date, end: Date) {
  const out: string[] = []
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (d <= last) { out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')); d.setUTCMonth(d.getUTCMonth() + 1) }
  return out
}
async function archive(symbol: string, month: string): Promise<string | null> {
  const file = path.join(CACHE, symbol + '-15m-' + month + '.zip')
  try { await fs.access(file); return file } catch {}
  const url = 'https://data.binance.vision/data/spot/monthly/klines/' + symbol + '/15m/' + symbol + '-15m-' + month + '.zip'
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Binance archive HTTP ' + res.status + ': ' + url)
  await fs.mkdir(CACHE, { recursive: true })
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
  return file
}
async function parseZip(file: string): Promise<Candle[]> {
  const dir = path.join(CACHE, 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  try {
    await exec('unzip', ['-oq', file, '-d', dir])
    const csv = (await fs.readdir(dir)).find(x => x.endsWith('.csv'))
    if (!csv) throw new Error('No CSV in ' + file)
    const lines = (await fs.readFile(path.join(dir, csv), 'utf8')).trim().split(/\r?\n/)
    const offset = lines[0]?.toLowerCase().includes('open time') ? 1 : 0
    const out: Candle[] = []
    for (let i = offset; i < lines.length; i++) {
      const f = lines[i].split(',')
      if (f.length < 6) continue
      const raw = Number(f[0]), openTime = raw > 1e14 ? Math.floor(raw / 1000) : raw
      const [open, high, low, close, volume] = f.slice(1, 6).map(Number)
      if ([openTime, open, high, low, close, volume].every(Number.isFinite)) out.push({ openTime, open, high, low, close, volume })
    }
    return out
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
async function load(symbol: string, start: number, end: number): Promise<Candle[]> {
  const all: Candle[] = []
  for (const m of monthKeys(new Date(start), new Date(end))) { const f = await archive(symbol, m); if (f) all.push(...await parseZip(f)) }
  const rows = all.filter(c => c.openTime >= start && c.openTime <= end).sort((a, b) => a.openTime - b.openTime)
  const expected = Math.floor((end - start) / STEP) + 1
  if (rows.length !== expected) throw new Error('Coverage failure ' + symbol + ': ' + rows.length + '/' + expected)
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i]
    if (!(c.open > 0 && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high) && c.close > 0 && c.volume >= 0)) throw new Error('Invalid OHLCV ' + symbol + ' index ' + i)
    if (i && c.openTime - rows[i - 1].openTime !== STEP) throw new Error('Gap/duplicate in ' + symbol + ' at ' + new Date(c.openTime).toISOString())
  }
  return rows
}
function summarize(rows: Observation[], costBps: number) {
  const rs = rows.map(x => x.gross - costBps / 10_000)
  const wins = rs.filter(x => x > 0)
  const losses = rs.filter(x => x < 0)
  const profit = wins.reduce((a, b) => a + b, 0)
  const loss = -losses.reduce((a, b) => a + b, 0)
  return { observations: rows.length, winRate: rs.length ? wins.length / rs.length : null, expectancy: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, profitFactor: loss ? profit / loss : profit > 0 ? null : 0 }
}
function summarizeComponents(rows: Observation[]) {
  const names: (keyof Component)[] = ['trend', 'momentum', 'volume', 'macd', 'rsi', 'volatility']
  return names.map(name => {
    const positive = rows.filter(r => r.parts[name] > 0)
    const negative = rows.filter(r => r.parts[name] < 0)
    const neutral = rows.filter(r => r.parts[name] === 0)
    return { component: name, positive: { contributionMean: positive.length ? positive.reduce((s, r) => s + r.parts[name], 0) / positive.length : null, netAt15bps: summarize(positive, 15) }, negative: { contributionMean: negative.length ? negative.reduce((s, r) => s + r.parts[name], 0) / negative.length : null, netAt15bps: summarize(negative, 15) }, neutral: summarize(neutral, 15), caveat: 'Overlapping observations; conditional association, not causal attribution or portfolio returns.' }
  })
}
async function main() {
  if (!Number.isInteger(MONTHS) || MONTHS < 1) throw new Error('MONTHS must be a positive integer')
  if (!SYMBOLS.length) throw new Error('SYMBOLS is empty')
  const current = new Date(), monthStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1))
  const end = monthStart.getTime() - STEP, startDate = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - MONTHS, 1))
  const all: Observation[] = [], coverage: any[] = []
  for (const symbol of SYMBOLS) {
    console.log('[score-components] loading ' + symbol)
    const candles = await load(symbol, startDate.getTime(), end)
    coverage.push({ symbol, candles: candles.length, start: new Date(candles[0].openTime).toISOString(), end: new Date(candles[candles.length - 1].openTime).toISOString(), gaps: 0 })
    const features = calculateFeatureSeries(candles)
    let parityChecks = 0
    for (let i = 200; i + HOLD + 1 < candles.length; i++) {
      const f = features[i], parts = contribution(f)
      const reconstructed = Math.round(clamp(50 + parts.trend + parts.momentum + parts.volume + parts.macd + parts.rsi + parts.volatility, 0, 100))
      const actual = calculateRadarScore(f).score
      if (reconstructed !== actual) throw new Error('Component score parity failure ' + symbol + ' index=' + i + ' reconstructed=' + reconstructed + ' actual=' + actual)
      parityChecks++
      const entry = i + 1, exit = entry + HOLD
      const e50 = f.ema_50, e200 = f.ema_200
      const regime = e50 !== null && e200 !== null ? (e50 > e200 * 1.01 ? 'bull' : e50 < e200 * 0.99 ? 'bear' : 'sideways') : 'sideways'
      all.push({ symbol, time: candles[i].openTime, score: actual, gross: candles[exit].open / candles[entry].open - 1, regime, atrPct: f.atr !== null ? f.atr / candles[i].close : null, parts })
    }
    console.log('[score-components] ' + symbol + ' scored=' + parityChecks + ' component parity=OK')
  }
  const buckets = [{ name: 'score_60_69', min: 60, max: 69 }, { name: 'score_70_74', min: 70, max: 74 }, { name: 'score_75_79', min: 75, max: 79 }, { name: 'score_80_84', min: 80, max: 84 }, { name: 'score_85_89', min: 85, max: 89 }, { name: 'score_90_100', min: 90, max: 100 }]
  const report = {
    reportName: 'radar-crypto-score-component-attribution-15m',
    generatedAt: new Date().toISOString(),
    methodology: { researchOnly: true, productionFilesModified: false, horizon: '4h; next candle open entry, open 16 bars later exit', costsBpsRoundTrip: COSTS, scoreFormulaParityCheckedEveryObservation: true, regime: 'EMA50 vs EMA200 with a 1% neutral band', caveat: 'Component grouping is conditional association, not causal contribution. Rows overlap in time and across symbols; metrics are not a portfolio backtest.' },
    configuration: { symbols: SYMBOLS, months: MONTHS, observations: all.length },
    coverage,
    componentConditionalResults: summarizeComponents(all),
    bySymbolAtScore75: SYMBOLS.map(symbol => ({ symbol, at15bps: summarize(all.filter(r => r.symbol === symbol && r.score >= 75), 15), costSensitivity: COSTS.map(cost => ({ costBps: cost, ...summarize(all.filter(r => r.symbol === symbol && r.score >= 75), cost) })) })),
    scoreBucketsAt15bps: buckets.map(b => ({ ...b, ...summarize(all.filter(r => r.score >= b.min && r.score <= b.max), 15), costSensitivity: COSTS.map(cost => ({ costBps: cost, ...summarize(all.filter(r => r.score >= b.min && r.score <= b.max), cost) })) })),
    regimesAtScore75: ['bull', 'sideways', 'bear'].map(regime => ({ regime, at15bps: summarize(all.filter(r => r.regime === regime && r.score >= 75), 15), costSensitivity: COSTS.map(cost => ({ costBps: cost, ...summarize(all.filter(r => r.regime === regime && r.score >= 75), cost) })) })),
    volatilityQuartilesAtScore75: (() => {
      const values = all.filter(r => r.atrPct !== null).map(r => r.atrPct as number).sort((a, b) => a - b)
      const q = (p: number) => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : 0
      const bounds = [q(0.25), q(0.5), q(0.75)]
      return [{ label: 'Q1-low', max: bounds[0] }, { label: 'Q2', min: bounds[0], max: bounds[1] }, { label: 'Q3', min: bounds[1], max: bounds[2] }, { label: 'Q4-high', min: bounds[2] }].map((b, i, a) => {
        const selected = all.filter(r => r.score >= 75 && r.atrPct !== null && (i === 0 ? r.atrPct! <= bounds[0] : i === 3 ? r.atrPct! > bounds[2] : r.atrPct! > (bounds[i - 1]) && r.atrPct! <= bounds[i]))
        return { ...b, ...summarize(selected, 15), costSensitivity: COSTS.map(cost => ({ costBps: cost, ...summarize(selected, cost) })), caveat: 'Full-sample quartiles are descriptive and must not be used as live thresholds.' }
      })
    })(),
  }
  await fs.mkdir(REPORTS, { recursive: true })
  const file = path.join(REPORTS, 'score-component-attribution-15m.json')
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n')
  console.log('[score-components] report=' + file)
}
main().catch(error => { console.error('[score-components] failed:', error); process.exitCode = 1 })
