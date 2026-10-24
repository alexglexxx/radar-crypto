import { BAR_MS } from './live-baseline-core'

export type HistoricalCandle = {
  openTime: number; open: number; high: number; low: number; close: number; volume: number
}

function assertValidCandle(candle: HistoricalCandle, symbol: string) {
  if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
    Math.min(candle.open, candle.high, candle.low, candle.close) <= 0 || candle.volume < 0 ||
    candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
    throw new Error(`${symbol}: invalid historical OHLCV at ${new Date(candle.openTime).toISOString()}`)
  }
}

export function assertHistoricalCoverage(candles: HistoricalCandle[], symbol: string, startMs: number, endMs: number) {
  const first = Math.ceil(startMs / BAR_MS) * BAR_MS
  const last = Math.floor(endMs / BAR_MS) * BAR_MS
  const expected = Math.max(0, (last - first) / BAR_MS + 1)
  if (candles.length !== expected) {
    throw new Error(`${symbol}: historical coverage ${candles.length}/${expected} candles from ${new Date(first).toISOString()} to ${new Date(last).toISOString()}`)
  }
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    if (candle.openTime !== first + i * BAR_MS) {
      throw new Error(`${symbol}: duplicate or missing historical candle at index ${i}`)
    }
    assertValidCandle(candle, symbol)
  }
}

export type Outage = { from: string; to: string; bars: number }

// Tolerates runs of missing candles up to maxOutageBars (exchange outages) and reports them;
// the window edges, grid alignment, ordering and OHLCV must still be exact.
export function findOutages(candles: HistoricalCandle[], symbol: string, startMs: number, endMs: number, maxOutageBars: number): Outage[] {
  const first = Math.ceil(startMs / BAR_MS) * BAR_MS
  const last = Math.floor(endMs / BAR_MS) * BAR_MS
  if (candles[0]?.openTime !== first || candles[candles.length - 1].openTime !== last) {
    throw new Error(`${symbol}: historical window edge candle missing from ${new Date(first).toISOString()} to ${new Date(last).toISOString()}`)
  }
  const outages: Outage[] = []
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    if (candle.openTime % BAR_MS !== 0) {
      throw new Error(`${symbol}: historical candle off the 15m grid at ${new Date(candle.openTime).toISOString()}`)
    }
    assertValidCandle(candle, symbol)
    if (i === 0) continue
    const previous = candles[i - 1].openTime
    if (candle.openTime <= previous) {
      throw new Error(`${symbol}: duplicate or unordered historical candle at index ${i}`)
    }
    const missing = (candle.openTime - previous) / BAR_MS - 1
    if (missing > maxOutageBars) {
      throw new Error(`${symbol}: ${missing} candles missing from ${new Date(previous + BAR_MS).toISOString()}, above the ${maxOutageBars} limit`)
    }
    if (missing > 0) {
      outages.push({ from: new Date(previous + BAR_MS).toISOString(), to: new Date(candle.openTime - BAR_MS).toISOString(), bars: missing })
    }
  }
  return outages
}
