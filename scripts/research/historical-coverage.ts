import { BAR_MS } from './live-baseline-core'

type HistoricalCandle = {
  openTime: number; open: number; high: number; low: number; close: number; volume: number
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
    if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
      Math.min(candle.open, candle.high, candle.low, candle.close) <= 0 || candle.volume < 0 ||
      candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
      throw new Error(`${symbol}: invalid historical OHLCV at ${new Date(candle.openTime).toISOString()}`)
    }
  }
}
