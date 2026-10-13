import type { Candle, EntryPlan, ExitReason, MarketData, Trade } from './types'

/**
 * Event simulator for ONE symbol over the bar window [from, to).
 *
 * Rules (all deliberately conservative):
 *  - A signal at the close of bar s opens a long at the OPEN of bar s+1.
 *  - Stops are evaluated before targets inside the same bar. A gap through the stop fills at the open.
 *  - Trailing/initial stops use only information through the previous bar.
 *  - One position per symbol; the next signal is accepted from the exit bar on (entry one bar later).
 *  - A position still open when the window ends is closed at the open of bar `to`
 *    (the close of the last bar when the data ends). Nothing is dropped, so long winners are kept.
 */
export function simulateSymbol(symbol: string, candles: Candle[], plan: EntryPlan, from: number, to: number): Trade[] {
  const n = candles.length
  const spec = plan.exit
  const needsAtr = spec.stopAtrMult !== undefined || spec.trailAtrMult !== undefined || spec.targetAtrMult !== undefined
  const trades: Trade[] = []
  const lastSignal = Math.min(to - 2, n - 2)
  let s = Math.max(from, 0)

  while (s <= lastSignal) {
    if (!plan.entries[s]) {
      s++
      continue
    }
    const atr = spec.atr[s]
    if (needsAtr && (atr === null || !(atr > 0))) {
      s++
      continue
    }
    const e = s + 1
    const entryPrice = candles[e].open
    if (!(entryPrice > 0)) {
      s++
      continue
    }

    const distance = atr ?? 0
    const initialStop = spec.stopAtrMult !== undefined ? entryPrice - spec.stopAtrMult * distance : -Infinity
    const target = spec.targetAtrMult !== undefined ? entryPrice + spec.targetAtrMult * distance : Infinity
    let highest = entryPrice
    let pendingSignalExit = false
    let exitIdx = -1
    let exitPrice = NaN
    let reason: ExitReason = 'time'

    for (let j = e; ; j++) {
      if (j >= to) {
        reason = 'window_end'
        if (to < n) {
          exitIdx = to
          exitPrice = candles[to].open
        } else {
          exitIdx = n - 1
          exitPrice = candles[n - 1].close
        }
        break
      }
      const c = candles[j]
      if (j > e) {
        if (pendingSignalExit) {
          exitIdx = j
          exitPrice = c.open
          reason = 'signal'
          break
        }
        if (j - e >= spec.maxBars) {
          exitIdx = j
          exitPrice = c.open
          reason = 'time'
          break
        }
      }

      let stopLevel = initialStop
      if (spec.trailAtrMult !== undefined) stopLevel = Math.max(stopLevel, highest - spec.trailAtrMult * distance)
      if (stopLevel > -Infinity) {
        if (c.open <= stopLevel) {
          exitIdx = j
          exitPrice = c.open
          reason = 'stop_gap'
          break
        }
        if (c.low <= stopLevel) {
          exitIdx = j
          exitPrice = stopLevel
          reason = 'stop'
          break
        }
      }
      if (target < Infinity) {
        if (c.open >= target) {
          exitIdx = j
          exitPrice = c.open
          reason = 'target_gap'
          break
        }
        if (c.high >= target) {
          exitIdx = j
          exitPrice = target
          reason = 'target'
          break
        }
      }

      if (c.high > highest) highest = c.high
      if (spec.exitAtOrAbove) {
        const level = spec.exitAtOrAbove[j]
        if (level !== null && level !== undefined && c.close >= level) pendingSignalExit = true
      }
    }

    trades.push({
      symbol,
      entryIdx: e,
      exitIdx,
      entryTime: candles[e].openTime,
      exitTime: candles[exitIdx].openTime,
      entryPrice,
      exitPrice,
      gross: exitPrice / entryPrice - 1,
      bars: exitIdx - e,
      reason,
    })
    s = Math.max(exitIdx, s + 1)
  }
  return trades
}

/**
 * Single-position rotation: targets[i] is the symbol index to hold after the close of bar i (or -1 = cash).
 * A change of target closes the old position and opens the new one at the open of bar i+1.
 */
export function simulateRotation(data: MarketData, targets: number[], from: number, to: number): Trade[] {
  const trades: Trade[] = []
  const n = data.series[0].candles.length
  const lastSignal = Math.min(to - 2, n - 2)
  let current = -1
  let entryIdx = -1
  let entryPrice = NaN

  const close = (idx: number, price: number, reason: ExitReason) => {
    const { symbol, candles } = data.series[current]
    trades.push({
      symbol,
      entryIdx,
      exitIdx: idx,
      entryTime: candles[entryIdx].openTime,
      exitTime: candles[idx].openTime,
      entryPrice,
      exitPrice: price,
      gross: price / entryPrice - 1,
      bars: idx - entryIdx,
      reason,
    })
  }

  for (let s = Math.max(from, 0); s <= lastSignal; s++) {
    const wanted = targets[s]
    if (wanted === current) continue
    if (current !== -1) close(s + 1, data.series[current].candles[s + 1].open, 'signal')
    current = wanted
    if (current !== -1) {
      entryIdx = s + 1
      entryPrice = data.series[current].candles[entryIdx].open
    }
  }
  if (current !== -1) {
    const { candles } = data.series[current]
    if (to < n) close(to, candles[to].open, 'window_end')
    else close(n - 1, candles[n - 1].close, 'window_end')
  }
  return trades
}
