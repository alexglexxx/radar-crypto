import type { Candle, FeatureSet } from '../../lib/features'

function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  if (values.length < period) return out
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  out[period - 1] = current
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k)
    out[i] = current
  }
  return out
}

function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

function rsiSeries(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  if (values.length <= period) return out
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1]
    if (change >= 0) gains += change
    else losses -= change
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  const value = () => avgLoss === 0
    ? (avgGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + avgGain / avgLoss)
  out[period] = value()
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period
    out[i] = value()
  }
  return out
}

/**
 * Research-only O(n) equivalent of calculateFeatures(). Production files are
 * deliberately not changed. The parity test compares every field against the
 * production function at multiple prefixes before this implementation is used.
 */
export function calculateFeatureSeries(candles: Candle[]): FeatureSet[] {
  const n = candles.length
  const closes = candles.map(c => c.close)
  const volumes = candles.map(c => c.volume)
  const ema20 = emaSeries(closes, 20)
  const ema50 = emaSeries(closes, 50)
  const ema200 = emaSeries(closes, 200)
  const ema12 = emaSeries(closes, 12)
  const ema26 = emaSeries(closes, 26)
  const rsi = rsiSeries(closes)
  const volumeSma = smaSeries(volumes, 20)
  const volumeRatio: (number | null)[] = Array(n).fill(null)
  const macd: (number | null)[] = Array(n).fill(null)
  const macdSignal: (number | null)[] = Array(n).fill(null)
  const macdHist: (number | null)[] = Array(n).fill(null)
  const trueRanges: number[] = Array(n).fill(0)
  const atr: (number | null)[] = Array(n).fill(null)
  const volatility: (number | null)[] = Array(n).fill(null)
  const returns: (number | null)[] = Array(n).fill(null)

  for (let i = 0; i < n; i++) {
    if (i >= 1 && closes[i - 1] > 0 && closes[i] > 0) {
      returns[i] = Math.log(closes[i] / closes[i - 1])
    }
    if (i >= 1) {
      const c = candles[i]
      const previousClose = candles[i - 1].close
      trueRanges[i] = Math.max(
        c.high - c.low,
        Math.abs(c.high - previousClose),
        Math.abs(c.low - previousClose),
      )
    }
    if (volumeSma[i] !== null && volumeSma[i]! > 0) {
      volumeRatio[i] = volumes[i] / volumeSma[i]!
    }
    if (ema12[i] !== null && ema26[i] !== null) {
      macd[i] = ema12[i]! - ema26[i]!
    }
    // Production builds MACD from the first index where EMA-26 exists (25),
    // then applies an EMA-9 seeded by the first nine MACD values.
    if (i >= 33) {
      if (i === 33) {
        let sum = 0
        for (let j = 25; j <= 33; j++) sum += macd[j]!
        macdSignal[i] = sum / 9
      } else {
        const k = 2 / 10
        macdSignal[i] = macd[i]! * k + macdSignal[i - 1]! * (1 - k)
      }
    }
    if (macd[i] !== null && macdSignal[i] !== null) {
      macdHist[i] = macd[i]! - macdSignal[i]!
    }
    // Production ATR is an SMA of the last 14 true ranges, excluding candle 0.
    if (i >= 14) {
      let sum = 0
      for (let j = i - 13; j <= i; j++) sum += trueRanges[j]
      atr[i] = sum / 14
    }
    // Population standard deviation of the last 20 log returns, multiplied by sqrt(20).
    if (i >= 20) {
      const sample: number[] = []
      for (let j = i - 19; j <= i; j++) {
        if (returns[j] !== null) sample.push(returns[j]!)
      }
      if (sample.length >= 20) {
        const mean = sample.reduce((sum, x) => sum + x, 0) / sample.length
        const variance = sample.reduce((sum, x) => sum + (x - mean) ** 2, 0) / sample.length
        volatility[i] = Math.sqrt(variance) * Math.sqrt(20)
      }
    }
  }

  return candles.map((c, i) => {
    const returnFrom = (barsBack: number): number | null => {
      if (i < barsBack) return null
      const then = closes[i - barsBack]
      return then > 0 ? c.close / then - 1 : null
    }
    return {
      return_5m: null,
      return_15m: returnFrom(1),
      return_1h: returnFrom(4),
      return_4h: returnFrom(16),
      return_24h: returnFrom(96),
      ema_20: ema20[i],
      ema_50: ema50[i],
      ema_200: ema200[i],
      trend_strength: ema20[i] !== null && ema50[i] !== null && ema50[i] !== 0
        ? ema20[i]! / ema50[i]! - 1
        : null,
      rsi_14: rsi[i],
      macd: macd[i],
      macd_signal: macdSignal[i],
      macd_histogram: macdHist[i],
      volume_sma: volumeSma[i],
      volume_ratio: volumeRatio[i],
      volatility: volatility[i],
      atr: i < 14 ? null : atr[i],
    }
  })
}
