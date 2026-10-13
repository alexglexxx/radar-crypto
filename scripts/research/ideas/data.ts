import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { TF_MS, type Candle, type FundingPoint, type Timeframe } from './types'

const exec = promisify(execFile)
const BASE = 'https://data.binance.vision/data'

export function monthKeys(startMs: number, endMs: number): string[] {
  const out: string[] = []
  const start = new Date(startMs)
  const end = new Date(endMs)
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cursor <= last) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

async function download(url: string, file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    // not cached yet
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url)
    if (response.status === 404) return false
    if (response.ok) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()))
      return true
    }
    if (attempt === 3) throw new Error(`Binance archive HTTP ${response.status}: ${url}`)
    await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
  }
  return false
}

async function readZip(file: string): Promise<string> {
  const { stdout } = await exec('unzip', ['-p', file], { maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

/** Parses Binance kline CSV text. Handles an optional header row and microsecond timestamps (2025+ spot files). */
export function parseKlinesCsv(text: string): Candle[] {
  const candles: Candle[] = []
  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.split(',')
    if (fields.length < 6) continue
    const raw = Number(fields[0])
    if (!Number.isFinite(raw)) continue // header row
    const openTime = raw > 1e14 ? Math.floor(raw / 1000) : raw
    const [open, high, low, close, volume] = fields.slice(1, 6).map(Number)
    if ([open, high, low, close, volume].every(Number.isFinite)) {
      candles.push({ openTime, open, high, low, close, volume })
    }
  }
  return candles
}

/** Parses Binance futures fundingRate CSV (calc_time, funding_interval_hours, last_funding_rate). */
export function parseFundingCsv(text: string): FundingPoint[] {
  const lines = text.trim().split(/\r?\n/)
  const header = lines[0]?.toLowerCase().split(',') ?? []
  const timeCol = Math.max(0, header.findIndex(h => h.includes('time')))
  const rateCol = header.findIndex(h => h.includes('rate'))
  const points: FundingPoint[] = []
  for (const line of lines) {
    const fields = line.split(',')
    const time = Number(fields[timeCol])
    const rate = Number(fields[rateCol >= 0 ? rateCol : fields.length - 1])
    if (Number.isFinite(time) && Number.isFinite(rate)) points.push({ time: time > 1e14 ? Math.floor(time / 1000) : time, rate })
  }
  return points
}

export async function loadKlines(
  symbol: string,
  timeframe: Timeframe,
  startMs: number,
  endMs: number,
  cacheDir: string,
): Promise<Candle[]> {
  const all: Candle[] = []
  for (const month of monthKeys(startMs, endMs)) {
    const file = path.join(cacheDir, `${symbol}-${timeframe}-${month}.zip`)
    const url = `${BASE}/spot/monthly/klines/${symbol}/${timeframe}/${symbol}-${timeframe}-${month}.zip`
    if (await download(url, file)) all.push(...parseKlinesCsv(await readZip(file)))
  }
  return all.filter(c => c.openTime >= startMs && c.openTime <= endMs).sort((a, b) => a.openTime - b.openTime)
}

export async function loadFunding(symbol: string, startMs: number, endMs: number, cacheDir: string): Promise<FundingPoint[]> {
  const all: FundingPoint[] = []
  for (const month of monthKeys(startMs, endMs)) {
    const file = path.join(cacheDir, `${symbol}-funding-${month}.zip`)
    const url = `${BASE}/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`
    if (await download(url, file)) all.push(...parseFundingCsv(await readZip(file)))
  }
  return all.filter(p => p.time >= startMs && p.time <= endMs).sort((a, b) => a.time - b.time)
}

/** Refuses partial data: every expected candle must exist, in order, with sane OHLC values. */
export function validateCandles(symbol: string, candles: Candle[], startMs: number, endMs: number, timeframe: Timeframe): void {
  const step = TF_MS[timeframe]
  const expected = Math.floor((endMs - startMs) / step) + 1
  if (candles.length !== expected) {
    throw new Error(`Coverage failure ${symbol} ${timeframe}: ${candles.length}/${expected} candles. Refusing partial-data research.`)
  }
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const sane =
      c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.volume >= 0 &&
      c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high)
    if (!sane) throw new Error(`Invalid OHLCV ${symbol} ${timeframe} at ${new Date(c.openTime).toISOString()}`)
    if (i > 0 && c.openTime - candles[i - 1].openTime !== step) {
      throw new Error(`Gap/duplicate ${symbol} ${timeframe} at ${new Date(c.openTime).toISOString()}`)
    }
  }
}
