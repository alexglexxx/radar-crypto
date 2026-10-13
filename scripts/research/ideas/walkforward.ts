import { buildContext, type Context } from './context'
import { simulateRotation, simulateSymbol } from './engine'
import { bootstrapMeanCI, emptyStats, netReturns, summarize, type TradeStats } from './stats'
import type { EventStrategy, Strategy } from './strategies'
import type { EntryPlan, MarketData, ParamSet, Trade } from './types'

export const COSTS_BPS = [10, 20, 30]
export const PRIMARY_COST_BPS = 20
export const STRESS_COST_BPS = 30

export type Fold = { label: number; trainFrom: number; testFrom: number; testTo: number }

export type FoldResult = {
  fold: number
  train: string
  test: string
  selected: ParamSet | null
  abstainReason: string | null
  trainStats: TradeStats | null
  oos: Record<string, TradeStats>
  /** Same exit rule with NO entry signal (always in the market, back to back). */
  alwaysIn: TradeStats | null
  buyAndHold: number
  trades: Trade[]
}

export type Verdict = 'candidate_for_further_validation' | 'not_qualified' | 'insufficient_sample' | 'skipped'

export type StrategyResult = {
  id: string
  idea: number
  title: string
  hypothesis: string
  timeframe: string
  gridSize: number
  verdict: Verdict
  verdictReasons: string[]
  pooled: Record<string, TradeStats>
  pooledCI: { alpha: number; lo: number; hi: number } | null
  alwaysInPooledExpectancy: number | null
  edgeOverAlwaysIn: number | null
  positiveFolds: number
  foldsWithTrades: number
  totalFolds: number
  exposure: number | null
  buyAndHoldAvg: number | null
  perSymbol: { symbol: string; stats: TradeStats }[]
  exitReasons: Record<string, number>
  folds: Omit<FoldResult, 'trades'>[]
}

function lowerBound(times: number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function addMonths(ms: number, count: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + count, 1)
}

/** Rolling 12-month training / 3-month out-of-sample folds, stepped by 3 months (same layout as the existing research). */
export function buildFolds(data: MarketData, evalStart: number, months: number): Fold[] {
  const times = data.series[0].candles.map(c => c.openTime)
  const folds: Fold[] = []
  for (let offset = 0; offset + 15 <= months; offset += 3) {
    folds.push({
      label: folds.length + 1,
      trainFrom: lowerBound(times, addMonths(evalStart, offset)),
      testFrom: lowerBound(times, addMonths(evalStart, offset + 12)),
      testTo: lowerBound(times, addMonths(evalStart, offset + 15)),
    })
  }
  return folds
}

function planCacheKey(strategyId: string, symbolIndex: number, params: ParamSet): string {
  return `${strategyId}|${symbolIndex}|${JSON.stringify(params)}`
}

export class Evaluator {
  private plans = new Map<string, EntryPlan>()
  private rotationTargets = new Map<string, number[]>()

  constructor(readonly ctx: Context) {}

  tradesFor(strategy: Strategy, params: ParamSet, from: number, to: number): Trade[] {
    if (strategy.kind === 'rotation') {
      const key = strategy.id + '|' + JSON.stringify(params)
      let targets = this.rotationTargets.get(key)
      if (!targets) {
        targets = strategy.targets(this.ctx, params)
        this.rotationTargets.set(key, targets)
      }
      return simulateRotation(this.ctx.data, targets, from, to)
    }
    const trades: Trade[] = []
    this.ctx.symbols.forEach((sc, i) => {
      const key = planCacheKey(strategy.id, i, params)
      let plan = this.plans.get(key)
      if (!plan) {
        plan = strategy.plan(this.ctx, i, params)
        this.plans.set(key, plan)
      }
      trades.push(...simulateSymbol(sc.symbol, sc.candles, plan, from, to))
    })
    return trades
  }

  /** Null model: same exit rule, but enter immediately every time the previous position is closed. */
  alwaysInTrades(strategy: EventStrategy, params: ParamSet, from: number, to: number): Trade[] {
    const trades: Trade[] = []
    this.ctx.symbols.forEach((sc, i) => {
      const key = planCacheKey(strategy.id, i, params)
      const plan = this.plans.get(key) ?? strategy.plan(this.ctx, i, params)
      this.plans.set(key, plan)
      const open: EntryPlan = { entries: sc.candles.map(() => true), exit: plan.exit }
      trades.push(...simulateSymbol(sc.symbol, sc.candles, open, from, to))
    })
    return trades
  }
}

function weightFor(strategy: Strategy, data: MarketData): number {
  return strategy.kind === 'rotation' ? 1 : 1 / data.series.length
}

function buyAndHold(data: MarketData, from: number, to: number): number {
  const returns = data.series.map(({ candles }) => {
    const end = to < candles.length ? candles[to].open : candles[candles.length - 1].close
    return end / candles[from].open - 1
  })
  return returns.reduce((a, b) => a + b, 0) / returns.length
}

function iso(ms: number | undefined): string {
  return ms === undefined ? 'n/a' : new Date(ms).toISOString().slice(0, 10)
}

export function runStrategy(
  strategy: Strategy,
  data: MarketData,
  folds: Fold[],
  totalStrategies: number,
  evaluator = new Evaluator(buildContext(data)),
): StrategyResult {
  const times = data.series[0].candles.map(c => c.openTime)
  const weight = weightFor(strategy, data)
  const foldResults: FoldResult[] = []

  for (const fold of folds) {
    const trainCandidates = strategy.grid
      .map(params => {
        const trades = evaluator.tradesFor(strategy, params, fold.trainFrom, fold.testFrom)
        return { params, stats: summarize(trades, PRIMARY_COST_BPS, weight) }
      })
      .filter(c => c.stats.trades >= strategy.minTrainTrades && (c.stats.tStat ?? -Infinity) > 0)
      .sort((a, b) => (b.stats.tStat ?? -Infinity) - (a.stats.tStat ?? -Infinity))

    const base = {
      fold: fold.label,
      train: `${iso(times[fold.trainFrom])}..${iso(times[fold.testFrom])}`,
      test: `${iso(times[fold.testFrom])}..${iso(times[Math.min(fold.testTo, times.length - 1)])}`,
      buyAndHold: buyAndHold(data, fold.testFrom, fold.testTo),
    }

    // A single-entry grid is a fixed reference rule: always evaluate it, never "select".
    const fixed = strategy.grid.length === 1
    const chosen = fixed ? { params: strategy.grid[0], stats: null as TradeStats | null } : trainCandidates[0]
    if (!chosen) {
      foldResults.push({
        ...base,
        selected: null,
        abstainReason: 'ningún parámetro tuvo ventaja positiva suficiente en entrenamiento',
        trainStats: null,
        oos: Object.fromEntries(COSTS_BPS.map(c => [String(c), emptyStats()])),
        alwaysIn: null,
        trades: [],
      })
      continue
    }

    const oosTrades = evaluator.tradesFor(strategy, chosen.params, fold.testFrom, fold.testTo)
    const alwaysIn =
      strategy.kind === 'events'
        ? summarize(evaluator.alwaysInTrades(strategy, chosen.params, fold.testFrom, fold.testTo), PRIMARY_COST_BPS, weight)
        : null
    foldResults.push({
      ...base,
      selected: chosen.params,
      abstainReason: null,
      trainStats: chosen.stats ?? summarize(evaluator.tradesFor(strategy, chosen.params, fold.trainFrom, fold.testFrom), PRIMARY_COST_BPS, weight),
      oos: Object.fromEntries(COSTS_BPS.map(c => [String(c), summarize(oosTrades, c, weight)])),
      alwaysIn,
      trades: oosTrades,
    })
  }

  const pooledTrades = foldResults.flatMap(f => f.trades)
  const pooled = Object.fromEntries(COSTS_BPS.map(c => [String(c), summarize(pooledTrades, c, weight)]))
  const primary = pooled[String(PRIMARY_COST_BPS)]
  const stress = pooled[String(STRESS_COST_BPS)]
  const alpha = 0.05 / Math.max(1, totalStrategies)
  const ci = pooledTrades.length >= 30
    ? bootstrapMeanCI(netReturns(pooledTrades, PRIMARY_COST_BPS), alpha)
    : null

  const alwaysInStats = foldResults.map(f => f.alwaysIn).filter((s): s is TradeStats => !!s && s.trades > 0)
  const alwaysInTrades = alwaysInStats.reduce((a, s) => a + s.trades, 0)
  const alwaysInExpectancy = alwaysInTrades
    ? alwaysInStats.reduce((a, s) => a + (s.expectancy ?? 0) * s.trades, 0) / alwaysInTrades
    : null
  const edgeOverAlwaysIn =
    primary.expectancy !== null && alwaysInExpectancy !== null ? primary.expectancy - alwaysInExpectancy : null

  const foldsWithTrades = foldResults.filter(f => f.oos[String(PRIMARY_COST_BPS)].trades > 0).length
  const positiveFolds = foldResults.filter(f => (f.oos[String(PRIMARY_COST_BPS)].expectancy ?? -Infinity) > 0).length

  const windowBars = folds.reduce((a, f) => a + (Math.min(f.testTo, times.length) - f.testFrom), 0)
  const slots = strategy.kind === 'rotation' ? 1 : data.series.length
  const exposure = windowBars > 0 ? pooledTrades.reduce((a, t) => a + t.bars, 0) / (windowBars * slots) : null

  const exitReasons: Record<string, number> = {}
  for (const t of pooledTrades) exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1

  const perSymbol = data.series.map(({ symbol }) => ({
    symbol,
    stats: summarize(pooledTrades.filter(t => t.symbol === symbol), PRIMARY_COST_BPS, weight),
  }))

  // ---- verdict ----
  const reasons: string[] = []
  let verdict: Verdict
  if (strategy.grid.length === 1 && strategy.idea === 0) {
    verdict = 'not_qualified'
    reasons.push('Referencia: no se califica, solo sirve para comparar.')
  } else if (primary.trades < 100) {
    verdict = 'insufficient_sample'
    reasons.push(`Solo ${primary.trades} operaciones fuera de muestra; se necesitan al menos 100.`)
  } else {
    const checks: [boolean, string][] = [
      [(primary.expectancy ?? -1) > 0, `Expectativa neta a ${PRIMARY_COST_BPS} bps debe ser > 0`],
      [(stress.expectancy ?? -1) > 0, `Expectativa neta a ${STRESS_COST_BPS} bps (estrés) debe ser > 0`],
      [ci !== null && ci.lo > 0, `Límite inferior del intervalo de confianza (corregido por ${totalStrategies} estrategias) debe ser > 0`],
      [foldsWithTrades > 0 && positiveFolds >= Math.ceil(foldResults.length * 0.6), 'Al menos 60% de los periodos fuera de muestra deben ser positivos'],
      [edgeOverAlwaysIn !== null ? edgeOverAlwaysIn > 0 : true, 'Debe superar a "estar siempre dentro" con la misma salida'],
    ]
    for (const [ok, text] of checks) if (!ok) reasons.push('Falla: ' + text)
    verdict = reasons.length === 0 ? 'candidate_for_further_validation' : 'not_qualified'
  }

  return {
    id: strategy.id,
    idea: strategy.idea,
    title: strategy.title,
    hypothesis: strategy.hypothesis,
    timeframe: strategy.timeframe,
    gridSize: strategy.grid.length,
    verdict,
    verdictReasons: reasons,
    pooled,
    pooledCI: ci ? { alpha, ...ci } : null,
    alwaysInPooledExpectancy: alwaysInExpectancy,
    edgeOverAlwaysIn,
    positiveFolds,
    foldsWithTrades,
    totalFolds: foldResults.length,
    exposure,
    buyAndHoldAvg: foldResults.length ? foldResults.reduce((a, f) => a + f.buyAndHold, 0) / foldResults.length : null,
    perSymbol,
    exitReasons,
    folds: foldResults.map(({ trades: _trades, ...rest }) => rest),
  }
}
