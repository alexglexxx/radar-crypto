import { describe, expect, it } from 'vitest'
import { BAR_MS, circularPValue, tradeReturn, validateSnapshots } from '../scripts/research/live-baseline-core'
import { prefixDifferences } from '../scripts/research/prefix-audit'
import { replayLiveSignal } from '../lib/live-window'
import { assertHistoricalCoverage } from '../scripts/research/historical-coverage'

describe('research audit controls', () => {
  const rows = Array.from({ length: 300 }, (_, i) => {
    const close = 100 + i * 0.1
    return { symbol: 'BTCUSDT', source_timestamp: new Date((i + 1) * BAR_MS - 1).toISOString(),
      open: close - 0.05, high: close + 0.2, low: close - 0.2, close, volume: 10 }
  })

  it('rejects missing and duplicate candles before publishing metrics', () => {
    const from = BAR_MS - 1, to = 300 * BAR_MS - 1
    expect(validateSnapshots(rows, 'BTCUSDT', from, to)).toHaveLength(300)
    expect(() => validateSnapshots(rows.filter((_, i) => i !== 100), 'BTCUSDT', from, to)).toThrow(/coverage/)
    expect(() => validateSnapshots(rows.map((r, i) => i === 100 ? { ...r, source_timestamp: rows[99].source_timestamp } : r),
      'BTCUSDT', from, to)).toThrow(/duplicate/)
  })

  it('rejects an incomplete historical archive, including an interior duplicate', () => {
    const candles = rows.map((r, i) => ({ openTime: i * BAR_MS, open: r.open,
      high: r.high, low: r.low, close: r.close, volume: r.volume }))
    expect(() => assertHistoricalCoverage(candles, 'BTCUSDT', 0, 300 * BAR_MS - 1)).not.toThrow()
    expect(() => assertHistoricalCoverage(candles.slice(0, -1), 'BTCUSDT', 0, 300 * BAR_MS - 1)).toThrow(/coverage/)
    const duplicate = candles.map((c, i) => i === 100 ? { ...c, openTime: candles[99].openTime } : c)
    expect(() => assertHistoricalCoverage(duplicate, 'BTCUSDT', 0, 300 * BAR_MS - 1)).toThrow(/duplicate/)
  })

  it('uses the next opening price after the signal and a later opening exit', () => {
    const candles = validateSnapshots(rows, 'BTCUSDT', BAR_MS - 1, 300 * BAR_MS - 1)
    const close = tradeReturn(candles, 250, 4, 'close')
    const nextOpen = tradeReturn(candles, 250, 4, 'next_open')
    expect(close).toBe((candles[254].close - candles[250].close) / candles[250].close)
    expect(nextOpen).toBe((candles[255].open - candles[251].open) / candles[251].open)
    expect(nextOpen).not.toBe(close)
  })

  it('detects future leakage and accepts the production replay on the same prefixes', () => {
    const candles = validateSnapshots(rows, 'BTCUSDT', BAR_MS - 1, 300 * BAR_MS - 1)
      .map(c => ({ openTime: c.time - BAR_MS + 1, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume }))
    const positions = [251, 260, 275]
    expect(prefixDifferences(candles, positions)).toEqual([])
    expect(prefixDifferences(candles, positions, (archive, asOf) => ({
      signal: replayLiveSignal(archive, asOf), future: archive.at(-1)?.close,
    }))).toEqual(positions)
  })

  it('keeps clustered signals together under the shared circular null', () => {
    const positions = new Map([['BTCUSDT', [1, 2]]])
    const returns = new Map([['BTCUSDT', [0, 0.1, 0.2, -0.1]]])
    const p = circularPValue(0.15, 0.05, positions, returns, 100, 7)
    expect(p.one_sided_underperformance).toBeGreaterThan(0)
    expect(p.two_sided).toBeLessThanOrEqual(1)
  })
})
