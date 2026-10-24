import { describe, expect, it } from 'vitest'
import { definitionHash, GATE_V2_RULES, type SwingCandidate, type SwingResult } from '../scripts/research/swing-gate'
import {
  assertDevelopmentReproduced, assertStageAllowed, freeFichePath, fundingCoverage, parseRegistryV2, renderSwingErrorFiche,
  renderSwingFiche, REGISTRY_V2_HEADER, STAGES, stageWindow, swingErrorRow, swingRegistryRow,
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
  funding: [{ symbol: 'SOLUSDT', first: '2020-09-13T16:00:00.004Z', last: '2023-09-30T16:00:00.000Z', points: 3300 }],
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

  it('pins the stage windows in UTC milliseconds', () => {
    const utc = (d: string) => Date.parse(`${d}Z`)
    expect(stageWindow('desarrollo')).toEqual({
      loadStart: utc('2023-09-01T00:00:00.000'), loadEnd: utc('2026-09-30T23:59:59.999'),
      periodStart: utc('2023-10-01T00:00:00.000'), periodEnd: utc('2026-10-01T00:00:00.000'),
      yearStarts: [utc('2023-10-01T00:00:00.000'), utc('2024-10-01T00:00:00.000'), utc('2025-10-01T00:00:00.000')],
    })
    expect(stageWindow('examen')).toEqual({
      loadStart: utc('2020-09-01T00:00:00.000'), loadEnd: utc('2023-09-30T23:59:59.999'),
      periodStart: utc('2020-10-01T00:00:00.000'), periodEnd: utc('2023-10-01T00:00:00.000'),
      yearStarts: [utc('2020-10-01T00:00:00.000'), utc('2021-10-01T00:00:00.000'), utc('2022-10-01T00:00:00.000')],
    })
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

describe('development reproduction before the exam', () => {
  const registered = parseRegistryV2(REGISTRY_V2_HEADER + '\n' + swingRegistryRow(result(), info))[0]

  it('passes when the current code gives the registered development row', () => {
    expect(() => assertDevelopmentReproduced(registered, result(), { ...info, generatedAt: '2026-12-01', commit: 'fff0000' }))
      .not.toThrow()
  })

  it('names the field that differs', () => {
    const cases: [Partial<SwingResult['metrics']>, SwingResult['verdict'], string][] = [
      [{}, 'RECHAZADO', 'verdict'],
      [{ trades: 251 }, 'APRUEBA DESARROLLO', 'trades'],
      [{ excess: 0.0080001 }, 'APRUEBA DESARROLLO', 'excess'],
      [{ p_outperformance: 0.02 }, 'APRUEBA DESARROLLO', 'p_outperformance'],
      [{ net_cost: 0.011 }, 'APRUEBA DESARROLLO', 'net_cost'],
      [{ net_cost: null }, 'APRUEBA DESARROLLO', 'net_cost'],
    ]
    for (const [metrics, verdict, field] of cases) {
      expect(() => assertDevelopmentReproduced(registered, result(metrics, verdict), info)).toThrow(new RegExp(`: ${field} is`))
    }
  })

  it('ignores differences below the registered precision and in other columns', () => {
    expect(() => assertDevelopmentReproduced(registered, result({ excess: 0.008 + 1e-12, tp_rate: 0.9 }), info)).not.toThrow()
  })
})

describe('fiche and registry row', () => {
  it('writes a rejected row with empty metrics when the candidate throws', () => {
    const c = cand('m1')
    const line = swingErrorRow(c, 'examen', info)
    const fields = line.split('\t'), columns = REGISTRY_V2_HEADER.split('\t')
    expect(fields).toHaveLength(columns.length)
    expect(line).not.toMatch(/NaN|null|undefined/)
    const [parsed] = parseRegistryV2(REGISTRY_V2_HEADER + '\n' + line)
    expect(parsed).toMatchObject({ date: info.generatedAt, candidate: 'm1', kind: 'strategy', stage: 'examen', rules: 'gate-v2',
      period: info.period, commit: 'abc1234', definition: definitionHash(c), verdict: 'RECHAZADO' })
    for (const col of ['trades', 'excess', 'p_outperformance', 'net_cost', 'tp_rate', 'sl_rate', 'timeout_rate', 'leak_divergences'] as const) {
      expect(parsed[col]).toBe('')
    }
    // The row blocks a second exam of the same candidate.
    expect(() => assertStageAllowed({ stage: 'examen', candidates: [c], dirty: false,
      registry: [row(c, 'desarrollo', 'APRUEBA DESARROLLO'), parsed] })).toThrow(/already examined/)
  })

  it('writes a fiche that says the run aborted and why', () => {
    const fiche = renderSwingErrorFiche(cand('m1'), 'examen', info, new Error('boom at index 12'))
    expect(fiche).toContain('**Veredicto: RECHAZADO**')
    expect(fiche).toContain('boom at index 12')
    expect(fiche).toContain('se abortó')
    expect(fiche).toContain('Etapa: examen')
    expect(fiche).toContain(definitionHash(cand('m1')))
    expect(fiche).not.toMatch(/NaN|null|undefined/)
    expect(renderSwingErrorFiche(cand('m1'), 'desarrollo', info, 'plain string')).toContain('plain string')
  })

  it('lists the funding coverage of each coin', () => {
    const fiche = renderSwingFiche(result(), info)
    expect(fiche).toContain('SOL: 2020-09-13 16:00:00 → 2023-09-30 16:00:00 (3300 liquidaciones)')
    expect(renderSwingErrorFiche(cand('m1'), 'examen', info, new Error('x'))).toContain('SOL: 2020-09-13 16:00:00')
    const H = 3_600_000, t0 = Date.parse('2020-09-13T16:00:00.004Z')
    expect(fundingCoverage(new Map([['SOLUSDT', [0, 1, 2].map(k => ({ calcTime: t0 + k * 8 * H, intervalHours: 8, rate: 0 }))]])))
      .toEqual([{ symbol: 'SOLUSDT', first: '2020-09-13T16:00:00.004Z', last: '2020-09-14T08:00:00.004Z', points: 3 }])
  })

  it('says a gap down fills the SL at the open', () => {
    expect(renderSwingFiche(result(), info)).toContain('hueco a la baja')
  })

  it('never overwrites a fiche', () => {
    const taken = new Set(['f/2026-10-24-examen-m1.md', 'f/2026-10-24-examen-m1-2.md'])
    expect(freeFichePath('f/2026-10-24-examen-m2.md', p => taken.has(p))).toBe('f/2026-10-24-examen-m2.md')
    expect(freeFichePath('f/2026-10-24-examen-m1.md', p => taken.has(p))).toBe('f/2026-10-24-examen-m1-3.md')
  })

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
