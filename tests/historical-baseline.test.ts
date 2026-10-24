import { describe, expect, it } from 'vitest'
import rows from './fixtures/btcusdt-15m.json'
import { candleCloseTime, replayLiveSignal, BAR_MS } from '../lib/live-window'
import { completedMonthsWindow, monthKeys, parseKlineCsv } from '../scripts/research/binance-archive'
import { TAIL_BARS, WARMUP_BARS, analyzeHistory, labelPermutationP, quarterOf, replaySignals }
  from '../scripts/research/historical-baseline'

const archive = rows.map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
  low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))

describe('historical archive loading', () => {
  it('parses millisecond and microsecond open times and rejects any unparseable row', () => {
    const ms = Date.UTC(2025, 0, 1)
    const csv = `${ms},1,2,0.5,1.5,10,x\n${(ms + BAR_MS) * 1000},1.5,2,1,1.2,5,x\n`
    expect(parseKlineCsv(csv, 'T').map(c => c.openTime)).toEqual([ms, ms + BAR_MS])
    expect(() => parseKlineCsv(`${csv}${ms + 2 * BAR_MS},1,2,abc,1,1\n`, 'T')).toThrow(/unparseable kline row 3/)
    expect(parseKlineCsv(`open_time,open,high,low,close,volume\n${ms},1,2,0.5,1.5,10`, 'T')).toHaveLength(1)
  })

  it('ends the default window before the unfinished current month', () => {
    const { startMs, endMs } = completedMonthsWindow(36, Date.UTC(2026, 9, 23, 12))
    expect(new Date(startMs).toISOString()).toBe('2023-10-01T00:00:00.000Z')
    expect(new Date(endMs).toISOString()).toBe('2026-09-30T23:59:59.999Z')
    expect(monthKeys(startMs, endMs)).toHaveLength(36)
  })
})

describe('historical v1.1-live replay', () => {
  it('reproduces the live decision on every eligible candle and accounts for every exclusion', () => {
    const { signals, volatility, excluded } = replaySignals('BTCUSDT', archive)
    expect(excluded.warmup + excluded.tail + volatility.length).toBe(archive.length)
    expect(excluded.replay_rejected + excluded.short_window).toBe(0)
    for (let i = WARMUP_BARS; i < archive.length - TAIL_BARS; i++) {
      const live = replayLiveSignal(archive, archive[i].openTime + BAR_MS + 1000)!
      expect(live.sampleSize).toBe(249)
      expect(signals.some(s => s.index === i)).toBe(live.decision === 'LONG')
    }
    for (const signal of signals) expect(signal.time).toBe(candleCloseTime(archive[signal.index]))
  })

  it('measures next-open trades against the same-symbol baseline', () => {
    const replay = replaySignals('BTCUSDT', archive)
    const series = new Map([['BTCUSDT', archive.map(c => ({ ...c, time: candleCloseTime(c) }))]])
    const signals = replay.signals.length ? replay.signals : [{ symbol: 'BTCUSDT', index: 400,
      time: candleCloseTime(archive[400]), score: 80, trendUp: true, volatility: 0.01, priorReturn4h: 0 }]
    const [first] = analyzeHistory(series, signals, new Map([['BTCUSDT', replay.volatility]]),
      { iterations: 200, seed: 1, holdoutEnd: Infinity })
    const s = signals[0]
    const expected = archive[s.index + 2].open / archive[s.index + 1].open - 1
    expect(first.horizon).toBe('15m')
    expect(first.signals).toBe(signals.length)
    if (signals.length === 1) expect(first.next_open).toMatchObject({ next_open_mean: expected })
    expect(first.by_score_bucket.reduce((sum, b) => sum + b.signals, 0)).toBe(signals.length)
  })

  it('finds a real score difference and not a null one', () => {
    const a = Array.from({ length: 300 }, (_, i) => 0.01 + (i % 7) * 1e-4)
    const b = Array.from({ length: 300 }, (_, i) => (i % 7) * 1e-4)
    expect(labelPermutationP(a, b, 500, 3).two_sided).toBeLessThan(0.01)
    expect(labelPermutationP(b.slice(0, 150), b.slice(150), 500, 3).two_sided).toBeGreaterThan(0.2)
    expect(quarterOf(Date.UTC(2024, 8, 30, 23, 59))).toBe('2024-Q3')
  })
})
