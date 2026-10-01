import fs from 'node:fs/promises'
import path from 'node:path'
import { calculateFeatures, type Candle } from '../lib/features'
import { calculateRadarScore } from '../lib/scoring'

type Kline = [number, string, string, string, string, string, number, string, number, string, string, string]

type Trade = {
  symbol: string
  entryTime: string
  entryPrice: number
  score: number
  decision: string
  returns: Record<string, number | null>
  netReturns: Record<string, number | null>
}

const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(s => s.trim()).filter(Boolean)
const INTERVAL = '15m'
const MONTHS = Number(process.env.MONTHS ?? 36)
const FEE_BPS = Number(process.env.FEE_BPS ?? 10)
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 5)
const START = process.env.START ? new Date(process.env.START) : new Date(Date.now() - MONTHS * 30.4375 * 86400000)
const END = process.env.END ? new Date(process.env.END) : new Date()
const DATA_DIR = path.join(process.cwd(), '.backtest-cache')
const OUT_DIR = path.join(process.cwd(), 'backtest-results')

function monthKeys(start: Date, end: Date) {
  const out: string[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const finish = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cursor <= finish) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

async function downloadMonth(symbol: string, month: string) {
  const file = path.join(DATA_DIR, `${symbol}-${INTERVAL}-${month}.zip`)
  try { await fs.access(file); return file } catch {}
  const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/${INTERVAL}/${symbol}-${INTERVAL}-${month}.zip`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Binance archive ${response.status}: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(file, bytes)
  return file
}

async function unzipCsv(zipFile: string, symbol: string, month: string): Promise<Candle[]> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const temp = path.join(DATA_DIR, `${symbol}-${month}`)
  await fs.mkdir(temp, { recursive: true })
  await exec('unzip', ['-oq', zipFile, '-d', temp])
  const files = (await fs.readdir(temp)).filter(f => f.endsWith('.csv'))
  if (!files.length) throw new Error(`No CSV inside ${zipFile}`)
  const csv = await fs.readFile(path.join(temp, files[0]), 'utf8')
  const rows = csv.trim().split(/\r?\n/)
  const first = rows[0].toLowerCase().includes('open time') ? 1 : 0
  const candles: Candle[] = []
  for (let i = first; i < rows.length; i++) {
    const p = rows[i].split(',')
    if (p.length < 6) continue
    const openTime = Number(p[0])
    const open = Number(p[1])
    const high = Number(p[2])
    const low = Number(p[3])
    const close = Number(p[4])
    const volume = Number(p[5])
    if ([openTime, open, high, low, close, volume].every(Number.isFinite)) candles.push({ openTime, open, high, low, close, volume })
  }
  return candles
}

async function loadSymbol(symbol: string) {
  const candles: Candle[] = []
  for (const month of monthKeys(START, END)) {
    const zip = await downloadMonth(symbol, month)
    candles.push(...await unzipCsv(zip, symbol, month))
  }
  const from = START.getTime() - 250 * 15 * 60000
  return candles.filter(c => c.openTime >= from && c.openTime <= END.getTime()).sort((a, b) => a.openTime - b.openTime)
}

function net(ret: number) {
  const cost = (FEE_BPS + SLIPPAGE_BPS) / 10000
  return ret - cost
}

function summarize(trades: Trade[], horizon: string) {
  const values = trades.map(t => t.netReturns[horizon]).filter((v): v is number => v !== null)
  const wins = values.filter(v => v > 0).length
  const losses = values.filter(v => v < 0).length
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const gross = values.reduce((a, b) => a + b, 0)
  return {
    horizon,
    trades: values.length,
    wins,
    losses,
    winRate: values.length ? wins / values.length : 0,
    averageReturn: avg,
    totalSimpleReturn: gross,
    medianReturn: values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0,
  }
}

async function main() {
  const allTrades: Trade[] = []
  for (const symbol of SYMBOLS) {
    console.log(`Loading ${symbol} ${START.toISOString()} → ${END.toISOString()}`)
    const candles = await loadSymbol(symbol)
    console.log(`${symbol}: ${candles.length.toLocaleString()} candles`)

    for (let i = 200; i < candles.length - 16; i++) {
      const candle = candles[i]
      if (candle.openTime < START.getTime()) continue
      const features = calculateFeatures(candles.slice(0, i + 1))
      const signal = calculateRadarScore(features)
      if (signal.status !== 'SETUP LONG') continue

      const future = {
        '15m': candles[i + 1]?.close ?? null,
        '1h': candles[i + 4]?.close ?? null,
        '4h': candles[i + 16]?.close ?? null,
      }
      const returns: Record<string, number | null> = {}
      const netReturns: Record<string, number | null> = {}
      for (const [h, price] of Object.entries(future)) {
        returns[h] = price === null ? null : (price - candle.close) / candle.close
        netReturns[h] = returns[h] === null ? null : net(returns[h] as number)
      }
      allTrades.push({
        symbol,
        entryTime: new Date(candle.openTime).toISOString(),
        entryPrice: candle.close,
        score: signal.score,
        decision: 'LONG',
        returns,
        netReturns,
      })
    }
  }

  const splits = [
    { name: 'development', from: START, to: new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.6666667) },
    { name: 'validation', from: new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.6666667), to: new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.8333333) },
    { name: 'out_of_sample', from: new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.8333333), to: END },
  ]

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: 'No-lookahead 15m close-to-close backtest using the exact production feature and scoring functions.',
    symbols: SYMBOLS,
    interval: INTERVAL,
    start: START.toISOString(),
    end: END.toISOString(),
    feesBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    longThreshold: 75,
    totalSignals: allTrades.length,
    summary: ['15m', '1h', '4h'].map(h => summarize(allTrades, h)),
    bySymbol: SYMBOLS.map(symbol => ({ symbol, signals: allTrades.filter(t => t.symbol === symbol).length, summary: ['15m', '1h', '4h'].map(h => summarize(allTrades.filter(t => t.symbol === symbol), h)) })),
    bySplit: splits.map(split => {
      const trades = allTrades.filter(t => { const d = new Date(t.entryTime); return d >= split.from && d < split.to })
      return { name: split.name, from: split.from.toISOString(), to: split.to.toISOString(), signals: trades.length, summary: ['15m', '1h', '4h'].map(h => summarize(trades, h)) }
    }),
  }

  await fs.mkdir(OUT_DIR, { recursive: true })
  await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  await fs.writeFile(path.join(OUT_DIR, 'trades.json'), JSON.stringify(allTrades, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch(error => { console.error(error); process.exit(1) })
