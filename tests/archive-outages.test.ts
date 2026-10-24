import { describe, expect, it } from 'vitest'
import { BAR_MS } from '../scripts/research/live-baseline-core'
import { assertHistoricalCoverage, findOutages } from '../scripts/research/historical-coverage'

const grid = (n: number) => Array.from({ length: n }, (_, i) => ({
  openTime: i * BAR_MS, open: 100, high: 101, low: 99, close: 100, volume: 5 }))
const END = 300 * BAR_MS - 1

describe('findOutages', () => {
  it('reports a gap up to the limit as an outage', () => {
    const candles = grid(300).filter((_, i) => i < 100 || i >= 118)
    expect(findOutages(candles, 'BTCUSDT', 0, END, 24))
      .toEqual([{ from: new Date(100 * BAR_MS).toISOString(), to: new Date(117 * BAR_MS).toISOString(), bars: 18 }])
  })

  it('returns no outages for a complete grid and groups separate gaps', () => {
    expect(findOutages(grid(300), 'BTCUSDT', 0, END, 24)).toEqual([])
    const candles = grid(300).filter((_, i) => ![10, 11, 50].includes(i))
    expect(findOutages(candles, 'BTCUSDT', 0, END, 24).map(o => o.bars)).toEqual([2, 1])
  })

  it('rejects a gap longer than the limit', () => {
    const candles = grid(300).filter((_, i) => i < 100 || i >= 125)
    expect(() => findOutages(candles, 'BTCUSDT', 0, END, 24)).toThrow(/25 candles/)
  })

  it('rejects a missing first or last candle', () => {
    expect(() => findOutages(grid(300).slice(1), 'BTCUSDT', 0, END, 24)).toThrow(/edge/)
    expect(() => findOutages(grid(300).slice(0, -1), 'BTCUSDT', 0, END, 24)).toThrow(/edge/)
  })

  it('rejects duplicates, off-grid times and invalid OHLCV', () => {
    const dup = grid(300); dup[5] = dup[4]
    expect(() => findOutages(dup, 'BTCUSDT', 0, END, 24)).toThrow(/duplicate|grid/)
    const off = grid(300); off[5] = { ...off[5], openTime: off[5].openTime + 1 }
    expect(() => findOutages(off, 'BTCUSDT', 0, END, 24)).toThrow(/duplicate|grid/)
    const bad = grid(300); bad[5] = { ...bad[5], high: 98 }
    expect(() => findOutages(bad, 'BTCUSDT', 0, END, 24)).toThrow(/invalid/)
  })

  it('keeps assertHistoricalCoverage strict', () => {
    const candles = grid(300).filter((_, i) => i < 100 || i >= 118)
    expect(() => assertHistoricalCoverage(candles, 'BTCUSDT', 0, END)).toThrow(/coverage/)
  })
})
