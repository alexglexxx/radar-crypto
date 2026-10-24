import path from 'node:path'
import { fetchArchiveZip, monthKeys, type ArchiveFile } from './binance-archive'

const BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/fundingRate'
const HOUR_MS = 3600000

export type FundingPoint = { calcTime: number; intervalHours: number; rate: number }

// Every data row must parse; the header line is optional.
export function parseFundingCsv(csv: string, label: string): FundingPoint[] {
  const lines = csv.trim().split(/\r?\n/)
  const startIndex = /[a-z]/i.test(lines[0]?.[0] ?? '') ? 1 : 0
  return lines.slice(startIndex).map((line, offset) => {
    const [calcTime, intervalHours, rate] = line.split(',').map(Number)
    if (![calcTime, intervalHours, rate].every(Number.isFinite)) {
      throw new Error(`${label}: unparseable funding row ${startIndex + offset + 1}`)
    }
    return { calcTime, intervalHours, rate }
  })
}

// Settlements must be strictly increasing; a gap is more than 1.5x the longer interval.
export function assertFundingContinuity(points: FundingPoint[], symbol: string): void {
  let gaps = 0
  let firstAfter = NaN
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (b.calcTime <= a.calcTime) {
      throw new Error(`${symbol}: unsorted or duplicate funding settlement at ${new Date(b.calcTime).toISOString()}`)
    }
    if (b.calcTime - a.calcTime > 1.5 * Math.max(a.intervalHours, b.intervalHours) * HOUR_MS) {
      if (gaps === 0) firstAfter = a.calcTime
      gaps++
    }
  }
  if (gaps > 0) throw new Error(`${symbol}: ${gaps} funding gaps, first after ${new Date(firstAfter).toISOString()}`)
}

// Index of the last settlement with calcTime <= t, or -1.
export function fundingIndexAt(points: FundingPoint[], t: number): number {
  let lo = 0
  let hi = points.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].calcTime <= t) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

export async function loadArchivedFunding(symbol: string, startMs: number, endMs: number,
  { cacheDir = path.join(process.cwd(), '.backtest-cache') } = {}): Promise<{ points: FundingPoint[]; manifest: ArchiveFile[] }> {
  const all: FundingPoint[] = []
  const manifest: ArchiveFile[] = []
  for (const month of monthKeys(startMs, endMs)) {
    const name = `${symbol}-fundingRate-${month}`
    const url = `${BASE_URL}/${symbol}/${name}.zip`
    const zip = await fetchArchiveZip(url, path.join(cacheDir, `${name}.zip`), name)
    const points = parseFundingCsv(zip.text, name)
    all.push(...points)
    manifest.push({ symbol, month, url, sha256: zip.sha256, bytes: zip.bytes, rows: points.length,
      first_open: new Date(points[0]?.calcTime ?? NaN).toISOString(),
      last_open: new Date(points[points.length - 1]?.calcTime ?? NaN).toISOString() })
  }
  const points = all.filter(p => p.calcTime >= startMs && p.calcTime <= endMs).sort((a, b) => a.calcTime - b.calcTime)
  assertFundingContinuity(points, symbol)
  return { points, manifest }
}
