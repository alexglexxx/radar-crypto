import { calculateRadarScore } from '../../../lib/scoring'
import { calculateFeatureSeries } from '../production-features'
import { atrSeries, emaSeries, smaNullable, smaSeries } from './indicators'
import { barsPerDay, type Candle, type MarketData } from './types'

export const FAST_DAYS = 20
export const SLOW_DAYS = 50
export const CALM_DAYS = 30
export const CALM_FACTOR = 1.5

export type SymbolContext = {
  symbol: string
  candles: Candle[]
  close: number[]
  high: number[]
  low: number[]
  volume: number[]
  atr14: (number | null)[]
  emaFast: (number | null)[]
  emaSlow: (number | null)[]
  /** close > EMA(50 days) and EMA(20 days) > EMA(50 days). */
  trend: boolean[]
  /** trend AND ATR <= 1.5 x its 30-day average (no volatility spike). */
  trendCalm: boolean[]
  /** volume / SMA(volume, 20). */
  volRatio: (number | null)[]
}

export type Context = {
  data: MarketData
  symbols: SymbolContext[]
  cache: Map<string, unknown>
}

export function buildContext(data: MarketData): Context {
  const perDay = barsPerDay(data.timeframe)
  const symbols = data.series.map(({ symbol, candles }): SymbolContext => {
    const close = candles.map(c => c.close)
    const high = candles.map(c => c.high)
    const low = candles.map(c => c.low)
    const volume = candles.map(c => c.volume)
    const atr14 = atrSeries(candles, 14)
    const emaFast = emaSeries(close, Math.round(FAST_DAYS * perDay))
    const emaSlow = emaSeries(close, Math.round(SLOW_DAYS * perDay))
    const atrAvg = smaNullable(atr14, Math.round(CALM_DAYS * perDay))
    const volSma = smaSeries(volume, 20)
    const trend = close.map((price, i) => {
      const fast = emaFast[i]
      const slow = emaSlow[i]
      return fast !== null && slow !== null && price > slow && fast > slow
    })
    const trendCalm = trend.map((isTrend, i) => {
      const atr = atr14[i]
      const avg = atrAvg[i]
      return isTrend && atr !== null && avg !== null && atr <= CALM_FACTOR * avg
    })
    const volRatio = volume.map((v, i) => {
      const base = volSma[i]
      return base !== null && base > 0 ? v / base : null
    })
    return { symbol, candles, close, high, low, volume, atr14, emaFast, emaSlow, trend, trendCalm, volRatio }
  })
  return { data, symbols, cache: new Map() }
}

export function cached<T>(ctx: Context, key: string, compute: () => T): T {
  if (!ctx.cache.has(key)) ctx.cache.set(key, compute())
  return ctx.cache.get(key) as T
}

/** Production score (unchanged lib/scoring.ts on the unchanged production feature series). */
export function productionScores(ctx: Context, symbolIndex: number): number[] {
  return cached(ctx, 'score:' + ctx.symbols[symbolIndex].symbol, () => {
    const candles = ctx.symbols[symbolIndex].candles
    const features = calculateFeatureSeries(candles)
    // Production only has a score once the 200-bar EMA exists.
    return features.map((f, i) => (i >= 200 ? calculateRadarScore(f).score : 0))
  })
}
