import { type Candle as ArchiveCandle } from '../../lib/features'
import { candleCloseTime, replayLiveSignal } from '../../lib/live-window'
import { BAR_MS, HORIZONS, circularPValue, episodes, mean, tradeReturn, type Candle } from './live-baseline-core'

// Live replay needs 249 closed candles; the longest next-open exit reads 17 bars ahead.
export const WARMUP_BARS = 248
export const TAIL_BARS = 17
export const SCORE_BUCKETS = [[75, 79], [80, 84], [85, 89], [90, 100]] as const

export type HistoricalSignal = {
  symbol: string; index: number; time: number; score: number
  trendUp: boolean | null; volatility: number | null; priorReturn4h: number | null
}

export function quarterOf(time: number) {
  const date = new Date(time)
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`
}

// Replays v1.1-live exactly as the cron sees each closed candle (249-candle window).
export function replaySignals(symbol: string, archive: ArchiveCandle[]) {
  const signals: HistoricalSignal[] = []
  const volatility: (number | null)[] = []
  const excluded = { warmup: WARMUP_BARS, tail: TAIL_BARS, replay_rejected: 0, short_window: 0 }
  for (let i = WARMUP_BARS; i < archive.length - TAIL_BARS; i++) {
    const replay = replayLiveSignal(archive, archive[i].openTime + BAR_MS + 1000)
    if (!replay || replay.signalTimestamp !== candleCloseTime(archive[i])) {
      excluded.replay_rejected++; volatility.push(null); continue
    }
    if (replay.sampleSize !== 249) { excluded.short_window++; volatility.push(null); continue }
    const f = replay.features
    volatility.push(f.volatility)
    if (replay.decision !== 'LONG') continue
    signals.push({ symbol, index: i, time: replay.signalTimestamp, score: replay.score,
      trendUp: f.ema_50 == null || f.ema_200 == null ? null : f.ema_50 > f.ema_200,
      volatility: f.volatility, priorReturn4h: f.return_4h })
  }
  return { signals, volatility, excluded }
}

// Label permutation between two signal groups. Overlapping signals make it
// optimistic about independence; report it next to the episode counts.
export function labelPermutationP(a: number[], b: number[], iterations: number, seed: number) {
  const pooled = [...a, ...b]
  const total = pooled.reduce((sum, x) => sum + x, 0)
  const observed = mean(a) - mean(b)
  let state = seed >>> 0, extreme = 0
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000 }
  for (let iteration = 0; iteration < iterations; iteration++) {
    // A partial Fisher-Yates shuffle draws a uniform random first group.
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      const j = i + Math.floor(next() * (pooled.length - i));
      [pooled[i], pooled[j]] = [pooled[j], pooled[i]]
      sum += pooled[i]
    }
    const diff = sum / a.length - (total - sum) / b.length
    if (Math.abs(diff) >= Math.abs(observed) - 1e-15) extreme++
  }
  return { difference: observed, two_sided: (extreme + 1) / (iterations + 1) }
}

type Options = { iterations: number; seed: number; holdoutEnd: number }

export function analyzeHistory(seriesBySymbol: Map<string, Candle[]>, signals: HistoricalSignal[],
  volatilityBySymbol: Map<string, (number | null)[]>, { iterations, seed, holdoutEnd }: Options) {
  const symbols = [...seriesBySymbol.keys()]
  const length = seriesBySymbol.get(symbols[0])!.length
  for (const symbol of symbols) {
    if (seriesBySymbol.get(symbol)!.length !== length) throw new Error('Assets need an identical time grid')
  }
  const grid = length - WARMUP_BARS - TAIL_BARS
  const position = (s: HistoricalSignal) => s.index - WARMUP_BARS
  const time = (i: number) => seriesBySymbol.get(symbols[0])![i].time

  // Volatility terciles over every eligible candle, descriptive only.
  const vols = symbols.flatMap(s => volatilityBySymbol.get(s)!).filter((v): v is number => v != null).sort((a, b) => a - b)
  const cut = [vols[Math.floor(vols.length / 3)], vols[Math.floor(2 * vols.length / 3)]]
  const volTercile = (v: number | null) => v == null ? 'unknown' : v < cut[0] ? 'low' : v < cut[1] ? 'mid' : 'high'

  return HORIZONS.map(horizon => {
    const returns = (execution: 'close' | 'next_open') => new Map(symbols.map(symbol => [symbol,
      Array.from({ length: grid }, (_, k) => tradeReturn(seriesBySymbol.get(symbol)!, k + WARMUP_BARS, horizon.bars, execution))]))
    const close = returns('close'), open = returns('next_open')
    const baselineMean = new Map(symbols.map(s => [s, { close: mean(close.get(s)!), open: mean(open.get(s)!) }]))
    const signalOpen = (s: HistoricalSignal) => open.get(s.symbol)![position(s)]
    const excess = (s: HistoricalSignal) => signalOpen(s) - baselineMean.get(s.symbol)!.open

    const summarize = (group: HistoricalSignal[]) => {
      if (!group.length) return { signals: 0 }
      const opens = group.map(signalOpen)
      const matched = mean(group.map(s => baselineMean.get(s.symbol)!.open))
      return { signals: group.length, next_open_mean: mean(opens), matched_baseline: matched,
        excess: mean(opens) - matched, net_20bps: mean(opens) - 0.002, net_30bps: mean(opens) - 0.003,
        win_rate_net_20bps: opens.filter(r => r > 0.002).length / opens.length }
    }
    const indices = (group: HistoricalSignal[]) => new Map(symbols.map(sym =>
      [sym, group.filter(s => s.symbol === sym).map(position)]))
    const pValue = (group: HistoricalSignal[], series: Map<string, number[]>, pick: (s: HistoricalSignal) => number,
      base: 'close' | 'open', offset: number) => {
      const observed = mean(group.map(pick))
      const matched = mean(group.map(s => baselineMean.get(s.symbol)![base]))
      return circularPValue(observed, matched, indices(group), series, iterations, seed + offset)
    }

    const all = summarize(signals)
    const closeMean = mean(signals.map(s => close.get(s.symbol)![position(s)]))
    const closeMatched = mean(signals.map(s => baselineMean.get(s.symbol)!.close))
    const buckets = SCORE_BUCKETS.map(([lo, hi]) => ({ bucket: `${lo}-${hi}`,
      ...summarize(signals.filter(s => s.score >= lo && s.score <= hi)) }))
    const low = (s: HistoricalSignal) => s.score < 80
    const contrast = (group: HistoricalSignal[]) => {
      const high = group.filter(s => !low(s)).map(excess), base = group.filter(low).map(excess)
      return high.length && base.length
        ? { high_80_100: high.length, low_75_79: base.length, ...labelPermutationP(high, base, iterations, seed + horizon.bars) }
        : null
    }
    const quarters = [...new Set(signals.map(s => quarterOf(s.time)))].sort().map(quarter => {
      const group = signals.filter(s => quarterOf(s.time) === quarter)
      const firstIndex = Array.from({ length: grid }, (_, k) => k).find(k => quarterOf(time(k + WARMUP_BARS)) === quarter)!
      const lastIndex = grid - 1 - Array.from({ length: grid }, (_, k) => grid - 1 - k)
        .findIndex(k => quarterOf(time(k + WARMUP_BARS)) === quarter)
      const drift = mean(symbols.map(sym => {
        const series = seriesBySymbol.get(sym)!
        return series[lastIndex + WARMUP_BARS].close / series[firstIndex + WARMUP_BARS].close - 1
      }))
      const high = group.filter(s => !low(s)).map(excess), base = group.filter(low).map(excess)
      return { quarter, signals: group.length, market_drift: drift,
        excess_75_79: base.length ? mean(base) : null, excess_80_100: high.length ? mean(high) : null,
        inverted: high.length && base.length ? mean(high) < mean(base) : null }
    })
    const by = (label: (s: HistoricalSignal) => string) => [...new Set(signals.map(label))].sort()
      .map(key => ({ key, ...summarize(signals.filter(s => label(s) === key)) }))

    return {
      horizon: horizon.name, signals: signals.length,
      independent_episodes: symbols.reduce((sum, sym) => sum + episodes(indices(signals).get(sym)!, horizon.bars), 0),
      close_to_close_comparator: { signal_mean: closeMean, matched_baseline: closeMatched, excess: closeMean - closeMatched,
        p: pValue(signals, close, s => close.get(s.symbol)![position(s)], 'close', 100 + horizon.bars) },
      next_open: { ...all, p: pValue(signals, open, signalOpen, 'open', 200 + horizon.bars) },
      by_symbol: symbols.map(sym => ({ symbol: sym, ...summarize(signals.filter(s => s.symbol === sym)) })),
      by_score_bucket: buckets,
      score_contrast: { all: contrast(signals),
        holdout_2023_10_to_2024_09: contrast(signals.filter(s => s.time <= holdoutEnd)),
        after_holdout: contrast(signals.filter(s => s.time > holdoutEnd)) },
      by_quarter: quarters,
      by_trend: by(s => s.trendUp == null ? 'unknown' : s.trendUp ? 'ema50_above_ema200' : 'ema50_below_ema200'),
      by_volatility_tercile: by(s => volTercile(s.volatility)),
      by_prior_4h_move: by(s => s.priorReturn4h == null ? 'unknown' : s.priorReturn4h < 0 ? 'down' : s.priorReturn4h < 0.01 ? 'up_<1%' : 'up_>=1%'),
    }
  })
}
