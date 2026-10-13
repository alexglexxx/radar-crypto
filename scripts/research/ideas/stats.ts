import type { Trade } from './types'

export type TradeStats = {
  trades: number
  winRate: number | null
  /** Mean net return per trade (the research "expectancy"). */
  expectancy: number | null
  median: number | null
  /** t-statistic of the mean net return (trades treated as independent; an optimistic simplification). */
  tStat: number | null
  profitFactor: number | null
  /** Sum of net returns (not compounded). */
  totalReturn: number
  /** Max drawdown of a capital-weighted equity curve (see `weight`). */
  maxDrawdown: number | null
  avgBars: number | null
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function netReturn(trade: Trade, costBps: number): number {
  return trade.gross - costBps / 10_000
}

export function netReturns(trades: Trade[], costBps: number): number[] {
  return trades.map(t => netReturn(t, costBps))
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function emptyStats(): TradeStats {
  return {
    trades: 0,
    winRate: null,
    expectancy: null,
    median: null,
    tStat: null,
    profitFactor: null,
    totalReturn: 0,
    maxDrawdown: null,
    avgBars: null,
  }
}

/**
 * `weight` is the fraction of equity committed to each trade for the drawdown curve
 * (1 / number of symbols for independent per-symbol events; 1 for a single-position rotation).
 */
export function summarize(trades: Trade[], costBps: number, weight = 1): TradeStats {
  if (!trades.length) return emptyStats()
  const returns = netReturns(trades, costBps)
  const n = returns.length
  let sum = 0
  let wins = 0
  let profit = 0
  let loss = 0
  for (const r of returns) {
    sum += r
    if (r > 0) {
      wins++
      profit += r
    } else {
      loss -= r
    }
  }
  const mean = sum / n
  let variance = 0
  for (const r of returns) variance += (r - mean) ** 2
  const sd = n > 1 ? Math.sqrt(variance / (n - 1)) : 0

  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime)
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  for (const trade of ordered) {
    equity *= 1 + weight * netReturn(trade, costBps)
    if (equity > peak) peak = equity
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }

  return {
    trades: n,
    winRate: wins / n,
    expectancy: mean,
    median: median(returns),
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : null,
    profitFactor: loss > 0 ? profit / loss : profit > 0 ? null : 0,
    totalReturn: sum,
    maxDrawdown,
    avgBars: trades.reduce((acc, t) => acc + t.bars, 0) / n,
  }
}

/** Percentile bootstrap confidence interval of the mean (two-sided at level `alpha`). */
export function bootstrapMeanCI(
  values: number[],
  alpha: number,
  resamples = 1000,
  seed = 12345,
): { lo: number; hi: number } | null {
  const n = values.length
  if (n < 2) return null
  const rand = mulberry32(seed)
  const means = new Float64Array(resamples)
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)]
    means[r] = sum / n
  }
  means.sort()
  const at = (q: number) => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))]
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2) }
}
