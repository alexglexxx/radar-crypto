import { type Outage } from './historical-coverage'
import { type FundingPoint } from './funding-archive'
import { pct } from './evaluation-gate'
import {
  definitionHash, GATE_V2_RULES, type SwingCandidate, type SwingResult, type SwingRules, type SwingStage,
} from './swing-gate'

// Development is unlimited-but-capped and registered; the exam runs once on years never looked at.
export const STAGES: Record<SwingStage, { loadFrom: string; periodFrom: string; periodTo: string; years: string[] }> = {
  desarrollo: { loadFrom: '2023-09', periodFrom: '2023-10', periodTo: '2026-09', years: ['2023-10', '2024-10', '2025-10'] },
  examen: { loadFrom: '2020-09', periodFrom: '2020-10', periodTo: '2023-09', years: ['2020-10', '2021-10', '2022-10'] },
}

const monthStart = (key: string, offset = 0) => {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  if (!match) throw new Error(`Month must be YYYY-MM: ${key}`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1)
}

// UTC milliseconds of a stage: data loads [loadStart, loadEnd] by open time,
// decisions fall in [periodStart, periodEnd) and each year starts at yearStarts.
export function stageWindow(stage: SwingStage) {
  const { loadFrom, periodFrom, periodTo, years } = STAGES[stage]
  return {
    loadStart: monthStart(loadFrom), loadEnd: monthStart(periodTo, 1) - 1,
    periodStart: monthStart(periodFrom), periodEnd: monthStart(periodTo, 1),
    yearStarts: years.map(y => monthStart(y)),
  }
}

export type FundingCoverage = { symbol: string; first: string; last: string; points: number }

export type SwingContextInfo = {
  period: string; commit: string; generatedAt: string; data: string; outages: Outage[]; funding: FundingCoverage[]
}

// First and last settlement of each coin's loaded funding (SOL starts mid-month in the exam).
export function fundingCoverage(funding: Map<string, FundingPoint[]>): FundingCoverage[] {
  return [...funding].map(([symbol, points]) => ({ symbol, points: points.length,
    first: new Date(points[0]?.calcTime ?? NaN).toISOString(), last: new Date(points.at(-1)?.calcTime ?? NaN).toISOString() }))
}

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

// The row of a run that aborted because the candidate threw: the attempt still counts.
export function swingErrorRow(candidate: SwingCandidate, stage: SwingStage, info: SwingContextInfo,
  rules: SwingRules = GATE_V2_RULES): string {
  return [info.generatedAt, candidate.id, candidate.kind, stage, rules.version, info.period, info.commit,
    definitionHash(candidate), 'RECHAZADO', ...Array(COLUMNS.length - 9).fill('')].join('\t')
}

const REPRODUCED = ['verdict', 'trades', 'excess', 'p_outperformance', 'net_cost'] as const

// Exam precondition: development, evaluated again with the current code, must give
// exactly the registered approved row, so the exam judges what development approved.
export function assertDevelopmentReproduced(row: RegistryV2Row, result: SwingResult, info: SwingContextInfo): void {
  if (row.candidate !== result.candidate.id) throw new Error(`Registry row of ${row.candidate} compared with ${result.candidate.id}`)
  const [fresh] = parseRegistryV2(REGISTRY_V2_HEADER + '\n' + swingRegistryRow(result, info))
  for (const field of REPRODUCED) {
    if (fresh[field] !== row[field]) {
      throw new Error(`Development of ${row.candidate} does not reproduce with the current code: ${field} is ` +
        `${fresh[field] || '(empty)'}, registered ${row[field] || '(empty)'}. Code, rules or helpers changed since it was approved`)
    }
  }
}

// Never overwrites a fiche: adds -2, -3, ... before .md.
export function freeFichePath(file: string, exists: (path: string) => boolean): string {
  if (!exists(file)) return file
  for (let n = 2; ; n++) {
    const next = file.replace(/\.md$/, `-${n}.md`)
    if (!exists(next)) return next
  }
}

const closing = (result: SwingResult) =>
  result.verdict === 'RECHAZADO'
    ? 'Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.'
    : result.verdict === 'APRUEBA DESARROLLO'
      ? 'Pasa el desarrollo. Puede pasar al examen único sobre años nunca mirados.'
      : 'Pasa el examen. Siguiente paso: seguimiento en papel con datos nuevos antes de cualquier uso real.'

type FicheHead = { id: string; kind: SwingCandidate['kind']; hypothesis: string; definition: string; stage: SwingStage; verdict: string }
const ficheHeader = (c: FicheHead, rules: SwingRules, info: SwingContextInfo) => [
  `# Ficha de evaluación: ${c.id}`,
  '',
  `**Veredicto: ${c.verdict}**${c.kind === 'control' ? ' · control del gate, no es una estrategia' : ''}`,
  '',
  `- Idea evaluada: ${c.hypothesis}`,
  `- Etapa: ${c.stage} · Periodo: ${info.period} · Datos: ${info.data}`,
  `- Reglas: ${rules.version} · Commit: \`${info.commit}\` · Huella de la definición: \`${c.definition}\` · Generado: ${info.generatedAt}`,
  '',
]

const stamp = (iso: string) => iso.slice(0, 19).replace('T', ' ')
const dataSections = (info: SwingContextInfo) => [
  '**Caídas aceptadas** (huecos de datos idénticos en las 4 monedas)',
  '',
  ...(info.outages.length
    ? info.outages.map(o => `- ${o.from.slice(0, 16).replace('T', ' ')} → ${o.to.slice(0, 16).replace('T', ' ')} (${o.bars} velas)`)
    : ['Ninguna']),
  '',
  '**Funding cargado** (primera y última liquidación de cada moneda, UTC)',
  '',
  ...info.funding.map(f => `- ${f.symbol.replace('USDT', '')}: ${stamp(f.first)} → ${stamp(f.last)} (${f.points} liquidaciones)`),
  '',
]

// Plain-language summary for people who will not read the JSON report.
export function renderSwingFiche(result: SwingResult, info: SwingContextInfo): string {
  const m = result.metrics, r = result.rules
  const lines = [
    ...ficheHeader({ ...result.candidate, stage: result.stage, verdict: result.verdict }, r, info),
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
    ...dataSections(info),
    `Cómo se mide: ${r.execution} Comisiones de ida y vuelta: ${r.costRoundTrip * 1e4} bps (prueba de estrés ${r.stressCostRoundTrip * 1e4} bps). ` +
      `"Frente al azar" compara con el mismo esquema TP/SL/72 h en la misma moneda y periodo; el valor p sale de ${r.permutations} desplazamientos circulares por moneda, ` +
      'reaplicando la regla de una posición a la vez.',
    '',
  ]
  return lines.join('\n')
}

// Fiche of a run that aborted because the candidate threw: no metrics, the error, and the attempt counts.
export function renderSwingErrorFiche(candidate: SwingCandidate, stage: SwingStage, info: SwingContextInfo, error: unknown,
  rules: SwingRules = GATE_V2_RULES): string {
  const message = error instanceof Error ? error.message : String(error)
  return [
    ...ficheHeader({ ...candidate, definition: definitionHash(candidate), stage, verdict: 'RECHAZADO' }, rules, info),
    'La corrida se abortó: el candidato lanzó un error en la evaluación principal, así que no hay pruebas ni métricas.',
    '',
    `Error: ${message}`,
    '',
    'El intento queda registrado como RECHAZADO y cuenta como corrida de esta etapa; un examen abortado no se repite.',
    '',
    ...dataSections(info),
  ].join('\n')
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
