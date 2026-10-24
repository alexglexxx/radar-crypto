import { describe, expect, it } from 'vitest'
import { type Candle } from '../lib/features'
import { BAR_MS } from '../scripts/research/live-baseline-core'
import {
  GATE_V2_RULES, applyOnePosition, buildTradeTable, decisionTime, definitionHash, evaluateSwingCandidate,
  firstIndexAtOrAfter, freezeContext, outageDrill, shiftPValue, simulateTrade, windowContext, type SwingCandidate,
  type SwingContext, type SwingStage, type SwingTrade, type TradeTable,
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

describe('firstIndexAtOrAfter', () => {
  it('finds the first candle at or after a time, across an outage', () => {
    const c = flat(100)
    c.splice(40, 18)
    expect(firstIndexAtOrAfter(c, START)).toBe(0)
    expect(firstIndexAtOrAfter(c, START - 1)).toBe(0)
    expect(firstIndexAtOrAfter(c, START + 10 * BAR_MS)).toBe(10)
    expect(firstIndexAtOrAfter(c, START + 10 * BAR_MS + 1)).toBe(11)
    // Inside the outage the next existing candle is the first after it.
    expect(firstIndexAtOrAfter(c, START + 45 * BAR_MS)).toBe(40)
    expect(c[40].openTime).toBe(START + 58 * BAR_MS)
    expect(firstIndexAtOrAfter(c, START + 99 * BAR_MS)).toBe(81)
    expect(firstIndexAtOrAfter(c, START + 100 * BAR_MS)).toBe(82)
    expect(firstIndexAtOrAfter([], START)).toBe(0)
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
    // 25 spread points plus 25 buy points per coin; points in both count once.
    expect(result.metrics.leak_checks).toBeGreaterThan(150)
    expect(result.metrics.leak_checks).toBeLessThanOrEqual(200)
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
    // Half of the sample sits on its buy points, where it reads the future.
    expect(result.metrics.leak_divergences).toBeGreaterThanOrEqual(80)
    expect(result.verdict).toBe('RECHAZADO')
  })

  it('catches a candidate that peeks at the next funding settlement', () => {
    const funding = new Map(SYMBOLS.map((s, k) => [s, Array.from({ length: 1400 }, (_, j) => (
      { calcTime: START + j * 8 * HOUR, intervalHours: 8, rate: (((j * 7919 + k) % 13) - 6) * 1e-5 }))]))
    const peek: SwingCandidate = {
      id: 'next-funding', kind: 'control', hypothesis: 'Mira el próximo funding.',
      decide: (ctx, s, i) => {
        const t = decisionTime(ctx.candles.get(s)![i])
        const next = ctx.funding.get(s)!.find(p => p.calcTime > t)
        return next != null && next.rate < 0
      },
    }
    const result = run(peek, { candles: PLAIN.candles, funding })
    expect(result.metrics.decisions).toBeGreaterThan(0)
    expect(check(result, 'no-lookahead')).toBe(false)
  })

  it('counts a tie as reaching the observed excess: buying always gets p = 1', () => {
    const always: SwingCandidate = { id: 'always', kind: 'control', hypothesis: 'Compra siempre.', decide: () => true }
    const result = run(always, PLAIN)
    expect(result.metrics.p_outperformance).toBe(1)
    // A positive excess alone is not enough to beat random.
    expect(result.metrics.excess).toBeGreaterThan(0)
    expect(check(result, 'beats-random')).toBe(false)
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

  it('aborts when the candidate throws in the main pass', () => {
    const thrower: SwingCandidate = {
      id: 'thrower', kind: 'control', hypothesis: 'Lanza un error.',
      decide: (ctx, s, i) => { if (i > WARMUP + 500) throw new Error('boom in decide'); return false },
    }
    expect(() => run(thrower, PLAIN)).toThrow(/boom in decide/)
  })

  it('keeps the same hash for the same definition', () => {
    const hash = definitionHash(spike)
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
    expect(definitionHash({ ...spike })).toBe(hash)
    expect(definitionHash({ ...spike, decide: (ctx, s, i) => ctx.candles.get(s)![i].volume > 6 })).not.toBe(hash)
    expect(definitionHash({ ...spike, hypothesis: 'otra' })).not.toBe(hash)
  })
})

describe('freezeContext', () => {
  it('stops a candidate from mutating data the next candidate reads', () => {
    const ctx = freezeContext({
      candles: new Map([['BTCUSDT', flat(10)]]),
      funding: new Map([['BTCUSDT', [{ calcTime: START, intervalHours: 8, rate: 0.0001 }]]]),
    })
    const candles = ctx.candles.get('BTCUSDT')!, funding = ctx.funding.get('BTCUSDT')!
    expect(() => { candles[0].close = 1 }).toThrow(TypeError)
    expect(() => { candles.push(candles[0]) }).toThrow(TypeError)
    expect(() => { candles.sort((a, b) => b.openTime - a.openTime) }).toThrow(TypeError)
    expect(() => { funding[0].rate = 1 }).toThrow(TypeError)
    expect(() => { funding.pop() }).toThrow(TypeError)
    expect(candles[0].close).toBe(100)
    expect(windowContext(ctx, 9).ctx.candles.get('BTCUSDT')!.length).toBe(10)
  })
})

describe('outageDrill', () => {
  const DAY = 24 * HOUR
  // Exam-like outages three years before the synthetic market; shifted +3 years they land in it.
  const shiftedFrom = (iso: string) => { const d = new Date(iso); d.setUTCFullYear(d.getUTCFullYear() + 3); return d.getTime() }
  const outages = [
    { from: '2021-03-10T04:15:00.000Z', to: '2021-03-10T08:30:00.000Z', bars: 18 },
    { from: '2021-08-13T01:00:00.000Z', to: '2021-08-13T05:15:00.000Z', bars: 18 },
  ]
  const options = { periodStart: PERIOD_START, periodEnd: PERIOD_END, rules: RULES }
  const byCandles: SwingCandidate = {
    id: 'counts-candles', kind: 'strategy', hypothesis: 'Compara con la vela de hace 2879 velas.',
    decide: (ctx, s, i) => ctx.candles.get(s)![i].close > ctx.candles.get(s)![i - 2879].close,
  }
  const byTime: SwingCandidate = {
    id: 'reads-by-time', kind: 'strategy', hypothesis: 'Compara con la primera vela de los últimos 30 días.',
    decide: (ctx, s, i) => {
      const c = ctx.candles.get(s)!
      return c[i].close > c[firstIndexAtOrAfter(c, decisionTime(c[i]) - 30 * DAY)].close
    },
  }

  it('shifts each outage by three years and removes it from every coin', () => {
    expect(shiftedFrom(outages[0].from)).toBe(Date.UTC(2024, 2, 10, 4, 15))
    const drill = outageDrill(byTime, PLAIN, outages, options)
    expect(drill.removed).toBe(36)
    expect(PLAIN.candles.get('BTCUSDT')!.length).toBe(LENGTH)
  })

  it('catches a candidate that counts 30 days by candles', () => {
    // Without outages the same candidate never diverges, as on development data.
    expect(outageDrill(byCandles, PLAIN, [], options).leaks).toBe(0)
    const drill = outageDrill(byCandles, PLAIN, outages, options)
    expect(drill.checks).toBeGreaterThan(0)
    expect(drill.leaks).toBeGreaterThan(0)
  })

  it('passes a candidate that reads the window by time', () => {
    const drill = outageDrill(byTime, PLAIN, outages, options)
    expect(drill.checks).toBeGreaterThan(150)
    expect(drill.leaks).toBe(0)
  })

  it('counts a throw on the full context as a divergence', () => {
    // Shifted into the warm-up, the outage pulls the first decision below index 2879.
    const early = [{ from: '2021-01-05T00:00:00.000Z', to: '2021-01-05T04:15:00.000Z', bars: 18 }]
    expect(outageDrill(byCandles, PLAIN, early, options).leaks).toBeGreaterThan(0)
    expect(outageDrill(byTime, PLAIN, early, options).leaks).toBe(0)
  })
})

describe('shiftPValue', () => {
  const table = (nets: number[], nextFree: number[]): TradeTable => ({
    trades: nets.map(net => ({ net }) as SwingTrade), times: nets.map((_, k) => k), nextFree })
  const N = 10, SEED = 7
  // The same xorshift the gate uses: one draw per coin per shift.
  const shifts = (n: number) => {
    let state = SEED >>> 0
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000 }
    return Array.from({ length: N }, () => 1 + Math.floor(next() * (n - 1)))
  }

  it('counts ties as reaching the observed excess and adds one to both sides', () => {
    // Shift 1 moves the buy onto an equal trade (a tie); shift 2 onto a worse one.
    const tables = new Map([['A', table([0.3, 0.3, 0.1], [1, 2, 3])]])
    const result = shiftPValue(new Map([['A', [true, false, false]]]), tables, new Map([['A', 0.2]]), N, SEED)
    const ties = shifts(3).filter(s => s === 1).length
    expect(ties).toBeGreaterThan(0)
    expect(ties).toBeLessThan(N)
    expect(result.excess).toBeCloseTo(0.1, 12)
    expect(result.p).toBe((ties + 1) / (N + 1))
  })

  it('reapplies the one-position rule after each shift', () => {
    // Entry 0 blocks entry 1. Shift 1 buys 1 and then 2 (+0.9 and -1), which loses;
    // moving only the taken trade would have landed on +0.9 alone and counted.
    const tables = new Map([['A', table([0.2, 0.9, -1, 0], [2, 2, 3, 4])]])
    const result = shiftPValue(new Map([['A', [true, true, false, false]]]), tables, new Map([['A', 0.025]]), N, SEED)
    expect(shifts(4).filter(s => s === 1).length).toBeGreaterThan(0)
    expect(result.excess).toBeCloseTo(0.175, 12)
    expect(result.p).toBe(1 / (N + 1))
  })

  it('has no excess and no p without trades', () => {
    const tables = new Map([['A', table([0.1, 0.2], [1, 2])]])
    expect(shiftPValue(new Map([['A', [false, false]]]), tables, new Map([['A', 0.15]]), N, SEED))
      .toEqual({ excess: null, p: null })
  })
})
