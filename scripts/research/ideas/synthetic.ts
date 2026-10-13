import { mulberry32 } from './stats'
import { TF_MS, barsPerDay, type Candle, type FundingPoint, type MarketData, type Timeframe } from './types'

export type SyntheticMode = 'random' | 'trend'

function gaussian(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

/**
 * Seeded synthetic market used to test the harness itself.
 *  - 'random': zero-drift random walk. No honest strategy should qualify here after costs.
 *  - 'trend' : persistent drift episodes (momentum-friendly). A trend follower should profit here.
 * This is NOT a model of real markets; it only proves the pipeline detects (or refuses) an edge.
 */
export function syntheticMarket(options: {
  symbols: string[]
  timeframe: Timeframe
  bars: number
  seed: number
  mode: SyntheticMode
  startTime?: number
  withFunding?: boolean
}): MarketData {
  const { symbols, timeframe, bars, seed, mode } = options
  const startTime = options.startTime ?? Date.UTC(2023, 0, 1)
  const step = TF_MS[timeframe]
  const perDay = barsPerDay(timeframe)
  const rand = mulberry32(seed)
  // 0.18% volatility per hour-equivalent, scaled with sqrt(time).
  const baseSigma = 0.0018 * Math.sqrt(step / 3_600_000)

  // Market-wide drift regime (shared factor) for the trend mode.
  const regime: number[] = Array(bars).fill(0)
  if (mode === 'trend') {
    let state = 0
    let remaining = 0
    for (let i = 0; i < bars; i++) {
      if (remaining <= 0) {
        const roll = rand()
        state = roll < 0.45 ? 1 : roll < 0.7 ? -1 : 0
        remaining = Math.round(perDay * (8 + rand() * 25))
      }
      regime[i] = state
      remaining--
    }
  }
  // Same drift per DAY regardless of timeframe, so 1h and 4h faces equally strong trends.
  const driftPerBar = 0.004 / perDay

  const marketShock: number[] = Array.from({ length: bars }, () => gaussian(rand))

  const series = symbols.map((symbol, symbolIndex) => {
    const candles: Candle[] = []
    let price = 100 * (1 + symbolIndex * 0.35)
    let logVol = 0
    const beta = 0.65 + 0.1 * symbolIndex
    for (let i = 0; i < bars; i++) {
      logVol = 0.985 * logVol + 0.12 * gaussian(rand)
      const sigma = baseSigma * Math.exp(logVol * 0.5)
      const shock = beta * marketShock[i] + Math.sqrt(1 - beta * beta) * gaussian(rand)
      const drift = mode === 'trend' ? regime[i] * driftPerBar : 0
      const open = price
      const close = open * Math.exp(drift + sigma * shock - 0.5 * sigma * sigma)
      const wick = sigma * 0.6
      const high = Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * wick)
      const low = Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * wick)
      const volume = 1000 * Math.exp(0.4 * gaussian(rand)) * (1 + 6 * Math.abs(Math.log(close / open)) / baseSigma / 10)
      candles.push({ openTime: startTime + i * step, open, high, low, close, volume })
      price = close
    }
    return { symbol, candles }
  })

  let funding: Record<string, FundingPoint[]> | null = null
  if (options.withFunding) {
    funding = {}
    const fundingStep = 8 * 3_600_000
    const count = Math.floor((bars * step) / fundingStep)
    for (const { symbol, candles } of series) {
      const points: FundingPoint[] = []
      let level = 0.0001
      for (let k = 0; k < count; k++) {
        const time = startTime + k * fundingStep
        const idx = Math.min(candles.length - 1, Math.floor((k * fundingStep) / step))
        const back = Math.max(0, idx - Math.round(perDay * 7))
        const trailing = candles[idx].close / candles[back].close - 1
        level = 0.9 * level + 0.1 * (0.0001 + 0.002 * trailing) + 0.00002 * gaussian(rand)
        points.push({ time, rate: level })
      }
      funding[symbol] = points
    }
  }
  return { timeframe, series, funding }
}
