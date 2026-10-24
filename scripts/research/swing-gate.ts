import { createHash } from 'node:crypto'
import { type Candle } from '../../lib/features'
import { BAR_MS, mean } from './live-baseline-core'
import { type FundingPoint } from './funding-archive'
import { pct, type Check } from './evaluation-gate'

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

// Fingerprint of what the candidate claims and does; a changed definition needs a new id.
export function definitionHash(candidate: SwingCandidate): string {
  return createHash('sha256').update(candidate.hypothesis + candidate.decide.toString()).digest('hex').slice(0, 12)
}

// Cuts every series to what is published in the lookback that ends at the decision
// of candles[index]. Assumes one identical time grid, so one index serves every coin.
export function windowContext(ctx: SwingContext, index: number, rules: SwingRules = GATE_V2_RULES) {
  const grid = ctx.candles.values().next().value as Candle[]
  const t = decisionTime(grid[index]), from = t - rules.lookbackMs
  let lo = 0, hi = index
  while (lo < hi) { const mid = (lo + hi) >> 1; if (grid[mid].openTime >= from) hi = mid; else lo = mid + 1 }
  const candles = new Map([...ctx.candles].map(([s, c]) => [s, c.slice(lo, index + 1)]))
  const funding = new Map([...ctx.funding].map(([s, f]) => [s, f.filter(p => p.calcTime > from && p.calcTime <= t)]))
  return { ctx: { candles, funding } as SwingContext, index: index - lo }
}

export type SwingStage = 'desarrollo' | 'examen'

type Rates = { tp_rate: number; sl_rate: number; timeout_rate: number; mean_hours: number }

export type SwingResult = {
  candidate: { id: string; kind: SwingCandidate['kind']; hypothesis: string; definition: string }
  stage: SwingStage
  rules: SwingRules
  verdict: 'APRUEBA DESARROLLO' | 'CANDIDATO A PAPEL' | 'RECHAZADO'
  checks: Check[]
  metrics: {
    decisions: number; trades: number; leak_checks: number; leak_divergences: number
    mean_net: number | null; baseline_net: number | null; excess: number | null; p_outperformance: number | null
    net_cost: number | null; net_stress_cost: number | null
    tp_rate: number | null; sl_rate: number | null; timeout_rate: number | null; mean_hours: number | null
    random: Rates
    by_asset: { symbol: string; trades: number; excess: number | null; tp_rate: number | null }[]
    by_year: { from: string; to: string; trades: number; excess: number | null }[]
  }
}

const rates = (trades: SwingTrade[]): Rates => ({
  tp_rate: trades.filter(t => t.reason === 'tp').length / trades.length,
  sl_rate: trades.filter(t => t.reason === 'sl').length / trades.length,
  timeout_rate: trades.filter(t => t.reason === 'time').length / trades.length,
  mean_hours: mean(trades.map(t => t.hours)),
})

// A throw on either side counts as a divergence: reading outside the window fails here.
function sameDecision(candidate: SwingCandidate, ctx: SwingContext, symbol: string, index: number, rules: SwingRules) {
  const window = windowContext(ctx, index, rules)
  try { return candidate.decide(ctx, symbol, index) === candidate.decide(window.ctx, symbol, window.index) } catch { return false }
}

// Pooled excess of the trades taken from a selection, summed in coin order and then
// table order. The observed value and every shift go through this same expression,
// so a shift that takes the same trades ties exactly instead of by the last ulp.
function pooledExcess(selected: Map<string, boolean[]>, tables: Map<string, TradeTable>, baseline: Map<string, number>) {
  let sum = 0, base = 0, count = 0
  for (const [symbol, sel] of selected) {
    const table = tables.get(symbol)!
    for (const k of applyOnePosition(sel, table.nextFree)) { sum += table.trades[k].net; base += baseline.get(symbol)!; count++ }
  }
  return count > 0 ? (sum - base) / count : null
}

// Each coin is shifted on its own, then the one-position rule is reapplied:
// the null keeps how often and how clustered the candidate buys, not when.
// One-sided: shifts that reach the observed excess (ties included) count against it.
export function shiftPValue(selected: Map<string, boolean[]>, tables: Map<string, TradeTable>,
  baseline: Map<string, number>, permutations: number, seed: number) {
  const excess = pooledExcess(selected, tables, baseline)
  if (excess == null) return { excess, p: null }
  let state = seed >>> 0, upper = 0
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000 }
  for (let it = 0; it < permutations; it++) {
    const shifted = new Map([...selected].map(([symbol, sel]) => {
      const n = sel.length, shift = 1 + Math.floor(next() * (n - 1))
      return [symbol, sel.map((_, k) => sel[(k - shift + n) % n])]
    }))
    const sample = pooledExcess(shifted, tables, baseline)
    if (sample != null && sample >= excess) upper++
  }
  return { excess, p: (upper + 1) / (permutations + 1) }
}

type Options = { stage: SwingStage; periodStart: number; periodEnd: number; yearStarts: number[]; rules?: SwingRules }
type Taken = { symbol: string; time: number; trade: SwingTrade }

// ctx: closed 15m candles of every coin on one identical time grid, plus funding.
// yearStarts: decision times where each year begins; the last year runs to periodEnd.
export function evaluateSwingCandidate(candidate: SwingCandidate, ctx: SwingContext,
  { stage, periodStart, periodEnd, yearStarts, rules = GATE_V2_RULES }: Options): SwingResult {
  const symbols = [...ctx.candles.keys()]
  const grid0 = ctx.candles.get(symbols[0])!
  for (const symbol of symbols) {
    const candles = ctx.candles.get(symbol)!
    if (candles.length !== grid0.length || candles.some((c, i) => c.openTime !== grid0[i].openTime)) {
      throw new Error('Assets need an identical time grid')
    }
  }
  const tables = new Map(symbols.map(s => [s, buildTradeTable(ctx.candles.get(s)!, periodStart, periodEnd, rules)]))
  const times = tables.get(symbols[0])!.times
  if (!times.length) throw new Error('No decision points in the period')
  const baseline = new Map(symbols.map(s => [s, mean(tables.get(s)!.trades.map(t => t.net))]))

  // 1. Decisions on every table entry (a throw aborts the run), then one position per coin.
  let decisions = 0
  const selected = new Map<string, boolean[]>()
  const taken: Taken[] = []
  for (const symbol of symbols) {
    const table = tables.get(symbol)!
    const sel = table.trades.map(t => candidate.decide(ctx, symbol, t.decisionIndex))
    decisions += sel.filter(Boolean).length
    selected.set(symbol, sel)
    for (const k of applyOnePosition(sel, table.nextFree)) taken.push({ symbol, time: table.times[k], trade: table.trades[k] })
  }

  // 2. Lookahead: the decision must not change when every series keeps only the lookback.
  // Half the sample spreads over every decision point, half over the candidate's buys.
  let leakChecks = 0, leaks = 0
  const spread = (items: number[], count: number) => {
    const length = Math.min(count, items.length)
    return Array.from({ length }, (_, k) => items[Math.floor((k + 0.5) * items.length / length)])
  }
  for (const symbol of symbols) {
    const { trades } = tables.get(symbol)!, sel = selected.get(symbol)!
    const all = trades.map((_, k) => k), buys = all.filter(k => sel[k])
    const half = Math.floor(rules.leakChecksPerAsset / 2)
    for (const k of new Set([...spread(all, half), ...spread(buys, rules.leakChecksPerAsset - half)])) {
      leakChecks++
      if (!sameDecision(candidate, ctx, symbol, trades[k].decisionIndex, rules)) leaks++
    }
  }

  const excessOf = (group: Taken[], base: (t: Taken) => number) =>
    group.length ? mean(group.map(t => t.trade.net)) - mean(group.map(base)) : null
  const meanNet = taken.length ? mean(taken.map(t => t.trade.net)) : null
  const baselineNet = taken.length ? mean(taken.map(t => baseline.get(t.symbol)!)) : null
  const { excess, p } = shiftPValue(selected, tables, baseline, rules.permutations, rules.seed)

  const byAsset = symbols.map(symbol => {
    const group = taken.filter(t => t.symbol === symbol)
    return { symbol, trades: group.length, excess: excessOf(group, () => baseline.get(symbol)!),
      tp_rate: group.length ? rates(group.map(t => t.trade)).tp_rate : null }
  })
  // Each year is judged against the same coin's random entries inside that year.
  const byYear = yearStarts.map((start, y) => {
    const end = yearStarts[y + 1] ?? periodEnd
    const inYear = (t: number) => t >= start && t < end
    const yearBase = new Map(symbols.map(s => {
      const table = tables.get(s)!
      const nets = table.trades.filter((_, k) => inYear(table.times[k])).map(t => t.net)
      return [s, nets.length ? mean(nets) : 0]
    }))
    const group = taken.filter(t => inYear(t.time))
    const lastTime = times.filter(inYear).at(-1)
    return { from: new Date(start).toISOString(), to: lastTime == null ? '—' : new Date(lastTime).toISOString(),
      trades: group.length, excess: excessOf(group, t => yearBase.get(t.symbol)!) }
  })

  const ownRates = taken.length ? rates(taken.map(t => t.trade)) : null
  const netStress = taken.length ? mean(taken.map(t => t.trade.netStress)) : null
  const positiveAssets = byAsset.filter(a => a.excess != null && a.excess > 0).length
  const positiveYears = byYear.filter(y => y.excess != null && y.excess > 0).length
  const checks: Check[] = [
    { id: 'no-lookahead', label: 'No mira el futuro (ni más de 30 días atrás)', passed: leaks === 0,
      value: `${leaks} de ${leakChecks} puntos cambian`, required: '0 cambios' },
    { id: 'sample', label: 'Muestra suficiente', passed: taken.length >= rules.minTrades,
      value: `${taken.length} operaciones (${decisions} decisiones de compra)`, required: `≥ ${rules.minTrades}` },
    { id: 'beats-random', label: 'Le gana al azar', passed: excess != null && excess > 0 && p != null && p < rules.alpha,
      value: `${pct(excess)} por operación (p ${p == null ? '—' : p.toFixed(3)})`, required: `> 0 y p < ${rules.alpha}` },
    { id: 'net-of-costs', label: 'Gana después de comisiones', passed: meanNet != null && meanNet > 0,
      value: `${pct(meanNet)} con ${rules.costRoundTrip * 1e4} bps (${pct(netStress)} con ${rules.stressCostRoundTrip * 1e4} bps)`,
      required: '> 0' },
    { id: 'stable', label: 'Estable en el tiempo', passed: positiveYears === byYear.length,
      value: `${positiveYears} de ${byYear.length} años le ganan al azar`, required: `${byYear.length} de ${byYear.length}` },
    { id: 'breadth', label: 'No depende de una sola moneda', passed: positiveAssets >= rules.minPositiveAssets,
      value: `${positiveAssets} de ${symbols.length} monedas le ganan al azar`, required: `≥ ${rules.minPositiveAssets}` },
  ]
  const passed = checks.every(c => c.passed)

  return {
    candidate: { id: candidate.id, kind: candidate.kind, hypothesis: candidate.hypothesis, definition: definitionHash(candidate) },
    stage,
    rules,
    verdict: !passed ? 'RECHAZADO' : stage === 'examen' ? 'CANDIDATO A PAPEL' : 'APRUEBA DESARROLLO',
    checks,
    metrics: {
      decisions, trades: taken.length, leak_checks: leakChecks, leak_divergences: leaks,
      mean_net: meanNet, baseline_net: baselineNet, excess, p_outperformance: p,
      net_cost: meanNet, net_stress_cost: netStress,
      tp_rate: ownRates?.tp_rate ?? null, sl_rate: ownRates?.sl_rate ?? null,
      timeout_rate: ownRates?.timeout_rate ?? null, mean_hours: ownRates?.mean_hours ?? null,
      random: rates(symbols.flatMap(s => tables.get(s)!.trades)),
      by_asset: byAsset, by_year: byYear,
    },
  }
}
