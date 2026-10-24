import { describe, expect, it } from 'vitest'
import { type Candle } from '../lib/features'
import { BAR_MS } from '../scripts/research/live-baseline-core'
import { applyOnePosition, buildTradeTable, decisionTime, simulateTrade } from '../scripts/research/swing-gate'

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
