import { type Outage } from './historical-coverage'
import { pct } from './evaluation-gate'
import {
  definitionHash, GATE_V2_RULES, type SwingCandidate, type SwingResult, type SwingRules, type SwingStage,
} from './swing-gate'

// Development is unlimited-but-capped and registered; the exam runs once on years never looked at.
export const STAGES: Record<SwingStage, { loadFrom: string; periodFrom: string; periodTo: string; years: string[] }> = {
  desarrollo: { loadFrom: '2023-09', periodFrom: '2023-10', periodTo: '2026-09', years: ['2023-10', '2024-10', '2025-10'] },
  examen: { loadFrom: '2020-09', periodFrom: '2020-10', periodTo: '2023-09', years: ['2020-10', '2021-10', '2022-10'] },
}

export type SwingContextInfo = { period: string; commit: string; generatedAt: string; data: string; outages: Outage[] }

const COLUMNS = ['date', 'candidate', 'kind', 'stage', 'rules', 'period', 'commit', 'definition', 'verdict', 'trades',
  'excess', 'p_outperformance', 'net_cost', 'tp_rate', 'sl_rate', 'timeout_rate', 'leak_divergences'] as const

export const REGISTRY_V2_HEADER = COLUMNS.join('\t')

export type RegistryV2Row = Record<(typeof COLUMNS)[number], string>

export function parseRegistryV2(tsv: string): RegistryV2Row[] {
  return tsv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '').slice(1).map(line => {
    const fields = line.split('\t')
    return Object.fromEntries(COLUMNS.map((c, i) => [c, fields[i] ?? ''])) as RegistryV2Row
  })
}

const num = (v: number | null) => v == null ? '' : v.toPrecision(6)
const rate = (v: number | null) => v == null ? '—' : `${(v * 100).toFixed(1)} %`
const hours = (v: number | null) => v == null ? '—' : `${v.toFixed(1)} h`

export function swingRegistryRow(result: SwingResult, info: SwingContextInfo): string {
  const m = result.metrics
  return [info.generatedAt, result.candidate.id, result.candidate.kind, result.stage, result.rules.version, info.period,
    info.commit, result.candidate.definition, result.verdict, m.trades, num(m.excess), num(m.p_outperformance),
    num(m.net_cost), num(m.tp_rate), num(m.sl_rate), num(m.timeout_rate), m.leak_divergences].join('\t')
}

const closing = (result: SwingResult) =>
  result.verdict === 'RECHAZADO'
    ? 'Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.'
    : result.verdict === 'APRUEBA DESARROLLO'
      ? 'Pasa el desarrollo. Puede pasar al examen único sobre años nunca mirados.'
      : 'Pasa el examen. Siguiente paso: seguimiento en papel con datos nuevos antes de cualquier uso real.'

// Plain-language summary for people who will not read the JSON report.
export function renderSwingFiche(result: SwingResult, info: SwingContextInfo): string {
  const m = result.metrics, r = result.rules
  const lines = [
    `# Ficha de evaluación: ${result.candidate.id}`,
    '',
    `**Veredicto: ${result.verdict}**${result.candidate.kind === 'control' ? ' · control del gate, no es una estrategia' : ''}`,
    '',
    `- Idea evaluada: ${result.candidate.hypothesis}`,
    `- Etapa: ${result.stage} · Periodo: ${info.period} · Datos: ${info.data}`,
    `- Reglas: ${r.version} · Commit: \`${info.commit}\` · Huella de la definición: \`${result.candidate.definition}\` · Generado: ${info.generatedAt}`,
    '',
    '| Prueba | Resultado | Exigido | ¿Pasa? |',
    '| --- | --- | --- | --- |',
    ...result.checks.map(c => `| ${c.label} | ${c.value} | ${c.required} | ${c.passed ? 'Sí' : '**No**'} |`),
    '',
    closing(result),
    '',
    `- Operaciones: ${m.trades}`,
    `- Señales (antes de la regla de una posición): ${m.decisions}`,
    '',
    '**Candidato frente al azar** (mismo esquema TP/SL/72 h)',
    '',
    '| Medida | Candidato | Azar |',
    '| --- | ---: | ---: |',
    `| Tasa de TP | ${rate(m.tp_rate)} | ${rate(m.random.tp_rate)} |`,
    `| Tasa de SL | ${rate(m.sl_rate)} | ${rate(m.random.sl_rate)} |`,
    `| Tasa de tiempo | ${rate(m.timeout_rate)} | ${rate(m.random.timeout_rate)} |`,
    `| Horas medias | ${hours(m.mean_hours)} | ${hours(m.random.mean_hours)} |`,
    '',
    '**Por moneda** (diferencia frente a entrar al azar en la misma moneda)',
    '',
    '| Moneda | Operaciones | Frente al azar | Tasa de TP |',
    '| --- | ---: | ---: | ---: |',
    ...m.by_asset.map(a => `| ${a.symbol.replace('USDT', '')} | ${a.trades} | ${pct(a.excess)} | ${rate(a.tp_rate)} |`),
    '',
    '**Por año**',
    '',
    '| Desde | Hasta | Operaciones | Frente al azar |',
    '| --- | --- | ---: | ---: |',
    ...m.by_year.map(y => `| ${y.from.slice(0, 10)} | ${y.to.slice(0, 10)} | ${y.trades} | ${pct(y.excess)} |`),
    '',
    '**Caídas aceptadas** (huecos de datos idénticos en las 4 monedas)',
    '',
    ...(info.outages.length
      ? info.outages.map(o => `- ${o.from.slice(0, 16).replace('T', ' ')} → ${o.to.slice(0, 16).replace('T', ' ')} (${o.bars} velas)`)
      : ['Ninguna']),
    '',
    `Cómo se mide: ${r.execution} Comisiones de ida y vuelta: ${r.costRoundTrip * 1e4} bps (prueba de estrés ${r.stressCostRoundTrip * 1e4} bps). ` +
      `"Frente al azar" compara con el mismo esquema TP/SL/72 h en la misma moneda y periodo; el valor p sale de ${r.permutations} desplazamientos circulares por moneda, ` +
      'reaplicando la regla de una posición a la vez.',
    '',
  ]
  return lines.join('\n')
}

// Enforces the registry rules before any data is loaded.
export function assertStageAllowed(input: {
  stage: SwingStage; candidates: SwingCandidate[]; registry: RegistryV2Row[]; dirty: boolean; rules?: SwingRules
}): void {
  const { stage, candidates, registry, dirty, rules = GATE_V2_RULES } = input
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c.id)) throw new Error(`Candidate ${c.id} appears twice in this run (duplicate id)`)
    seen.add(c.id)
    const sameId = registry.find(r => r.candidate === c.id)
    if (sameId && sameId.kind !== c.kind) throw new Error(`Candidate ${c.id} is registered with kind ${sameId.kind}, not ${c.kind}`)
    const other = registry.find(r => r.candidate === c.id && r.definition !== definitionHash(c))
    if (other) throw new Error(`Candidate ${c.id} is registered with another definition; a changed definition needs a new id`)
  }
  const dev = registry.filter(r => r.stage === 'desarrollo')
  const exam = registry.filter(r => r.stage === 'examen')

  if (stage === 'desarrollo') {
    const ids = new Set(dev.filter(r => r.kind === 'strategy').map(r => r.candidate))
    for (const c of candidates) if (c.kind === 'strategy') ids.add(c.id)
    if (ids.size > rules.maxDevCandidates) {
      throw new Error(`Development is capped at ${rules.maxDevCandidates} strategies; this run would reach ${ids.size}`)
    }
    return
  }

  if (dirty) throw new Error('Examen needs a clean tree: there are uncommitted changes')
  const examined = new Set(exam.map(r => r.candidate))
  for (const c of candidates) {
    if (examined.has(c.id)) throw new Error(`Candidate ${c.id} was already examined; the exam runs once`)
    const last = dev.filter(r => r.candidate === c.id).at(-1)
    if (!last || last.verdict !== 'APRUEBA DESARROLLO') {
      throw new Error(`Candidate ${c.id} has no approved development run as its latest development row`)
    }
    if (c.kind === 'control') throw new Error(`Candidate ${c.id} is a control; controls never reach the exam`)
  }
  const total = new Set([...examined, ...candidates.map(c => c.id)])
  if (total.size > rules.maxExamCandidates) {
    throw new Error(`Examen is capped at ${rules.maxExamCandidates} candidates; this run would reach ${total.size}`)
  }
}
