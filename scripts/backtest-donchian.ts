import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }
type Trade = { symbol: string; entryTime: number; exitTime: number; entry: number; exit: number; grossReturn: number; netReturn: number; barsHeld: number; exitReason: 'channel_exit' | 'period_end_mark' }
const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(x => x.trim()).filter(Boolean)
const MONTHS = Math.max(24, Number(process.env.MONTHS ?? 24))
const INTERVAL = '1h'
const COSTS_BPS = [15, 20, 25]
const DATA_DIR = path.join(process.cwd(), '.backtest-cache-discovery')
const REPORT_DIR = path.join(process.cwd(), 'reports')

function monthKeys(a: Date, b: Date) {
  const out: string[] = []
  const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1))
  const e = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 1))
  while (d <= e) { out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')); d.setUTCMonth(d.getUTCMonth() + 1) }
  return out
}
async function download(symbol: string, month: string) {
  const file = path.join(DATA_DIR, symbol + '-' + INTERVAL + '-' + month + '.zip')
  try { await fs.access(file); return file } catch {}
  const url = 'https://data.binance.vision/data/spot/monthly/klines/' + symbol + '/' + INTERVAL + '/' + symbol + '-' + INTERVAL + '-' + month + '.zip'
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
  await exec('unzip', ['-oq', file, '-d', dir])
  const name = (await fs.readdir(dir)).find(x => x.endsWith('.csv'))
  if (!name) throw new Error('No CSV in ' + file)
  const lines = (await fs.readFile(path.join(dir, name), 'utf8')).trim().split(/\r?\n/)
  const start = lines[0]?.toLowerCase().includes('open time') ? 1 : 0
  const out: Candle[] = []
  for (let i = start; i < lines.length; i++) {
    const row = lines[i].split(',')
    if (row.length < 6) continue
    const raw = Number(row[0]), time = raw > 1e14 ? Math.floor(raw / 1000) : raw
    const [open, high, low, close, volume] = row.slice(1, 6).map(Number)
    if ([time, open, high, low, close, volume].every(Number.isFinite) && open > 0 && high > 0 && low > 0 && close > 0) out.push({ time, open, high, low, close, volume })
  }
  await fs.rm(dir, { recursive: true, force: true })
  return out
}
async function load(symbol: string, start: number, end: number) {
  const rows: Candle[] = []
  for (const month of monthKeys(new Date(start), new Date(end))) {
    const file = await download(symbol, month)
    if (file) rows.push(...await unzip(file))
  }
  const unique = new Map<number, Candle>()
  for (const c of rows) if (c.time >= start - 100 * 3600000 && c.time < end) unique.set(c.time, c)
  return [...unique.values()].sort((a, b) => a.time - b.time)
}
function channelHigh(c: Candle[], i: number, n: number) {
  let value = -Infinity
  for (let j = i - n; j < i; j++) value = Math.max(value, c[j].high)
  return value
}
function channelLow(c: Candle[], i: number, n: number) {
  let value = Infinity
  for (let j = i - n; j < i; j++) value = Math.min(value, c[j].low)
  return value
}
function simulate(symbol: string, candles: Candle[], start: number, end: number, entryN: number, exitN: number, costBps: number): { trades: Trade[]; openAtPeriodEnd: number } {
  const trades: Trade[] = []
  let entryIndex = -1
  let entryPrice = 0
  let entryTime = 0
  const warmup = Math.max(entryN, exitN)
  for (let i = warmup; i < candles.length - 1; i++) {
    const c = candles[i]
    const next = candles[i + 1]
    if (c.time < start || c.time >= end) continue
    if (entryIndex < 0) {
      // Signal uses only completed candle i and the prior N candles; fill at next candle open.
      if (c.close > channelHigh(candles, i, entryN) && next.time < end) {
        entryIndex = i + 1
        entryPrice = next.open
        entryTime = next.time
      }
    } else if (c.close < channelLow(candles, i, exitN)) {
      // Exit signal on close i; fill at next open. Do not carry positions across OOS fold boundary.
      if (next.time < end && next.time > entryTime) {
        const grossReturn = next.open / entryPrice - 1
        trades.push({ symbol, entryTime, exitTime: next.time, entry: entryPrice, exit: next.open, grossReturn, netReturn: grossReturn - costBps / 10000, barsHeld: i + 1 - entryIndex, exitReason: 'channel_exit' })
      }
      entryIndex = -1
      entryPrice = 0
      entryTime = 0
    }
  }
  // Mark any remaining position to market at the final candle close within the test window.
  // This is not a channel-triggered exit; it prevents silently dropping end-of-window exposure.
  let openAtPeriodEnd = 0
  if (entryIndex >= 0) {
    const last = [...candles].reverse().find(x => x.time >= entryTime && x.time < end)
    if (last) {
      const grossReturn = last.close / entryPrice - 1
      trades.push({ symbol, entryTime, exitTime: last.time, entry: entryPrice, exit: last.close, grossReturn, netReturn: grossReturn - costBps / 10000, barsHeld: Math.max(1, Math.round((last.time - entryTime) / 3600000)), exitReason: 'period_end_mark' })
      openAtPeriodEnd = 1
    }
  }
  return { trades, openAtPeriodEnd }
}
function stats(trades: Trade[]) {
  let sum = 0, wins = 0, profit = 0, loss = 0
  for (const t of trades) {
    const r = t.netReturn
    sum += r
    if (r > 0) { wins++; profit += r } else loss += -r
  }
  const n = trades.length
  return { trades: n, winRate: n ? wins / n : null, expectancy: n ? sum / n : null, profitFactor: loss ? profit / loss : null, sumOfTradeReturns_notPortfolioReturn: sum, periodEndMarkedTrades: trades.filter(t => t.exitReason === 'period_end_mark').length, averageBarsHeld: n ? trades.reduce((a, t) => a + t.barsHeld, 0) / n : null }
}
function fmt(x: number | null) { return x === null ? 'N/A' : (x * 100).toFixed(3) + '%' }

async function main() {
  const now = new Date()
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS, 1)
  const datasets = new Map<string, Candle[]>()
  const coverage: any[] = []
  for (const symbol of SYMBOLS) {
    const c = await load(symbol, start, end)
    const actual = c.filter(x => x.time >= start && x.time < end)
    const expected = Math.floor((end - start) / 3600000)
    const times = new Set(actual.map(x => x.time))
    let gaps = 0
    for (let t = start; t < end; t += 3600000) if (!times.has(t)) gaps++
    coverage.push({ symbol, expected, actual: actual.length, missingHours: gaps, duplicateTimesRemoved: c.length - new Set(c.map(x => x.time)).size })
    if (actual.length < expected * 0.98 || gaps > expected * 0.02) throw new Error('Coverage failure for ' + symbol + ': ' + actual.length + '/' + expected + ', missing=' + gaps)
    datasets.set(symbol, c)
  }
  // Four chronological OOS quarters. All trade entry/exit fills must occur inside each test quarter.
  const folds = [
    ['2024-10-01', '2025-10-01', '2025-10-01', '2026-01-01'],
    ['2025-01-01', '2026-01-01', '2026-01-01', '2026-04-01'],
    ['2025-04-01', '2026-04-01', '2026-04-01', '2026-07-01'],
    ['2025-07-01', '2026-07-01', '2026-07-01', '2026-10-01']
  ]
  const configs = [{ name: 'donchian_20_10', entry: 20, exit: 10 }, { name: 'donchian_55_20', entry: 55, exit: 20 }]
  const results: any[] = []
  for (const config of configs) {
    const foldResults: any[] = []
    for (let k = 0; k < folds.length; k++) {
      const [tr0, tr1, te0, te1] = folds[k]
      const testStart = Date.parse(te0 + 'T00:00:00Z'), testEnd = Date.parse(te1 + 'T00:00:00Z')
      const perSymbol: any[] = []
      const trades: Trade[] = []
      let openAtPeriodEnd = 0
      for (const [symbol, candles] of datasets) {
        const sim = simulate(symbol, candles, testStart, testEnd, config.entry, config.exit, 15)
        trades.push(...sim.trades)
        openAtPeriodEnd += sim.openAtPeriodEnd
        perSymbol.push({ symbol, ...stats(sim.trades), openPositionsMarkedAtPeriodEnd: sim.openAtPeriodEnd })
      }
      const sensitivity = COSTS_BPS.map(bps => {
        const rows: Trade[] = []
        for (const [symbol, candles] of datasets) rows.push(...simulate(symbol, candles, testStart, testEnd, config.entry, config.exit, bps).trades)
        return { roundTripCostBps: bps, ...stats(rows) }
      })
      foldResults.push({ fold: k + 1, train: tr0 + '..' + tr1, test: te0 + '..' + te1, testStats: stats(trades), openPositionsMarkedAtPeriodEnd: openAtPeriodEnd, perSymbol, costSensitivity: sensitivity })
      console.log('[donchian] ' + config.name + ' fold ' + (k + 1) + ' trades=' + trades.length + ' expectancy=' + fmt(stats(trades).expectancy) + ' end-marked=' + openAtPeriodEnd)
    }
    const expectancy = foldResults.map((f: any) => f.testStats.expectancy)
    results.push({ ...config, folds: foldResults, summary: { positiveOosFolds: foldResults.filter((f: any) => (f.testStats.expectancy ?? -1) > 0).length, folds: foldResults.length, oosExpectancies: expectancy, totalTrades: foldResults.reduce((n: number, f: any) => n + f.testStats.trades, 0), note: 'Fixed, predeclared parameters; no threshold optimization. Per-symbol stats are reported to expose concentration risk.' } })
  }
  const report = { reportName: 'radar-crypto-donchian-breakout-1h', generatedAt: new Date().toISOString(), productionUntouched: true, notDeployable: true, methodology: { interval: '1h', signals: 'Long-only close breakout above prior N-bar high; enter at next candle open. Exit when close falls below prior M-bar low; exit next candle open.', configurations: configs, costsBpsRoundTrip: COSTS_BPS, costsInclude: 'Combined fee and slippage assumption; sensitivity at 15, 20, and 25 bps per round trip.', folds: 'Four fixed chronological OOS quarters; positions still open at period end are marked to the final in-window close and explicitly counted. Channel values exclude current candle. No parameter selection on OOS. Pooled sum of trade returns is not portfolio return; capital-weighted portfolio equity/drawdown are intentionally not claimed in this report.', risk: 'Spot long-only proxy; ignores partial fills, spread variation, latency, exchange outages, taxes, and market impact. No leverage. Research only.' }, coverage, strategies: results }
  await fs.mkdir(REPORT_DIR, { recursive: true })
  await fs.writeFile(path.join(REPORT_DIR, 'backtest-donchian-1h.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('[donchian] report saved: reports/backtest-donchian-1h.json')
}
main().catch(error => { console.error('[donchian] fatal:', error); process.exit(1) })
