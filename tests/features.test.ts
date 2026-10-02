import { describe, expect, it } from 'vitest'
import { calculateFeatures, type Candle } from '../lib/features'

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * 15 * 60 * 1000,
    open: close,
    high: close + 1,
    low: Math.max(0, close - 1),
    close,
    volume: 1000 + i,
  }))
}

describe('calculateFeatures', () => {
  it('returns finite features when enough closed candles exist', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.25 + Math.sin(i / 8))
    const features = calculateFeatures(candlesFromCloses(closes))

    expect(features.ema_200).not.toBeNull()
    expect(features.rsi_14).not.toBeNull()
    expect(features.macd_signal).not.toBeNull()
    expect(features.atr).not.toBeNull()

    Object.values(features).forEach(value => {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
    })
  })

  it('treats a completely flat market as RSI 50, not overbought', () => {
    const features = calculateFeatures(candlesFromCloses(Array(250).fill(100)))
    expect(features.rsi_14).toBe(50)
  })

  it('does not invent short-term return_5m data on a 15m feed', () => {
    const features = calculateFeatures(candlesFromCloses(Array.from({ length: 250 }, () => 100)))
    expect(features.return_5m).toBeNull()
  })
})
