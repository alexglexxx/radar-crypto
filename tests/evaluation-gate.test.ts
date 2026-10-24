import { describe, expect, it } from 'vitest'
import { type Candle } from '../lib/features'
import { BAR_MS, candleCloseTime, replayLiveSignal } from '../lib/live-window'
import { GATE_RULES, evaluateCandidate, renderFiche, type Candidate } from '../scripts/research/evaluation-gate'
import { CANDIDATES, HIGH_VOLATILITY_CUT, liveWindowDecision } from '../scripts/research/gate-candidates'
import rows from './fixtures/btcusdt-15m.json'

const START = Date.UTC(2024, 0, 1)
const LENGTH = 6000
const RULES = { ...GATE_RULES, permutations: 300, leakChecksPerAsset: 50 }
const FOLDS = [0, 1, 2].map(k => START + Math.floor(k * LENGTH / 3) * BAR_MS)

// Random walk; with `planted`, a 10x volume candle every 40 bars is followed
// by a +0.15 % drift per bar for 17 bars: an edge visible only from the past.
function synthetic(seed: number, planted: boolean): Candle[] {
  let state = seed >>> 0
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000 }
  const drift = new Set<number>(), marks = new Set<number>()
  if (planted) {
    for (let i = 300; i < LENGTH - 20; i += 40) {
      marks.add(i)
      for (let j = i + 1; j <= i + 17; j++) drift.add(j)
    }
  }
  const candles: Candle[] = []
  let close = 100
  for (let i = 0; i < LENGTH; i++) {
    const open = close
    close = open * (1 + (next() - 0.5) * 0.004 + (drift.has(i) ? 0.0015 : 0))
    candles.push({ openTime: START + i * BAR_MS, open, close,
      high: Math.max(open, close) * 1.0005, low: Math.min(open, close) * 0.9995,
      volume: marks.has(i) ? 1000 : 100 + next() * 10 })
  }
  return candles
}

const market = (planted: boolean) => new Map(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
  .map((symbol, k) => [symbol, synthetic(1000 + k, planted)]))

const volumeSpike: Candidate = {
  id: 'planted-volume-spike', kind: 'control', horizon: '4h',
  hypothesis: 'Positive control: buy after a 5x volume spike.',
  decide: (archive, i) => archive[i].volume > 5 * archive[i - 1].volume,
}

const verdict = (candidate: Candidate, planted: boolean) =>
  evaluateCandidate(candidate, market(planted), { foldStarts: FOLDS, seed: 7, rules: RULES })

describe('evaluation gate', () => {
  it('approves a real, past-only edge (positive control)', () => {
    const result = verdict(volumeSpike, true)
    expect(result.checks.filter(c => !c.passed)).toEqual([])
    expect(result.verdict).toBe('CANDIDATO A PAPEL')
    expect(result.metrics.leak_divergences).toBe(0)
    // 16 drift bars (+2.4 %) minus a baseline that also catches drift (~+1 %).
    expect(result.metrics.excess).toBeGreaterThan(0.01)
  })

  it('rejects random entries (null control)', () => {
    const result = verdict(CANDIDATES['control-random'], true)
    expect(result.verdict).toBe('RECHAZADO')
    expect(result.checks.find(c => c.id === 'beats-random')!.passed).toBe(false)
    expect(result.checks.find(c => c.id === 'no-lookahead')!.passed).toBe(true)
  })

  it('catches a candidate that reads the future even though it looks perfect', () => {
    const result = verdict(CANDIDATES['control-lookahead'], false)
    expect(result.metrics.excess).toBeGreaterThan(0)
    expect(result.checks.find(c => c.id === 'no-lookahead')!.passed).toBe(false)
    expect(result.verdict).toBe('RECHAZADO')
  })

  it('finds no edge for the planted signal on data without the edge', () => {
    expect(verdict(volumeSpike, false).verdict).toBe('RECHAZADO')
  })

  it('writes a fiche with every check', () => {
    const fiche = renderFiche(verdict(volumeSpike, true),
      { period: 'test', commit: 'abc1234', generatedAt: '2026-10-24', data: 'synthetic' })
    expect(fiche).toContain('**Veredicto: CANDIDATO A PAPEL**')
    for (const label of ['No mira el futuro', 'Muestra suficiente', 'Le gana al azar', 'Gana después de comisiones',
      'Estable en el tiempo', 'No depende de una sola moneda']) expect(fiche).toContain(`| ${label} |`)
  })
})

describe('v1.1-live gate candidate', () => {
  const archive: Candle[] = rows.map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
    low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))

  it('reproduces the live replay decision on real candles while reading only the past', () => {
    let longs = 0
    for (let i = 248; i < archive.length - 1; i++) {
      const live = replayLiveSignal(archive, archive[i].openTime + BAR_MS + 1000)
      const expected = live && live.signalTimestamp === candleCloseTime(archive[i]) && live.sampleSize === 249 ? live : null
      const gate = liveWindowDecision(archive, i)
      expect(gate?.score).toBe(expected?.score)
      expect(gate?.decision).toBe(expected?.decision)
      expect(liveWindowDecision(archive.slice(0, i + 1), i)?.decision).toBe(gate?.decision)
      if (gate?.decision === 'LONG') longs++
    }
    expect(longs).toBeGreaterThan(0)
  })

  it('v1.2-trend-vol keeps only v1.1-live LONGs in an uptrend with high volatility', () => {
    const candidate = CANDIDATES['v1.2-trend-vol']
    let kept = 0, dropped = 0
    for (let i = 248; i < archive.length - 1; i++) {
      const gate = liveWindowDecision(archive, i)
      const f = gate?.features
      const expected = gate?.decision === 'LONG' && f!.ema_50! > f!.ema_200! && f!.volatility! >= HIGH_VOLATILITY_CUT
      expect(candidate.decide(archive, i)).toBe(expected)
      expect(candidate.decide(archive.slice(0, i + 1), i)).toBe(expected)
      if (gate?.decision === 'LONG') expected ? kept++ : dropped++
    }
    expect(dropped).toBeGreaterThan(0)
  })
})
