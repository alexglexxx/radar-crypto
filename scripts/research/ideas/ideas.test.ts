import { describe, expect, it } from 'vitest'
import { calculateFeatures, type Candle } from '../../../lib/features'
import { buildContext } from './context'
import { parseFundingCsv, parseKlinesCsv } from './data'
import { simulateRotation, simulateSymbol } from './engine'
import { atrSeries, emaSeries, rollingMaxPrev, smaNullable, smaSeries } from './indicators'
import { bootstrapMeanCI, mulberry32, summarize } from './stats'
import { buildStrategies, fundingPctByBar, fundingPercentiles, product, type Strategy } from './strategies'
import { syntheticMarket } from './synthetic'
import { TF_MS, type EntryPlan, type MarketData, type Timeframe, type Trade } from './types'
import { Evaluator, addMonths, buildFolds, runStrategy } from './walkforward'

function bar(openTime: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { openTime, open, high, low, close, volume }
}

function flat(count: number, price = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => bar(i * 3_600_000, price, price + 0.5, price - 0.5, price))
}

function plan(entries: number[], length: number, exit: Partial<EntryPlan['exit']> & { maxBars: number }): EntryPlan {
  const flags = Array(length).fill(false)
  for (const i of entries) flags[i] = true
  return { entries: flags, exit: { atr: Array(length).fill(1), ...exit } }
}

describe('engine: fills and exits', () => {
  it('enters at the NEXT bar open and exits at the open maxBars later', () => {
    const candles = flat(20)
    candles[5] = bar(5 * 3_600_000, 101, 102, 100, 101)
    candles[6] = bar(6 * 3_600_000, 103, 104, 102, 103)
    candles[9] = bar(9 * 3_600_000, 110, 111, 109, 110)
    const [trade] = simulateSymbol('X', candles, plan([5], 20, { maxBars: 3 }), 0, 20)
    expect(trade.entryIdx).toBe(6)
    expect(trade.entryPrice).toBe(103) // open of bar 6, not the close of bar 5
    expect(trade.exitIdx).toBe(9)
    expect(trade.exitPrice).toBe(110)
    expect(trade.reason).toBe('time')
    expect(trade.gross).toBeCloseTo(110 / 103 - 1, 12)
  })

  it('fills a stop at the stop level, or at the open when the bar gaps through it', () => {
    const candles = flat(20)
    candles[7] = bar(7 * 3_600_000, 100, 100.5, 97, 98) // low pierces stop at 98
    const [intrabar] = simulateSymbol('X', candles, plan([5], 20, { maxBars: 50, stopAtrMult: 2 }), 0, 20)
    expect(intrabar.reason).toBe('stop')
    expect(intrabar.exitPrice).toBe(98)

    const gap = flat(20)
    gap[7] = bar(7 * 3_600_000, 95, 96, 94, 95) // opens below the stop
    const [gapped] = simulateSymbol('X', gap, plan([5], 20, { maxBars: 50, stopAtrMult: 2 }), 0, 20)
    expect(gapped.reason).toBe('stop_gap')
    expect(gapped.exitPrice).toBe(95)
  })

  it('assumes the stop is hit before the target when both are touched in one bar', () => {
    const candles = flat(20)
    candles[7] = bar(7 * 3_600_000, 100, 106, 96, 100)
    const [trade] = simulateSymbol('X', candles, plan([5], 20, { maxBars: 50, stopAtrMult: 2, targetAtrMult: 4 }), 0, 20)
    expect(trade.reason).toBe('stop')
    expect(trade.gross).toBeLessThan(0)
  })

  it('trails the stop upward using only past highs', () => {
    const candles = flat(30)
    for (let i = 7; i <= 12; i++) {
      const p = 100 + (i - 6) * 3
      candles[i] = bar(i * 3_600_000, p, p + 1, p - 0.5, p + 0.5)
    }
    candles[13] = bar(13 * 3_600_000, 118, 118.5, 112, 113) // trail from high 118+... must be hit
    const [trade] = simulateSymbol('X', candles, plan([5], 30, { maxBars: 100, trailAtrMult: 3 }), 0, 30)
    expect(trade.reason).toBe('stop')
    expect(trade.exitPrice).toBeGreaterThan(100) // stop moved above the entry, locking profit
  })

  it('exits at the next open after a close-based exit signal', () => {
    const candles = flat(20)
    const level = Array(20).fill(null) as (number | null)[]
    level[9] = 99.9 // close 100 >= 99.9 on bar 9
    const [trade] = simulateSymbol('X', candles, plan([5], 20, { maxBars: 50, exitAtOrAbove: level }), 0, 20)
    expect(trade.reason).toBe('signal')
    expect(trade.exitIdx).toBe(10)
  })

  it('closes open positions at the window end instead of dropping them', () => {
    const candles = flat(20)
    const [trade] = simulateSymbol('X', candles, plan([5], 20, { maxBars: 500 }), 0, 12)
    expect(trade.reason).toBe('window_end')
    expect(trade.exitIdx).toBe(12)
  })

  it('never opens a second position while one is open, and skips stop rules without ATR', () => {
    const candles = flat(40)
    const trades = simulateSymbol('X', candles, plan([3, 4, 5, 6], 40, { maxBars: 10 }), 0, 40)
    expect(trades.length).toBe(1)
    const noAtr: EntryPlan = { entries: Array(40).fill(true), exit: { maxBars: 5, atr: Array(40).fill(null), stopAtrMult: 2 } }
    expect(simulateSymbol('X', candles, noAtr, 0, 40)).toHaveLength(0)
  })
})

describe('engine: rotation', () => {
  it('switches symbols at the next open and goes to cash', () => {
    const a = flat(20, 100)
    const b = flat(20, 200)
    const data: MarketData = {
      timeframe: '1h',
      funding: null,
      series: [{ symbol: 'A', candles: a }, { symbol: 'B', candles: b }],
    }
    const targets = Array(20).fill(-1)
    for (let i = 2; i <= 5; i++) targets[i] = 0
    for (let i = 6; i <= 9; i++) targets[i] = 1
    const trades = simulateRotation(data, targets, 0, 20)
    expect(trades.map(t => [t.symbol, t.entryIdx, t.exitIdx])).toEqual([['A', 3, 7], ['B', 7, 11]])
  })
})

describe('indicators are causal and consistent with production', () => {
  const rand = mulberry32(7)
  const candles: Candle[] = Array.from({ length: 400 }, (_, i) => {
    const close = 100 + Math.sin(i / 9) * 4 + rand()
    return bar(i * 900_000, close - 0.2, close + 0.6 + rand(), close - 0.6 - rand(), close, 100 + rand() * 50)
  })

  it('ATR matches the production ATR at every prefix', () => {
    const series = atrSeries(candles, 14)
    for (const end of [20, 60, 150, 399]) {
      const expected = calculateFeatures(candles.slice(0, end + 1)).atr
      expect(series[end]).not.toBeNull()
      expect(series[end]!).toBeCloseTo(expected!, 10)
    }
  })

  it('rolling max excludes the current bar', () => {
    const out = rollingMaxPrev([1, 5, 2, 9, 3, 4, 1], 3)
    expect(out).toEqual([null, null, null, 5, 9, 9, 9])
  })

  it('values at index i do not change when future data is removed', () => {
    const closes = candles.map(c => c.close)
    for (const fn of [(v: number[]) => emaSeries(v, 20), (v: number[]) => smaSeries(v, 20), (v: number[]) => rollingMaxPrev(v, 30)]) {
      const full = fn(closes)
      const cut = fn(closes.slice(0, 250))
      expect(cut).toEqual(full.slice(0, 250))
    }
    expect(smaNullable([null, 1, 2, 3], 2)).toEqual([null, null, 1.5, 2.5])
  })
})

describe('stats', () => {
  const trade = (gross: number, exitTime: number): Trade => ({
    symbol: 'X', entryIdx: 0, exitIdx: 1, entryTime: exitTime - 1, exitTime, entryPrice: 1, exitPrice: 1 + gross, gross, bars: 1, reason: 'time',
  })

  it('subtracts the round-trip cost once per trade', () => {
    const stats = summarize([trade(0.01, 1), trade(-0.01, 2)], 20)
    expect(stats.expectancy).toBeCloseTo(-0.002, 12)
    expect(stats.winRate).toBe(0.5)
  })

  it('bootstrap is deterministic and brackets the mean', () => {
    const rand = mulberry32(3)
    const values = Array.from({ length: 500 }, () => rand() - 0.45)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const ci = bootstrapMeanCI(values, 0.05)!
    expect(ci).toEqual(bootstrapMeanCI(values, 0.05))
    expect(ci.lo).toBeLessThan(mean)
    expect(ci.hi).toBeGreaterThan(mean)
  })
})

describe('data parsing', () => {
  it('parses kline CSV with header and microsecond timestamps', () => {
    const csv = 'open_time,open,high,low,close,volume\n1700000000000000,1,2,0.5,1.5,10,x\n1700000900000000,1.5,2,1,1.2,11,x'
    const candles = parseKlinesCsv(csv)
    expect(candles).toHaveLength(2)
    expect(candles[0].openTime).toBe(1_700_000_000_000)
    expect(candles[1].close).toBe(1.2)
  })

  it('parses funding CSV by column name', () => {
    const csv = 'calc_time,funding_interval_hours,last_funding_rate\n1700000000000,8,0.0001\n1700028800000,8,-0.00005'
    expect(parseFundingCsv(csv)).toEqual([
      { time: 1_700_000_000_000, rate: 0.0001 },
      { time: 1_700_028_800_000, rate: -0.00005 },
    ])
  })

  it('funding percentile at a bar only uses observations published before the bar opens', () => {
    const points = Array.from({ length: 200 }, (_, k) => ({ time: k * 8 * 3_600_000, rate: k % 7 === 0 ? 0.01 : 0.0001 }))
    const pct = fundingPercentiles(points)
    expect(pct[10]).toBeNull() // not enough history
    const candles = Array.from({ length: 900 }, (_, i) => bar(i * 3_600_000, 1, 1, 1, 1))
    const data: MarketData = { timeframe: '1h', series: [{ symbol: 'BTCUSDT', candles }], funding: { BTCUSDT: points } }
    const mapped = fundingPctByBar(buildContext(data), 0)
    // bar 8*100 hours opens exactly when funding point 100 is published: it may be used
    expect(mapped[800 - 1]).toBe(pct[99])
    expect(mapped[800]).toBe(pct[100])
  })
})

// ---------------------------------------------------------------------------
// The most important test: no strategy may look at the future.
// ---------------------------------------------------------------------------

function sampleParams(strategy: Strategy) {
  const grid = strategy.grid
  return [grid[0], grid[Math.floor(grid.length / 2)], grid[grid.length - 1]]
}

const CAUSALITY_SIZES: Record<Timeframe, { total: number; cut: number }> = {
  '15m': { total: 6400, cut: 5600 },
  '1h': { total: 2600, cut: 2000 },
  '4h': { total: 950, cut: 700 },
}

describe('no lookahead: signals at bar i are identical with or without future data', () => {
  const strategies = buildStrategies()
  for (const timeframe of ['15m', '1h', '4h'] as Timeframe[]) {
    const { total, cut } = CAUSALITY_SIZES[timeframe]
    const full = syntheticMarket({ symbols: ['BTCUSDT', 'ETHUSDT'], timeframe, bars: total, seed: 99, mode: 'trend', withFunding: true })
    const truncated: MarketData = {
      ...full,
      series: full.series.map(s => ({ symbol: s.symbol, candles: s.candles.slice(0, cut) })),
    }
    const ctxFull = buildContext(full)
    const ctxCut = buildContext(truncated)

    for (const strategy of strategies.filter(s => s.timeframe === timeframe)) {
      it(`${strategy.id}`, () => {
        let compared = 0
        let fired = 0
        for (const params of sampleParams(strategy)) {
          if (strategy.kind === 'rotation') {
            const a = strategy.targets(ctxFull, params).slice(0, cut)
            const b = strategy.targets(ctxCut, params)
            expect(b).toEqual(a)
            compared += b.length
            fired += b.filter(x => x >= 0).length
          } else {
            full.series.forEach((_, i) => {
              const a = strategy.plan(ctxFull, i, params).entries.slice(0, cut)
              const b = strategy.plan(ctxCut, i, params).entries
              expect(b).toEqual(a)
              compared += b.length
              fired += b.filter(Boolean).length
            })
          }
        }
        expect(compared).toBeGreaterThan(0)
        // Guard against a vacuous pass for strategies that should fire on this data.
        if (!strategy.id.startsWith('s7_') && strategy.id !== 's6_donchian_funding_15m') expect(fired).toBeGreaterThan(0)
      }, 120_000)
    }
  }
})

describe('walk-forward hygiene', () => {
  const market = syntheticMarket({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], timeframe: '1h', bars: 24 * 30 * 27, seed: 5, mode: 'trend' })
  const evalStart = addMonths(market.series[0].candles[0].openTime, 3)
  const folds = buildFolds(market, evalStart, 24)
  const strategy = buildStrategies().find(s => s.id === 's3_donchian_1h')!

  it('builds the expected rolling folds', () => {
    expect(folds).toHaveLength(4)
    for (const f of folds) {
      expect(f.trainFrom).toBeLessThan(f.testFrom)
      expect(f.testFrom).toBeLessThan(f.testTo)
    }
  })

  it('training trades never reach into the out-of-sample window; test trades stay inside it', () => {
    const evaluator = new Evaluator(buildContext(market))
    for (const fold of folds) {
      for (const params of [strategy.grid[0], strategy.grid[strategy.grid.length - 1]]) {
        const train = evaluator.tradesFor(strategy, params, fold.trainFrom, fold.testFrom)
        const test = evaluator.tradesFor(strategy, params, fold.testFrom, fold.testTo)
        for (const t of train) {
          expect(t.entryIdx).toBeGreaterThan(fold.trainFrom)
          expect(t.exitIdx).toBeLessThanOrEqual(fold.testFrom)
        }
        for (const t of test) {
          expect(t.entryIdx).toBeGreaterThan(fold.testFrom)
          expect(t.exitIdx).toBeLessThanOrEqual(fold.testTo)
        }
      }
    }
  })

  it('parameter selection ignores the test window (changing test-period prices changes nothing in training)', () => {
    const tampered: MarketData = {
      ...market,
      series: market.series.map(s => ({
        symbol: s.symbol,
        candles: s.candles.map((c, i) => (i >= folds[0].testFrom ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 } : c)),
      })),
    }
    const a = runStrategy(strategy, market, folds.slice(0, 1), 15)
    const b = runStrategy(strategy, tampered, folds.slice(0, 1), 15)
    expect(b.folds[0].selected).toEqual(a.folds[0].selected)
    expect(b.folds[0].trainStats).toEqual(a.folds[0].trainStats)
  })
})

describe('the harness detects real edges and refuses fake ones', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
  const bars = 24 * 30 * 27
  const strategies = buildStrategies().filter(s => s.timeframe === '1h' && s.id.startsWith('s3_'))

  it('finds profit in a market with persistent trends', () => {
    const market = syntheticMarket({ symbols, timeframe: '1h', bars, seed: 11, mode: 'trend' })
    const folds = buildFolds(market, addMonths(market.series[0].candles[0].openTime, 3), 24)
    const result = runStrategy(strategies[0], market, folds, 15)
    expect(result.pooled['20'].expectancy).toBeGreaterThan(0)
  })

  it('does not qualify anything on a zero-drift random walk', () => {
    for (const seed of [21, 22, 23]) {
      const market = syntheticMarket({ symbols, timeframe: '1h', bars, seed, mode: 'random' })
      const folds = buildFolds(market, addMonths(market.series[0].candles[0].openTime, 3), 24)
      for (const strategy of strategies) {
        const result = runStrategy(strategy, market, folds, 15)
        expect(result.verdict).not.toBe('candidate_for_further_validation')
      }
    }
  })

  it('mean reversion fires on oversold sideways moves (it is not a dead rule)', () => {
    const market = syntheticMarket({ symbols, timeframe: '1h', bars, seed: 31, mode: 'random' })
    const strategy = buildStrategies().find(s => s.id === 's7_meanrev_sideways_1h')!
    const ctx = buildContext(market)
    const loosest = strategy.grid.find(p => p.z === 2 && p.band === 0.04)!
    if (strategy.kind !== 'events') throw new Error('expected an events strategy')
    const entries = strategy.plan(ctx, 0, loosest).entries.filter(Boolean).length
    expect(entries).toBeGreaterThan(20)
    const trades = new Evaluator(ctx).tradesFor(strategy, loosest, 0, market.series[0].candles.length)
    expect(trades.length).toBeGreaterThan(10)
    expect(trades.some(t => t.reason === 'signal')).toBe(true)
  })

  it('grids and timeframes are well-formed', () => {
    for (const s of buildStrategies()) {
      expect(s.grid.length).toBeGreaterThan(0)
      expect(TF_MS[s.timeframe]).toBeGreaterThan(0)
    }
    expect(product({ a: [1, 2], b: ['x', 'y', 'z'] })).toHaveLength(6)
    expect(new Set(buildStrategies().map(s => s.id)).size).toBe(buildStrategies().length)
  })
})
