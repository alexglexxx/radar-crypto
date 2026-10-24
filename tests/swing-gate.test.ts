import { describe, expect, it } from 'vitest'
import { type Candle } from '../lib/features'
import { BAR_MS } from '../scripts/research/live-baseline-core'
import {
  GATE_V2_RULES, applyOnePosition, buildTradeTable, decisionTime, definitionHash, evaluateSwingCandidate,
  simulateTrade, windowContext, type SwingCandidate, type SwingContext, type SwingStage,
} from '../scripts/research/swing-gate'
import { SWING_CANDIDATES } from '../scripts/research/swing-candidates'

const HOUR = 3_600_000
const START = Date.UTC(2024, 0, 1)
const I = 15

const flat = (n: number): Candle[] => Array.from({ length: n }, (_, k) => (
  { openTime: START + k * BAR_MS, open: 100, high: 100, low: 100, close: 100, volume: 1 }))
const patch = (c: Candle[], k: number, p: Partial<Candle>) => { c[k] = { ...c[k], ...p } }

describe('simulateTrade', () => {
  it('exits at TP for +4 % net', () => {
    const c = flat(400)
    patch(c, I + 5, { high: 104.2 })
    const t = simulateTrade(c, I)!
    expect(t.reason).toBe('tp')
    expect(t.exitIndex).toBe(I + 5)
    expect(t.net).toBeCloseTo(0.04, 10)
    expect(t.netStress).toBeCloseTo(0.039, 10)
    expect(t.exitTime).toBe(c[I + 5].openTime + BAR_MS)
  })

  it('exits at SL for -4 % net', () => {
    const c = flat(400)
    patch(c, I + 5, { low: 96.2 })
    const t = simulateTrade(c, I)!
    expect(t.reason).toBe('sl')
    expect(t.net).toBeCloseTo(-0.04, 10)
  })

  it('counts SL when one candle touches both', () => {
    const c = flat(400)
    patch(c, I + 5, { high: 105, low: 95 })
    expect(simulateTrade(c, I)!.reason).toBe('sl')
  })

  it('fills a gap down at the open', () => {
    const c = flat(400)
    patch(c, I + 5, { open: 90, high: 90, low: 90 })
    const t = simulateTrade(c, I)!
    expect(t.reason).toBe('sl')
    expect(t.net).toBeCloseTo(-0.102, 10)
  })

  it('times out at the open of i+289', () => {
    const t = simulateTrade(flat(400), I)!
    expect(t.reason).toBe('time')
    expect(t.exitIndex).toBe(I + 289)
    expect(t.hours).toBe(72)
    expect(t.net).toBeCloseTo(-0.002, 10)
  })

  it('enters after an outage that starts right after the decision', () => {
    const c = flat(400)
    c.splice(I + 1, 18)
    const t = simulateTrade(c, I)!
    expect(t.entryIndex).toBe(I + 1)
    expect(c[t.entryIndex].openTime).toBe(START + (I + 19) * BAR_MS)
    expect(t.exitTime).toBe(c[t.entryIndex].openTime + 72 * HOUR)
    expect(t.hours).toBe(72)
  })

  it('counts 72 h by clock across an outage inside the trade', () => {
    const c = flat(400)
    c.splice(I + 100, 18)
    const t = simulateTrade(c, I)!
    expect(t.reason).toBe('time')
    expect(t.exitTime).toBe(c[I + 1].openTime + 72 * HOUR)
    expect(t.exitIndex).toBe(I + 289 - 18)
  })

  it('returns null without an exit candle', () => {
    expect(simulateTrade(flat(I + 289), I)).toBeNull()
    expect(simulateTrade(flat(I + 290), I)).not.toBeNull()
    const c = flat(I + 100)
    patch(c, I + 5, { high: 110 })
    expect(simulateTrade(c, I)).toBeNull()
  })
})

describe('trade table', () => {
  it('decides only at 4h closes inside the period', () => {
    const c = flat(1000)
    const start = START + 10 * HOUR + 30 * 60_000, end = START + 30 * HOUR
    const { times, trades } = buildTradeTable(c, start, end)
    expect(times.length).toBe(trades.length)
    expect(times.length).toBeGreaterThan(0)
    for (const t of times) {
      expect(t % (4 * HOUR)).toBe(0)
      expect(t).toBeGreaterThanOrEqual(start)
      expect(t).toBeLessThan(end)
    }
    expect(times).toEqual([START + 12 * HOUR, START + 16 * HOUR, START + 20 * HOUR, START + 24 * HOUR, START + 28 * HOUR])
    expect(decisionTime(c[0])).toBe(START + BAR_MS)
  })

  it('lets a time exit re-enter at the exit close', () => {
    const { nextFree, trades } = buildTradeTable(flat(1500), START, START + 200 * HOUR)
    expect(nextFree[0]).toBe(18)
    expect(trades.length).toBeGreaterThan(18)
  })

  it('applies one position per coin', () => {
    expect(applyOnePosition([true, true, false, true], [2, 2, 3, 4])).toEqual([0, 3])
  })
})

describe('windowContext', () => {
  const ctx: SwingContext = {
    candles: new Map(['BTCUSDT', 'ETHUSDT'].map(s => [s, flat(3500)])),
    funding: new Map(['BTCUSDT', 'ETHUSDT'].map(s => [s,
      Array.from({ length: 150 }, (_, k) => ({ calcTime: START + k * 8 * HOUR, intervalHours: 8, rate: 0.0001 }))])),
  }

  it('keeps the 30 days that end at the decision, for every coin', () => {
    const index = 3199, t = START + 3200 * BAR_MS
    const w = windowContext(ctx, index)
    expect(w.index).toBe(2879)
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      const c = w.ctx.candles.get(symbol)!
      expect(c.length).toBe(2880)
      expect(c[0].openTime).toBe(t - GATE_V2_RULES.lookbackMs)
      expect(c[w.index].openTime).toBe(ctx.candles.get(symbol)![index].openTime)
      const f = w.ctx.funding.get(symbol)!
      // Settled exactly at t is visible; exactly 30 days before t is not.
      expect(f[0].calcTime).toBe(t - GATE_V2_RULES.lookbackMs + 8 * HOUR)
      expect(f.at(-1)!.calcTime).toBe(t)
      expect(f.length).toBe(90)
    }
  })
})

// Synthetic market: 30 warm-up days plus 400 days of 15m candles from a UTC midnight.
const WARMUP = 2880
const LENGTH = WARMUP + 400 * 96
const RULES = { ...GATE_V2_RULES, permutations: 300, leakChecksPerAsset: 50 }
const PERIOD_START = START + WARMUP * BAR_MS
const PERIOD_END = START + LENGTH * BAR_MS
const YEAR_STARTS = [0, 1, 2].map(k => PERIOD_START + k * ((LENGTH - WARMUP) / 3) * BAR_MS)
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']

// Random walk; with `planted`, every 192 bars a decision candle has 10x volume
// and is followed by +0.2 % per bar for 32 bars: an edge visible only from the past.
// The other 160 bars drift -0.04 % each, so the planted market has no trend and
// random 72 h entries (which always span a plant) do not reach TP by themselves.
function synthetic(seed: number, planted: boolean): Candle[] {
  let state = seed >>> 0
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000 }
  const candles: Candle[] = []
  let close = 100, driftUntil = -1
  for (let i = 0; i < LENGTH; i++) {
    const mark = planted && (i + 1) % 192 === 0
    const open = close
    const drift = i <= driftUntil ? 0.002 : planted ? -0.0004 : 0
    close = open * (1 + (next() - 0.5) * 0.004 + drift)
    candles.push({ openTime: START + i * BAR_MS, open, close,
      high: Math.max(open, close) * 1.0005, low: Math.min(open, close) * 0.9995,
      volume: (mark ? 1000 : 100) + next() * 10 })
    if (mark) driftUntil = i + 32
  }
  return candles
}

const market = (planted: boolean): SwingContext => ({
  candles: new Map(SYMBOLS.map((symbol, k) => [symbol, synthetic(1000 + k, planted)])),
  funding: new Map(SYMBOLS.map(symbol => [symbol, []])),
})
const PLANTED = market(true)
const PLAIN = market(false)

const spike: SwingCandidate = {
  id: 'planted-volume-spike', kind: 'control',
  hypothesis: 'Control positivo: compra tras un volumen 5 veces mayor que la vela anterior.',
  decide: (ctx, s, i) => ctx.candles.get(s)![i].volume > 5 * ctx.candles.get(s)![i - 1].volume,
}

const run = (candidate: SwingCandidate, ctx: SwingContext, stage: SwingStage = 'desarrollo') =>
  evaluateSwingCandidate(candidate, ctx,
    { stage, periodStart: PERIOD_START, periodEnd: PERIOD_END, yearStarts: YEAR_STARTS, rules: RULES })
const check = (result: ReturnType<typeof run>, id: string) => result.checks.find(c => c.id === id)!.passed

describe('swing gate evaluation', () => {
  it('approves a planted, past-only edge', () => {
    const result = run(spike, PLANTED)
    expect(result.checks.filter(c => !c.passed)).toEqual([])
    expect(result.verdict).toBe('APRUEBA DESARROLLO')
    expect(result.stage).toBe('desarrollo')
    expect(result.metrics.leak_divergences).toBe(0)
    expect(result.metrics.leak_checks).toBe(200)
    expect(result.metrics.tp_rate).toBeGreaterThan(0.9)
    expect(result.metrics.trades).toBeGreaterThanOrEqual(200)
    expect(result.metrics.excess).toBeGreaterThan(0.03)
    expect(result.metrics.by_year.map(y => y.from)).toEqual(YEAR_STARTS.map(t => new Date(t).toISOString()))
    expect(result.candidate.definition).toBe(definitionHash(spike))
  })

  it('gives CANDIDATO A PAPEL for the same edge in examen', () => {
    const result = run(spike, PLANTED, 'examen')
    expect(result.verdict).toBe('CANDIDATO A PAPEL')
    expect(result.stage).toBe('examen')
  })

  it('rejects swing-random', () => {
    const candidate = SWING_CANDIDATES['swing-random']
    let picks = 0, total = 0
    for (let i = WARMUP; i < LENGTH; i++) {
      if ((i + 1) % 16 !== 0) continue
      total++
      if (candidate.decide(PLANTED, 'ETHUSDT', i)) picks++
    }
    expect(picks / total).toBeGreaterThan(0.12)
    expect(picks / total).toBeLessThan(0.18)
    const result = run(candidate, PLANTED)
    expect(result.verdict).toBe('RECHAZADO')
    expect(check(result, 'beats-random')).toBe(false)
    expect(check(result, 'no-lookahead')).toBe(true)
  })

  it('catches swing-lookahead', () => {
    const result = run(SWING_CANDIDATES['swing-lookahead'], PLAIN)
    expect(result.metrics.excess).toBeGreaterThan(0)
    expect(check(result, 'no-lookahead')).toBe(false)
    expect(result.verdict).toBe('RECHAZADO')
  })

  it('catches swing-btc-lookahead', () => {
    const result = run(SWING_CANDIDATES['swing-btc-lookahead'], PLAIN)
    expect(check(result, 'no-lookahead')).toBe(false)
    expect(result.verdict).toBe('RECHAZADO')
  })

  it('catches a candidate that reads more than 30 days back', () => {
    const deep: SwingCandidate = {
      id: 'reads-31-days', kind: 'control', hypothesis: 'Lee la vela de hace 31 días.',
      decide: (ctx, s, i) => i >= 2976 && ctx.candles.get(s)![i - 2976].close > 0,
    }
    const result = run(deep, PLAIN)
    expect(check(result, 'no-lookahead')).toBe(false)
    expect(result.metrics.leak_divergences).toBeGreaterThan(0)
    expect(result.verdict).toBe('RECHAZADO')
  })

  it('finds no edge for the spike without the plant', () => {
    expect(run(spike, PLAIN).verdict).toBe('RECHAZADO')
  })

  it('rejects a candidate that never buys without throwing', () => {
    const never: SwingCandidate = { id: 'never', kind: 'control', hypothesis: 'Nunca compra.', decide: () => false }
    const result = run(never, PLAIN)
    expect(result.verdict).toBe('RECHAZADO')
    const m = result.metrics
    expect(m.trades).toBe(0)
    for (const v of [m.excess, m.p_outperformance, m.mean_net, m.baseline_net, m.net_cost, m.net_stress_cost,
      m.tp_rate, m.sl_rate, m.timeout_rate, m.mean_hours]) expect(v).toBeNull()
    expect(check(result, 'sample')).toBe(false)
    expect(m.random.tp_rate).toBeGreaterThan(0)
    expect(JSON.stringify(result, (_, v) => typeof v === 'number' && !Number.isFinite(v) ? 'NOT_FINITE' : v))
      .not.toContain('NOT_FINITE')
  })

  it('rejects assets on different grids', () => {
    const eth = PLAIN.candles.get('ETHUSDT')!
    const candles = new Map(PLAIN.candles)
    candles.set('ETHUSDT', [...eth.slice(0, 5000), ...eth.slice(5001)])
    expect(() => run(spike, { candles, funding: PLAIN.funding })).toThrow(/identical time grid/)
  })

  it('refuses a period without decision points', () => {
    expect(() => evaluateSwingCandidate(spike, PLAIN, { stage: 'desarrollo', periodStart: PERIOD_END,
      periodEnd: PERIOD_END, yearStarts: [PERIOD_END], rules: RULES })).toThrow(/No decision points/)
  })

  it('keeps the same hash for the same definition', () => {
    const hash = definitionHash(spike)
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
    expect(definitionHash({ ...spike })).toBe(hash)
    expect(definitionHash({ ...spike, decide: (ctx, s, i) => ctx.candles.get(s)![i].volume > 6 })).not.toBe(hash)
    expect(definitionHash({ ...spike, hypothesis: 'otra' })).not.toBe(hash)
  })
})
