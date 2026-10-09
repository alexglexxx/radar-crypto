import { describe, expect, it } from 'vitest'
import { calculateFeatures, type Candle, type FeatureSet } from '../../lib/features'
import { calculateFeatureSeries } from './production-features'

function syntheticCandles(count: number): Candle[] {
  const candles: Candle[] = []
  let previous = 100
  for (let i = 0; i < count; i++) {
    const close = 100 + i * 0.035 + Math.sin(i / 7) * 2.2 + Math.cos(i / 19) * 1.1
    const open = previous
    const high = Math.max(open, close) + 0.2 + (i % 5) * 0.015
    const low = Math.min(open, close) - 0.18 - (i % 7) * 0.012
    candles.push({
      openTime: i * 15 * 60_000,
      open,
      high,
      low,
      close,
      volume: 100 + (i % 23) * 7 + Math.abs(Math.sin(i / 5)) * 20,
    })
    previous = close
  }
  return candles
}

function compareFeatureSets(actual: FeatureSet, expected: FeatureSet, index: number) {
  for (const key of Object.keys(expected) as (keyof FeatureSet)[]) {
    const a = actual[key]
    const e = expected[key]
    if (a === null || e === null) {
      expect(a, `feature ${key} at candle ${index}`).toBe(e)
    } else {
      expect(a, `feature ${key} at candle ${index}`).toBeCloseTo(e, 9)
    }
  }
}

describe('research production feature parity', () => {
  it('matches lib/features.ts at every prefix without changing production code', () => {
    const candles = syntheticCandles(260)
    const series = calculateFeatureSeries(candles)
    for (let end = 1; end <= candles.length; end++) {
      const expected = calculateFeatures(candles.slice(0, end))
      compareFeatureSets(series[end - 1], expected, end - 1)
    }
  })
})
