import type { FeatureSet } from './features'

export type RadarScore = {
  score: number
  status: 'SETUP LONG' | 'VIGILAR' | 'NEUTRAL' | 'EVITAR'
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function between(value: number, low: number, high: number) {
  return Number.isFinite(value) && value >= low && value <= high
}

/**
 * Directional score, not a prediction of future price.
 * 100 = many independent bullish conditions agree.
 * 50 = mixed/unclear.
 * 0 = broad bearish alignment.
 *
 * We deliberately avoid news sentiment here until it has a real, timestamped,
 * symbol-linked data source. A missing news feed must never manufacture a score.
 */
export function calculateRadarScore(f: FeatureSet): RadarScore {
  let score = 50

  // 30 pts: market regime / trend.
  if (f.ema_200 !== null) {
    // The caller supplies the current price through return/momentum context;
    // EMA alignment carries most of the regime information available here.
    if (f.ema_20 !== null && f.ema_50 !== null) {
      if (f.ema_20 > f.ema_50) score += 8
      else score -= 8
    }
    if (f.trend_strength !== null) {
      if (f.trend_strength >= 0.01) score += 10
      else if (f.trend_strength >= 0.003) score += 5
      else if (f.trend_strength <= -0.01) score -= 10
      else if (f.trend_strength <= -0.003) score -= 5
    }
  }

  // 25 pts: multi-timeframe momentum.
  if (f.return_15m !== null) score += clamp(f.return_15m * 1000, -5, 5)
  if (f.return_1h !== null) score += clamp(f.return_1h * 400, -8, 8)
  if (f.return_4h !== null) score += clamp(f.return_4h * 150, -6, 6)
  if (f.return_24h !== null) score += clamp(f.return_24h * 50, -6, 6)

  // 20 pts: participation. A move without volume is deliberately discounted.
  if (f.volume_ratio !== null) {
    if (f.volume_ratio >= 2) score += 10
    else if (f.volume_ratio >= 1.3) score += 7
    else if (f.volume_ratio >= 1.05) score += 3
    else if (f.volume_ratio < 0.7) score -= 6
  }

  // 15 pts: confirmation / exhaustion guard.
  if (f.macd_histogram !== null) {
    if (f.macd_histogram > 0) score += 5
    else score -= 5
  }

  if (f.rsi_14 !== null) {
    if (between(f.rsi_14, 52, 68)) score += 5
    else if (between(f.rsi_14, 45, 52) || between(f.rsi_14, 68, 72)) score += 1
    else if (f.rsi_14 > 78) score -= 6
    else if (f.rsi_14 < 35) score -= 5
  }

  // Volatility is a risk modifier, not a reason by itself to buy.
  if (f.atr !== null && f.ema_200 !== null && f.atr > 0) {
    const atrToEma = f.atr / f.ema_200
    if (atrToEma > 0.08) score -= 5
  }

  const finalScore = Math.round(clamp(score))
  const status = finalScore >= 75
    ? 'SETUP LONG'
    : finalScore >= 60
      ? 'VIGILAR'
      : finalScore >= 45
        ? 'NEUTRAL'
        : 'EVITAR'

  return { score: finalScore, status }
}
