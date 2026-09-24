export type Candle = {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type FeatureSet = {
  return_5m: number | null
  return_15m: number | null
  return_1h: number | null
  return_4h: number | null
  return_24h: number | null
  ema_20: number | null
  ema_50: number | null
  ema_200: number | null
  trend_strength: number | null
  rsi_14: number | null
  macd: number | null
  macd_signal: number | null
  macd_histogram: number | null
  volume_sma: number | null
  volume_ratio: number | null
  volatility: number | null
  atr: number | null
}

function valid(n: number | null): n is number {
  return n !== null && Number.isFinite(n)
}

function returnFrom(candles: Candle[], barsBack: number): number | null {
  if (candles.length <= barsBack) return null
  const now = candles[candles.length - 1].close
  const then = candles[candles.length - 1 - barsBack].close
  return then > 0 ? (now / then) - 1 : null
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) result = values[i] * k + result * (1 - k)
  return result
}

function rsi(values: number[], period: number): number | null {
  if (values.length <= period) return null
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1]
    if (change >= 0) gains += change
    else losses -= change
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1]
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  if (avgLoss === 0) return 100
  return 100 - (100 / (1 + avgGain / avgLoss))
}

function trueRange(c: Candle, previousClose: number): number {
  return Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose))
}

function atr(candles: Candle[], period: number): number | null {
  if (candles.length <= period) return null
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) trs.push(trueRange(candles[i], candles[i - 1].close))
  return sma(trs, period)
}

function realizedVolatility(values: number[], period: number): number | null {
  if (values.length <= period) return null
  const returns: number[] = []
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) returns.push(Math.log(values[i] / values[i - 1]))
  }
  if (returns.length < period) return null
  const r = returns.slice(-period)
  const mean = r.reduce((a, b) => a + b, 0) / r.length
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length
  return Math.sqrt(variance) * Math.sqrt(period)
}

export function calculateFeatures(candles: Candle[]): FeatureSet {
  const closes = candles.map(c => c.close)
  const volumes = candles.map(c => c.volume)
  const last = candles[candles.length - 1]

  const ema20 = ema(closes, 20)
  const ema50 = ema(closes, 50)
  const ema200 = ema(closes, 200)
  const trendStrength = valid(ema20) && valid(ema50) && ema50 !== 0 ? (ema20 / ema50) - 1 : null
  const volumeSma = sma(volumes, 20)
  const volumeRatio = valid(volumeSma) && volumeSma > 0 ? last.volume / volumeSma : null

  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const macd = valid(ema12) && valid(ema26) ? ema12 - ema26 : null

  const macdSeries: number[] = []
  if (closes.length >= 35) {
    for (let i = 26; i <= closes.length; i++) {
      const fast = ema(closes.slice(0, i), 12)
      const slow = ema(closes.slice(0, i), 26)
      if (valid(fast) && valid(slow)) macdSeries.push(fast - slow)
    }
  }
  const macdSignal = macdSeries.length >= 9 ? ema(macdSeries, 9) : null

  return {
    return_5m: returnFrom(candles, 1),
    return_15m: returnFrom(candles, 1),
    return_1h: returnFrom(candles, 4),
    return_4h: returnFrom(candles, 16),
    return_24h: returnFrom(candles, 96),
    ema_20: ema20,
    ema_50: ema50,
    ema_200: ema200,
    trend_strength: trendStrength,
    rsi_14: rsi(closes, 14),
    macd,
    macd_signal: macdSignal,
    macd_histogram: valid(macd) && valid(macdSignal) ? macd - macdSignal : null,
    volume_sma: volumeSma,
    volume_ratio: volumeRatio,
    volatility: realizedVolatility(closes, 20),
    atr: atr(candles, 14),
  }
}
