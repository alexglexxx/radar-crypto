import type { Candle } from '../../../lib/features'

export type { Candle }

export type Timeframe = '15m' | '1h' | '4h'

export const TF_MS: Record<Timeframe, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
}

export function barsPerDay(timeframe: Timeframe): number {
  return 86_400_000 / TF_MS[timeframe]
}

export type FundingPoint = { time: number; rate: number }
export type SymbolSeries = { symbol: string; candles: Candle[] }

export type MarketData = {
  timeframe: Timeframe
  series: SymbolSeries[]
  /** Funding rate observations per symbol (8h cadence). Null when the data set has no funding. */
  funding: Record<string, FundingPoint[]> | null
}

export type ParamSet = Record<string, number | string>

/**
 * Exit rules. A signal is evaluated at the CLOSE of bar s; the position is opened at the
 * OPEN of bar s+1. All levels are derived from information known at bar s.
 */
export type ExitSpec = {
  /** Hard time exit: closes at the open of bar entry + maxBars. */
  maxBars: number
  /** ATR value per bar (14-period). The value at the signal bar fixes the stop/target distance. */
  atr: (number | null)[]
  /** Initial stop = entry - mult * ATR(signal bar). */
  stopAtrMult?: number
  /** Chandelier trail = highest high since entry (through the previous bar) - mult * ATR(signal bar). */
  trailAtrMult?: number
  /** Profit target = entry + mult * ATR(signal bar). */
  targetAtrMult?: number
  /** When close[j] >= level[j], exit at the open of bar j+1 (e.g. reversion to the mean). */
  exitAtOrAbove?: (number | null)[]
}

export type EntryPlan = {
  /** entries[i] === true means: the signal fired at the close of bar i. */
  entries: boolean[]
  exit: ExitSpec
}

export type ExitReason = 'time' | 'stop' | 'stop_gap' | 'target' | 'target_gap' | 'signal' | 'window_end'

export type Trade = {
  symbol: string
  entryIdx: number
  exitIdx: number
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  gross: number
  bars: number
  reason: ExitReason
}
