import { describe, expect, it } from 'vitest'
import rows from './fixtures/btcusdt-15m.json'
import { calculateFeatures } from '../lib/features'
import { calculateRadarScore } from '../lib/scoring'
import { replayLiveSignal, replayLiveOutcome, BAR_MS, candleCloseTime } from '../lib/live-window'

const archive = rows.map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
  low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))

describe('v1.1-live rolling history parity', () => {
  it('measures exact gross outcomes and excursions, leaving incomplete horizons unresolved', () => {
    const i = 500, entry = archive[i].close
    for (const bars of [1, 4, 16]) {
      const measured = replayLiveOutcome(archive, i, bars)!
      const path = archive.slice(i + 1, i + bars + 1)
      expect(measured.realized_return).toBe((archive[i + bars].close - entry) / entry)
      expect(measured.max_adverse_excursion).toBe(Math.min(...path.map(c => (c.low - entry) / entry)))
      expect(measured.max_favorable_excursion).toBe(Math.max(...path.map(c => (c.high - entry) / entry)))
      expect(replayLiveOutcome(archive.filter((_, j) => j !== i + 1), i, bars)).toBeNull()
    }
  })

  it('can change LONG decisions after a regime shift without changing any strategy parameter', () => {
    const regimeShift = Array.from({ length: 650 }, (_, i) => {
      const close = i < 300 ? 10_000 : 100 + (i - 300) * 0.04 + Math.sin(i / 8) * 2
      return { openTime: i * BAR_MS, open: close, high: close + 1, low: close - 1,
        close, volume: i % 4 === 0 ? 3000 : 1000 }
    })
    let changed = 0
    for (let i = 550; i < 649; i++) {
      const oldScore = calculateRadarScore(calculateFeatures(regimeShift.slice(0, i + 1)))
      const replay = replayLiveSignal(regimeShift, (i + 1) * BAR_MS + 1000)!
      if ((oldScore.status === 'SETUP LONG') !== (replay.decision === 'LONG')) changed++
    }
    console.log('Synthetic regime-shift LONG decision differences:', changed)
    expect(changed).toBeGreaterThan(0)
  })

  it('quantifies growing-history drift using 1,000 archived real Binance candles', () => {
    let featureChanges = 0, scoreChanges = 0, decisionChanges = 0
    let maxEma200Difference = 0
    for (let i = 249; i < archive.length - 1; i++) {
      const replay = replayLiveSignal(archive, archive[i].openTime + BAR_MS + 1000)!
      const growing = calculateFeatures(archive.slice(0, i + 1))
      const oldScore = calculateRadarScore(growing)
      if (growing.ema_200 !== replay.features.ema_200) featureChanges++
      maxEma200Difference = Math.max(maxEma200Difference, Math.abs(growing.ema_200! - replay.features.ema_200!))
      if (oldScore.score !== replay.score) scoreChanges++
      if ((oldScore.status === 'SETUP LONG') !== (replay.decision === 'LONG')) decisionChanges++
      const liveInput = archive.slice(i - 248, i + 1)
      expect(replay.features).toEqual(calculateFeatures(liveInput))
      expect(replay.sampleSize).toBe(249)
    }
    console.log('Real BTC fixture drift:', { featureChanges, scoreChanges, decisionChanges, maxEma200Difference })
    expect(featureChanges).toBeGreaterThan(0)
  })

  it('uses no future OHLC and rejects gaps, bad candles, stale inputs and insufficient warmup', () => {
    const now = archive[500].openTime + BAR_MS + 1000
    const expected = replayLiveSignal(archive, now)
    const changedFuture = archive.map((c, i) => i > 500 ? { ...c, close: 1e9, high: 1e9 } : c)
    expect(replayLiveSignal(changedFuture, now)).toEqual(expected)
    expect(replayLiveSignal(archive.slice(0, 199), candleCloseTime(archive[198]) + 1001)).toBeNull()
    expect(replayLiveSignal(archive.filter((_, i) => i !== 450), now)).toBeNull()
    expect(replayLiveSignal(archive.map((c, i) => i === 450 ? { ...c, close: NaN } : c), now)).toBeNull()
    expect(replayLiveSignal(archive.slice(0, 501), now + 2 * BAR_MS)).toBeNull()
  })

  it('preserves the unusual 250-closed response and 248-closed boundary conditions', () => {
    const now = archive[500].openTime + BAR_MS
    expect(replayLiveSignal(archive, now)!.sampleSize).toBe(248)
    expect(replayLiveSignal(archive, now + 999)!.signalTimestamp).toBe(candleCloseTime(archive[499]))
    expect(replayLiveSignal(archive, now + 1000)!.signalTimestamp).toBe(candleCloseTime(archive[500]))
    expect(replayLiveSignal(archive.slice(0, 501), now + 1000)!.sampleSize).toBe(250)
  })
})

