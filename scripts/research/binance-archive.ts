import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { type Candle } from '../../lib/features'
import { assertHistoricalCoverage } from './historical-coverage'

const exec = promisify(execFile)
const BASE_URL = 'https://data.binance.vision/data/spot/monthly/klines'

export type ArchiveFile = {
  symbol: string; month: string; url: string; sha256: string; bytes: number
  rows: number; first_open: string; last_open: string
}

export function monthKeys(startMs: number, endMs: number): string[] {
  const output: string[] = []
  const cursor = new Date(Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1))
  const finish = Date.UTC(new Date(endMs).getUTCFullYear(), new Date(endMs).getUTCMonth(), 1)
  while (cursor.getTime() <= finish) {
    output.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return output
}

// Monthly archives exist only for finished months: end before the current UTC month.
export function completedMonthsWindow(months: number, now = Date.now()) {
  const current = new Date(now)
  const endMs = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1) - 1
  const startMs = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - months, 1)
  return { startMs, endMs }
}

// Every data row must parse; a silently dropped row would surface only as an
// unexplained coverage failure. Binance switched open times to microseconds in 2025.
export function parseKlineCsv(csv: string, label: string): Candle[] {
  const lines = csv.trim().split(/\r?\n/)
  const startIndex = lines[0]?.toLowerCase().includes('open') && /[a-z]/i.test(lines[0][0]) ? 1 : 0
  return lines.slice(startIndex).map((line, offset) => {
    const [openTimeRaw, open, high, low, close, volume] = line.split(',').map(Number)
    const openTime = openTimeRaw > 1e14 ? Math.floor(openTimeRaw / 1000) : openTimeRaw
    if (![openTime, open, high, low, close, volume].every(Number.isFinite)) {
      throw new Error(`${label}: unparseable kline row ${startIndex + offset + 1}`)
    }
    return { openTime, open, high, low, close, volume }
  })
}

async function readMonth(symbol: string, interval: string, month: string, cacheDir: string) {
  const name = `${symbol}-${interval}-${month}`
  const url = `${BASE_URL}/${symbol}/${interval}/${name}.zip`
  const file = path.join(cacheDir, `${name}.zip`)
  let bytes: Buffer
  try {
    bytes = await fs.readFile(file)
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (response.status === 404) throw new Error(`Binance archive unavailable for ${name}; refusing incomplete backtest`)
    if (!response.ok) throw new Error(`Binance archive HTTP ${response.status}: ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(file, bytes)
  }
  const { stdout } = await exec('unzip', ['-p', file], { maxBuffer: 64 * 1024 * 1024 })
  const candles = parseKlineCsv(stdout, name)
  const entry: ArchiveFile = { symbol, month, url, sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, rows: candles.length,
    first_open: new Date(candles[0]?.openTime ?? NaN).toISOString(),
    last_open: new Date(candles[candles.length - 1]?.openTime ?? NaN).toISOString() }
  return { candles, entry }
}

// Loads [startMs, endMs] by candle open time and aborts unless every candle is present and valid.
export async function loadArchivedCandles(symbol: string, startMs: number, endMs: number,
  { interval = '15m', cacheDir = path.join(process.cwd(), '.backtest-cache') } = {}) {
  const candles: Candle[] = []
  const manifest: ArchiveFile[] = []
  for (const month of monthKeys(startMs, endMs)) {
    const result = await readMonth(symbol, interval, month, cacheDir)
    candles.push(...result.candles)
    manifest.push(result.entry)
  }
  const selected = candles.filter(c => c.openTime >= startMs && c.openTime <= endMs)
    .sort((a, b) => a.openTime - b.openTime)
  assertHistoricalCoverage(selected, symbol, startMs, endMs)
  return { candles: selected, manifest }
}
