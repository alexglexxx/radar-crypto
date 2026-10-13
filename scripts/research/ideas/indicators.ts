import type { Candle } from './types'

/** Every function here is causal: the value at index i only uses data at indexes <= i. */

export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  if (period < 1 || values.length < period) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  let prev = sum / period
  out[period - 1] = prev
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  if (period < 1 || values.length < period) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** SMA over a series that may contain nulls; a window containing any null yields null. */
export function smaNullable(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  let sum = 0
  let nulls = 0
  for (let i = 0; i < values.length; i++) {
    const add = values[i]
    if (add === null) nulls++
    else sum += add
    if (i >= period) {
      const drop = values[i - period]
      if (drop === null) nulls--
      else sum -= drop
    }
    if (i >= period - 1 && nulls === 0) out[i] = sum / period
  }
  return out
}

/** Same definition as production: simple average of the last `period` true ranges, excluding candle 0. */
export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = Array(n).fill(null)
  const tr: number[] = Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const c = candles[i]
    const prev = candles[i - 1].close
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev))
  }
  let sum = 0
  for (let i = 1; i < n; i++) {
    sum += tr[i]
    if (i > period) sum -= tr[i - period]
    if (i >= period) out[i] = sum / period
  }
  return out
}

/** max(values[i-n .. i-1]) — the CURRENT bar is excluded so a breakout compares against the past only. */
export function rollingMaxPrev(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  const deque: number[] = []
  let head = 0
  for (let i = 0; i < values.length; i++) {
    if (i >= n) {
      while (head < deque.length && deque[head] < i - n) head++
      out[i] = values[deque[head]]
    }
    while (deque.length > head && values[deque[deque.length - 1]] <= values[i]) deque.pop()
    deque.push(i)
  }
  return out
}

/** Population standard deviation of the last n values (current bar included). */
export function rollingStd(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null)
  for (let i = n - 1; i < values.length; i++) {
    let mean = 0
    for (let j = i - n + 1; j <= i; j++) mean += values[j]
    mean /= n
    let variance = 0
    for (let j = i - n + 1; j <= i; j++) variance += (values[j] - mean) ** 2
    out[i] = Math.sqrt(variance / n)
  }
  return out
}
