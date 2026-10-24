import { describe, expect, it } from 'vitest'
import { definitionHash, GATE_V2_RULES, type SwingCandidate, type SwingResult } from '../scripts/research/swing-gate'
import {
  assertStageAllowed, parseRegistryV2, renderSwingFiche, REGISTRY_V2_HEADER, STAGES, swingRegistryRow,
  type RegistryV2Row, type SwingContextInfo,
} from '../scripts/research/swing-registry'

const cand = (id: string, kind: SwingCandidate['kind'] = 'strategy', body = 'return true'): SwingCandidate =>
  ({ id, kind, hypothesis: `idea ${id}`, decide: new Function(body) as SwingCandidate['decide'] })

const row = (c: SwingCandidate, stage: 'desarrollo' | 'examen', verdict: string, definition = definitionHash(c)): RegistryV2Row => ({
  date: '2026-10-24T00:00:00.000Z', candidate: c.id, kind: c.kind, stage, rules: 'gate-v2', period: 'p', commit: 'abc',
  definition, verdict, trades: '250', excess: '', p_outperformance: '', net_cost: '', tp_rate: '', sl_rate: '',
  timeout_rate: '', leak_divergences: '0',
})

const info: SwingContextInfo = {
  period: '2023-10 a 2026-09', commit: 'abc1234', generatedAt: '2026-10-24T12:00:00.000Z', data: 'archivo 15m',
  outages: [{ from: '2021-04-25T04:15:00.000Z', to: '2021-04-25T08:30:00.000Z', bars: 18 }],
}

const rates = { tp_rate: 0.4, sl_rate: 0.35, timeout_rate: 0.25, mean_hours: 30 }
const result = (over: Partial<SwingResult['metrics']> = {}, verdict: SwingResult['verdict'] = 'APRUEBA DESARROLLO'): SwingResult => {
  const c = cand('m1')
  return {
    candidate: { id: 'm1', kind: 'strategy', hypothesis: c.hypothesis, definition: definitionHash(c) },
    stage: 'desarrollo', rules: GATE_V2_RULES, verdict,
    checks: ['A', 'B', 'C', 'D', 'E', 'F'].map(l => ({ id: l, label: `Prueba ${l}`, passed: true, value: 'v', required: 'r' })),
    metrics: {
      decisions: 300, trades: 250, leak_checks: 800, leak_divergences: 0, mean_net: 0.01, baseline_net: 0.002,
      excess: 0.008, p_outperformance: 0.01, net_cost: 0.01, net_stress_cost: 0.009, ...rates, random: { ...rates },
      by_asset: [{ symbol: 'BTCUSDT', trades: 60, excess: 0.01, tp_rate: 0.4 }],
      by_year: [{ from: '2023-10-01T00:00:00.000Z', to: '2024-09-30T20:00:00.000Z', trades: 80, excess: 0.01 }],
      ...over,
    },
  }
}

describe('stage limits', () => {
  it('declares both stages', () => {
    expect(STAGES.examen.years).toEqual(['2020-10', '2021-10', '2022-10'])
    expect(STAGES.desarrollo.loadFrom).toBe('2023-09')
  })

  it('rejects a registered id with another definition', () => {
    const registry = [row(cand('m1'), 'desarrollo', 'RECHAZADO', 'deadbeef0000')]
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('m1')], registry, dirty: false })).toThrow(/another definition/)
  })

  it('rejects the 21st development strategy', () => {
    const registry = Array.from({ length: 20 }, (_, i) => row(cand(`s${i}`), 'desarrollo', 'RECHAZADO'))
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('new')], registry, dirty: false })).toThrow(/20/)
    const nineteen = registry.slice(0, 19)
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('a'), cand('b')], registry: nineteen, dirty: false })).toThrow(/20/)
  })

  it('does not count controls toward the cap', () => {
    const registry = [...Array.from({ length: 20 }, (_, i) => row(cand(`s${i}`), 'desarrollo', 'RECHAZADO')),
      row(cand('c', 'control'), 'desarrollo', 'RECHAZADO')]
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('s3'), cand('c', 'control')], registry, dirty: false })).not.toThrow()
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('c2', 'control')], registry, dirty: false })).not.toThrow()
  })

  it('allows rerunning a registered strategy in development', () => {
    const registry = Array.from({ length: 20 }, (_, i) => row(cand(`s${i}`), 'desarrollo', 'RECHAZADO'))
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('s0')], registry, dirty: false })).not.toThrow()
  })

  it('rejects examen with uncommitted changes', () => {
    const c = cand('m1')
    const registry = [row(c, 'desarrollo', 'APRUEBA DESARROLLO')]
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [c], registry, dirty: true })).toThrow(/uncommitted/)
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [c], registry, dirty: false })).not.toThrow()
  })

  it('rejects examen without an approved last development run', () => {
    const c = cand('m1')
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [c], registry: [], dirty: false })).toThrow(/no approved development run/)
    const registry = [row(c, 'desarrollo', 'APRUEBA DESARROLLO'), row(c, 'desarrollo', 'RECHAZADO')]
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [c], registry, dirty: false })).toThrow(/no approved development run/)
    const control = cand('c', 'control')
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [control], registry: [row(control, 'desarrollo', 'RECHAZADO')], dirty: false }))
      .toThrow(/no approved development run/)
  })

  it('rejects a control in examen even with an approved development row', () => {
    const control = cand('c', 'control')
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [control], registry: [row(control, 'desarrollo', 'APRUEBA DESARROLLO')], dirty: false }))
      .toThrow(/control/)
  })

  it('rejects duplicate ids in one run', () => {
    const c = cand('m1')
    const registry = [row(c, 'desarrollo', 'APRUEBA DESARROLLO')]
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [c, c], registry, dirty: false })).toThrow(/duplicate/)
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [c, c], registry: [], dirty: false })).toThrow(/duplicate/)
  })

  it('rejects a kind mismatch against the registry', () => {
    const registry = [row(cand('m1'), 'desarrollo', 'RECHAZADO')]
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('m1', 'control')], registry, dirty: false })).toThrow(/kind/)
    const ctl = [row(cand('c', 'control'), 'desarrollo', 'RECHAZADO')]
    expect(() => assertStageAllowed({ stage: 'desarrollo', candidates: [cand('c')], registry: ctl, dirty: false })).toThrow(/kind/)
  })

  it('rejects a second examen of the same candidate', () => {
    const c = cand('m1')
    const registry = [row(c, 'desarrollo', 'APRUEBA DESARROLLO'), row(c, 'examen', 'RECHAZADO')]
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [c], registry, dirty: false })).toThrow(/already examined/)
  })

  it('rejects a fourth examined candidate', () => {
    const done = ['a', 'b', 'c'].map(id => cand(id))
    const next = cand('d')
    const registry = [...done, next].map(c => row(c, 'desarrollo', 'APRUEBA DESARROLLO'))
      .concat(done.map(c => row(c, 'examen', 'RECHAZADO')))
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [next], registry, dirty: false })).toThrow(/3/)
  })
})

describe('fiche and registry row', () => {
  it('round-trips a registry row', () => {
    const [parsed] = parseRegistryV2(REGISTRY_V2_HEADER + '\n' + swingRegistryRow(result(), info) + '\n\n')
    expect(parsed).toMatchObject({ candidate: 'm1', stage: 'desarrollo', definition: result().candidate.definition,
      verdict: 'APRUEBA DESARROLLO', trades: '250', commit: 'abc1234' })
    expect(parseRegistryV2(REGISTRY_V2_HEADER + '\n')).toEqual([])
  })

  it('writes a fiche and a row for a candidate that never buys', () => {
    const empty = result({ decisions: 0, trades: 0, mean_net: null, baseline_net: null, excess: null, p_outperformance: null,
      net_cost: null, net_stress_cost: null, tp_rate: null, sl_rate: null, timeout_rate: null, mean_hours: null,
      by_asset: [{ symbol: 'BTCUSDT', trades: 0, excess: null, tp_rate: null }] }, 'RECHAZADO')
    const fiche = renderSwingFiche(empty, info), line = swingRegistryRow(empty, info)
    expect(fiche).toContain('—')
    for (const text of [fiche, line]) expect(text).not.toMatch(/NaN|null|undefined/)
    const fields = line.split('\t'), columns = REGISTRY_V2_HEADER.split('\t')
    expect(fields).toHaveLength(columns.length)
    expect(fields[columns.indexOf('excess')]).toBe('')
  })

  it('writes a fiche with every check, TP/SL rates and outages', () => {
    const fiche = renderSwingFiche(result(), info)
    expect(fiche).toContain('**Veredicto: APRUEBA DESARROLLO**')
    for (const l of ['A', 'B', 'C', 'D', 'E', 'F']) expect(fiche).toContain(`| Prueba ${l} |`)
    expect(fiche).toContain('Tasa de TP')
    expect(fiche).toContain('2021-04-25')
    expect(fiche).toContain('18 velas')
    expect(fiche).toContain('Señales (antes de la regla de una posición)')
    expect(fiche).toContain('Puede pasar al examen único sobre años nunca mirados.')
    expect(renderSwingFiche(result(), { ...info, outages: [] })).toContain('Ninguna')
    expect(renderSwingFiche(result({}, 'RECHAZADO'), info)).toContain('No se usa para operar')
  })
})
