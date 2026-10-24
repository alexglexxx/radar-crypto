import { describe, expect, it } from 'vitest'
import { fmtPct, priceWindowSummary } from '../lib/price-window'

describe('price window summary', () => {
  it('reports change from first to last price and the range', () => {
    const summary = priceWindowSummary([100, 98, 103, 101])
    expect(summary).toEqual({ count: 4, changePct: 1, min: 98, max: 103 })
  })

  it('ignores invalid prices and needs two points', () => {
    expect(priceWindowSummary([NaN, 0, 50])).toBeNull()
    expect(priceWindowSummary([NaN, 50, 45])?.changePct).toBeCloseTo(-10)
  })

  it('formats signed percentages', () => {
    expect(fmtPct(0.4213)).toBe('+0.42 %')
    expect(fmtPct(-1.5)).toBe('−1.50 %')
    expect(fmtPct(0)).toBe('0.00 %')
  })
})
