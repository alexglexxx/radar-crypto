import { calculateFeatures, type Candle } from './features'
import { calculateRadarScore } from './scoring'
import { measureOutcome } from './outcomes'

// Input policy of v1.1-live, not strategy tuning. Binance's limit includes
// the open candle; normally only 249 of the 250 returned rows are closed.
export const LIVE_HISTORY_LIMIT = 250
export const BAR_MS = 900_000
export const CLOSE_MARGIN_MS = 1000
export const candleCloseTime = (c: Candle) => c.openTime + BAR_MS - 1

export function replayLiveOutcome(archive: Candle[], signalIndex: number, bars: number) {
  const candle = archive[signalIndex]
  return measureOutcome(candleCloseTime(candle), candle.close, bars * BAR_MS,
    archive.slice(signalIndex + 1, signalIndex + bars + 1).map(c => ({
      source_timestamp: new Date(candleCloseTime(c)).toISOString(), close: c.close, high: c.high, low: c.low,
    })))
}

export function closedCandles<T extends { closeTime: number }>(rows: T[], now: number): T[] {
  return rows.filter(c => c.closeTime < now - CLOSE_MARGIN_MS)
}

// Archive must be sorted. The open row reserves a response slot but its final
// OHLC is never read by the strategy. Explicit asOf permits boundary replay.
export function replayLiveSignal(archive: Candle[], asOf: number) {
  let lo = 0, hi = archive.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (archive[mid].openTime <= asOf) lo = mid + 1
    else hi = mid
  }
  const response = archive.slice(Math.max(0, lo - LIVE_HISTORY_LIMIT), lo)
  const window = closedCandles(response.map(c => ({ ...c, closeTime: candleCloseTime(c) })), asOf)
  if (window.length < 200) return null
  const last = window[window.length - 1]
  if (asOf - last.closeTime > 20 * 60 * 1000) return null
  for (let i = 0; i < window.length; i++) {
    const c = window[i]
    if (c.openTime % BAR_MS !== 0 || (i > 0 && c.openTime - window[i - 1].openTime !== BAR_MS) ||
      ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
      Math.min(c.open, c.high, c.low, c.close) <= 0 || c.volume < 0 ||
      c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) return null
  }
  const features = calculateFeatures(window)
  const { score, status } = calculateRadarScore(features)
  return { features, score, status, decision: status === 'SETUP LONG' ? 'LONG' : 'WAIT',
    sampleSize: window.length, entryPrice: last.close, signalTimestamp: last.closeTime }
}
