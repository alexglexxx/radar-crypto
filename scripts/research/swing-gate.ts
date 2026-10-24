import { type Candle } from '../../lib/features'
import { BAR_MS } from './live-baseline-core'
import { type FundingPoint } from './funding-archive'

const HOUR_MS = 3_600_000

export type SwingRules = {
  version: string; execution: string; decisionEveryMs: number; takeProfit: number; stopLoss: number
  maxHoldMs: number; lookbackMs: number; costRoundTrip: number; stressCostRoundTrip: number
  alpha: number; minTrades: number; minPositiveAssets: number; leakChecksPerAsset: number
  permutations: number; seed: number; maxOutageBars: number; maxDevCandidates: number; maxExamCandidates: number
}

// Rules are fixed before any candidate runs. takeProfit/stopLoss are gross
// moves from the entry price; with the 0.2 % round-trip cost they are +4 % / -4 % net.
export const GATE_V2_RULES: Readonly<SwingRules> = {
  version: 'gate-v2',
  execution: 'la decisión se toma al cierre de cada vela de 4h; se compra en la apertura de la vela siguiente y se vende al tocar +4 % neto (TP) o −4 % neto (SL), o a las 72 h en la apertura; si una vela toca ambos niveles cuenta el SL.',
  decisionEveryMs: 4 * HOUR_MS,
  takeProfit: 0.042,
  stopLoss: 0.038,
  maxHoldMs: 72 * HOUR_MS,
  lookbackMs: 30 * 24 * HOUR_MS,
  costRoundTrip: 0.002,
  stressCostRoundTrip: 0.003,
  alpha: 0.05,
  minTrades: 200,
  minPositiveAssets: 3,
  leakChecksPerAsset: 200,
  permutations: 2000,
  seed: 20261024,
  maxOutageBars: 24,
  maxDevCandidates: 20,
  maxExamCandidates: 3,
}

export type SwingContext = { candles: Map<string, Candle[]>; funding: Map<string, FundingPoint[]> }

export type SwingCandidate = {
  id: string
  kind: 'strategy' | 'control'
  hypothesis: string
  // Decision at the close of candles[index]. May read only what is visible at decisionTime.
  decide(ctx: SwingContext, symbol: string, index: number): boolean
}

export type SwingTrade = {
  decisionIndex: number; entryIndex: number; exitIndex: number; reason: 'tp' | 'sl' | 'time'
  exitTime: number; hours: number; gross: number; net: number; netStress: number
}

export const decisionTime = (c: Candle) => c.openTime + BAR_MS

// Enters at the open of the next existing candle; the 72 h limit counts by clock from that open.
export function simulateTrade(candles: Candle[], i: number, rules: SwingRules = GATE_V2_RULES): SwingTrade | null {
  const entry = candles[i + 1]
  if (!entry) return null
  const E = entry.open, tp = E * (1 + rules.takeProfit), sl = E * (1 - rules.stopLoss)
  const limit = entry.openTime + rules.maxHoldMs
  // A decision counts only if the full hold window is in the data, wherever TP/SL would hit.
  let timeIndex = i + 1
  while (timeIndex < candles.length && candles[timeIndex].openTime < limit) timeIndex++
  if (timeIndex >= candles.length) return null
  for (let j = i + 1; j <= timeIndex; j++) {
    const c = candles[j]
    let reason: SwingTrade['reason'], exit: number, exitTime: number
    if (j === timeIndex) { reason = 'time'; exit = c.open; exitTime = c.openTime }
    else if (c.low <= sl) { reason = 'sl'; exit = Math.min(sl, c.open); exitTime = c.openTime + BAR_MS }
    else if (c.high >= tp) { reason = 'tp'; exit = tp; exitTime = c.openTime + BAR_MS }
    else continue
    const gross = (exit - E) / E
    return {
      decisionIndex: i, entryIndex: i + 1, exitIndex: j, reason, exitTime,
      hours: (exitTime - entry.openTime) / HOUR_MS, gross,
      net: gross - rules.costRoundTrip, netStress: gross - rules.stressCostRoundTrip,
    }
  }
  return null
}

export type TradeTable = { trades: SwingTrade[]; times: number[]; nextFree: number[] }

export function buildTradeTable(candles: Candle[], periodStart: number, periodEnd: number, rules: SwingRules = GATE_V2_RULES): TradeTable {
  const trades: SwingTrade[] = [], times: number[] = []
  for (let i = 0; i < candles.length; i++) {
    const t = decisionTime(candles[i])
    if (t % rules.decisionEveryMs !== 0 || t < periodStart || t >= periodEnd) continue
    const trade = simulateTrade(candles, i, rules)
    if (!trade) continue
    trades.push(trade)
    times.push(t)
  }
  // times is ascending: nextFree[k] is the first later decision at or after the exit.
  const nextFree = trades.map((trade, k) => {
    let lo = k + 1, hi = times.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] >= trade.exitTime) hi = mid; else lo = mid + 1 }
    return lo
  })
  return { trades, times, nextFree }
}

// One position at a time: a taken trade blocks decisions until its exit.
export function applyOnePosition(selected: boolean[], nextFree: number[]): number[] {
  const taken: number[] = []
  for (let k = 0; k < selected.length;) {
    if (selected[k]) { taken.push(k); k = nextFree[k] } else k++
  }
  return taken
}
