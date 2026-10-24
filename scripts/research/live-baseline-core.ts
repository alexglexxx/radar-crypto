export const BAR_MS = 15 * 60 * 1000
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const
export const HORIZONS = [{ name: '15m', bars: 1 }, { name: '1h', bars: 4 }, { name: '4h', bars: 16 }] as const

export type RawSnapshot = {
  symbol: string; source_timestamp: string; open: number | string; high: number | string
  low: number | string; close: number | string; volume: number | string
}
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }

export function validateSnapshots(rows: RawSnapshot[], symbol: string, from: number, to: number): Candle[] {
  if (from % BAR_MS !== BAR_MS - 1 || to % BAR_MS !== BAR_MS - 1 || to < from) {
    throw new Error('Window endpoints must be 15m candle-close timestamps')
  }
  const expected = (to - from) / BAR_MS + 1
  if (!Number.isInteger(expected)) throw new Error('Non-integral candle window')
  const series = rows.map(row => ({
    symbol: row.symbol, time: Date.parse(row.source_timestamp), open: Number(row.open),
    high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  })).sort((a, b) => a.time - b.time)
  if (series.length !== expected) throw new Error(`${symbol}: coverage ${series.length}/${expected} candles`)
  for (let i = 0; i < series.length; i++) {
    const c = series[i]
    if (c.symbol !== symbol || c.time !== from + i * BAR_MS) {
      throw new Error(`${symbol}: duplicate, gap, or unexpected timestamp at index ${i}`)
    }
    if (![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
      Math.min(c.open, c.high, c.low, c.close) <= 0 || c.volume < 0 ||
      c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      throw new Error(`${symbol}: invalid OHLCV at ${new Date(c.time).toISOString()}`)
    }
  }
  return series.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }))
}

export function tradeReturn(series: Candle[], signalIndex: number, bars: number, execution: 'close' | 'next_open') {
  const entry = execution === 'close' ? series[signalIndex]?.close : series[signalIndex + 1]?.open
  const exit = execution === 'close' ? series[signalIndex + bars]?.close : series[signalIndex + bars + 1]?.open
  if (!entry || !exit) throw new Error('Trade path extends beyond verified candles')
  return (exit - entry) / entry
}

export function episodes(indices: number[], bars: number) {
  let count = 0, previous = -Infinity
  for (const index of [...indices].sort((a, b) => a - b)) {
    if (index - previous > bars) count++
    previous = index
  }
  return count
}

export function mean(values: number[]) {
  if (!values.length) throw new Error('Cannot average an empty sample')
  return values.reduce((sum, x) => sum + x, 0) / values.length
}

export function circularPValue(
  observed: number, baseline: number, signalIndices: Map<string, number[]>,
  returns: Map<string, number[]>, iterations: number, seed: number,
) {
  let state = seed >>> 0, lower = 0, upper = 0, twoSided = 0
  const next = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
  for (let iteration = 0; iteration < iterations; iteration++) {
    const first = returns.values().next().value as number[]
    const shift = 1 + Math.floor(next() * (first.length - 1))
    let sum = 0, count = 0
    // One shared shift preserves within-asset and cross-asset signal clusters.
    for (const [symbol, indices] of signalIndices) {
      const values = returns.get(symbol)!
      if (values.length !== first.length) throw new Error('Assets need an identical time grid')
      for (const index of indices) { sum += values[(index + shift) % values.length]; count++ }
    }
    const sample = sum / count
    if (sample <= observed) lower++
    if (sample >= observed) upper++
    if (Math.abs(sample - baseline) >= Math.abs(observed - baseline)) twoSided++
  }
  return { one_sided_underperformance: (lower + 1) / (iterations + 1),
    one_sided_outperformance: (upper + 1) / (iterations + 1),
    two_sided: (twoSided + 1) / (iterations + 1) }
}
