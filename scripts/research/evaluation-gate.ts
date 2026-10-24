import { type Candle } from '../../lib/features'
import { HORIZONS, circularPValue, episodes, mean } from './live-baseline-core'
import { TAIL_BARS, WARMUP_BARS } from './historical-baseline'

export type GateRules = {
  version: string; execution: string; costRoundTrip: number; stressCostRoundTrip: number
  alpha: number; minEpisodes: number; minPositiveAssets: number; leakChecksPerAsset: number; permutations: number
}

// Rules are fixed before any candidate runs. Changing them makes a new gate
// version; every verdict stays tied to the version that produced it.
export const GATE_RULES: Readonly<GateRules> = {
  version: 'gate-v1',
  // Signal at candle i close, enter at i+1 open, exit at i+bars+1 open.
  execution: 'la señal se da al cierre de una vela, se compra en la apertura de la siguiente y se vende en la apertura cuando se cumple el horizonte.',
  costRoundTrip: 0.002,
  stressCostRoundTrip: 0.003,
  alpha: 0.05,
  minEpisodes: 300,
  minPositiveAssets: 3,
  leakChecksPerAsset: 200,
  permutations: 2000,
}

export type Horizon = typeof HORIZONS[number]['name']

export type Candidate = {
  id: string
  kind: 'strategy' | 'control'
  hypothesis: string
  // Declared before the run; the gate never searches horizons for the candidate.
  horizon: Horizon
  // Decision at the close of archive[index]. May read only archive[0..index].
  decide(archive: Candle[], index: number): boolean
}

export type Check = { id: string; label: string; passed: boolean; value: string; required: string }

export type GateResult = {
  candidate: { id: string; kind: Candidate['kind']; hypothesis: string; horizon: Horizon }
  rules: GateRules
  verdict: 'CANDIDATO A PAPEL' | 'RECHAZADO'
  checks: Check[]
  metrics: {
    signals: number; episodes: number; leak_checks: number; leak_divergences: number
    signal_mean: number | null; matched_baseline: number | null; excess: number | null
    p_outperformance: number | null; net_cost: number | null; net_stress_cost: number | null
    by_asset: { symbol: string; signals: number; excess: number | null }[]
    by_fold: { from: string; to: string; signals: number; excess: number | null }[]
  }
}

export const pct = (value: number | null, digits = 3) =>
  value == null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(digits)} %`

// A throw counts as an answer: a candidate that reads past the prefix fails there.
function safeDecide(candidate: Candidate, archive: Candle[], index: number) {
  try { return candidate.decide(archive, index) } catch { return 'error' }
}

type Options = { foldStarts: number[]; seed: number; rules?: GateRules }

// archives: closed 15m candles per asset on one identical, verified time grid.
// foldStarts: open times where each fold begins; the last fold runs to the end.
export function evaluateCandidate(candidate: Candidate, archives: Map<string, Candle[]>,
  { foldStarts, seed, rules = GATE_RULES }: Options): GateResult {
  const horizon = HORIZONS.find(h => h.name === candidate.horizon)
  if (!horizon) throw new Error(`Unknown horizon ${candidate.horizon}`)
  const bars = horizon.bars
  if (bars + 1 > TAIL_BARS) throw new Error('Horizon exceeds the reserved tail')
  const symbols = [...archives.keys()]
  const length = archives.get(symbols[0])!.length
  const grid0 = archives.get(symbols[0])!
  for (const symbol of symbols) {
    const archive = archives.get(symbol)!
    if (archive.length !== length || archive.some((c, i) => c.openTime !== grid0[i].openTime)) {
      throw new Error('Assets need an identical time grid')
    }
  }
  const first = WARMUP_BARS, last = length - TAIL_BARS
  if (last - first < 2) throw new Error('Window too short for the gate')

  // 1. Lookahead: the decision must not change when everything after i is removed.
  let leakChecks = 0, leaks = 0
  for (const symbol of symbols) {
    const archive = archives.get(symbol)!
    const count = Math.min(rules.leakChecksPerAsset, last - first)
    const positions = [...new Set(Array.from({ length: count }, (_, k) =>
      first + Math.floor((k + 0.5) * (last - first) / count)))]
    for (const i of positions) {
      leakChecks++
      if (safeDecide(candidate, archive, i) !== safeDecide(candidate, archive.slice(0, i + 1), i)) leaks++
    }
  }

  // 2. Decisions and next-open returns on every eligible candle.
  const returns = new Map<string, number[]>()
  const positions = new Map<string, number[]>()
  const signals: { symbol: string; k: number; time: number; r: number }[] = []
  for (const symbol of symbols) {
    const archive = archives.get(symbol)!
    const series: number[] = []
    const picked: number[] = []
    for (let i = first; i < last; i++) {
      const entry = archive[i + 1].open, exit = archive[i + bars + 1].open
      const r = (exit - entry) / entry
      series.push(r)
      if (candidate.decide(archive, i)) {
        picked.push(i - first)
        signals.push({ symbol, k: i - first, time: archive[i].openTime, r })
      }
    }
    returns.set(symbol, series)
    positions.set(symbol, picked)
  }

  const baseline = new Map(symbols.map(s => [s, mean(returns.get(s)!)]))
  const excessOf = (group: typeof signals, base: (s: (typeof signals)[number]) => number) =>
    group.length ? mean(group.map(s => s.r)) - mean(group.map(base)) : null
  const signalMean = signals.length ? mean(signals.map(s => s.r)) : null
  const matched = signals.length ? mean(signals.map(s => baseline.get(s.symbol)!)) : null
  const excess = signalMean == null || matched == null ? null : signalMean - matched
  const p = signalMean == null || matched == null ? null
    : circularPValue(signalMean, matched, positions, returns, rules.permutations, seed).one_sided_outperformance
  const episodeCount = symbols.reduce((sum, s) => sum + episodes(positions.get(s)!, bars), 0)

  const byAsset = symbols.map(symbol => {
    const group = signals.filter(s => s.symbol === symbol)
    return { symbol, signals: group.length, excess: excessOf(group, () => baseline.get(symbol)!) }
  })
  // Each fold is judged against the same assets' baseline inside that fold.
  const times = grid0.slice(first, last).map(c => c.openTime)
  const byFold = foldStarts.map((start, f) => {
    const end = foldStarts[f + 1] ?? Infinity
    const inFold = (t: number) => t >= start && t < end
    const foldBase = new Map(symbols.map(s => {
      const values = returns.get(s)!.filter((_, k) => inFold(times[k]))
      return [s, values.length ? mean(values) : 0]
    }))
    const group = signals.filter(s => inFold(s.time))
    const lastTime = times.filter(inFold).at(-1)
    return { from: new Date(start).toISOString(), to: lastTime == null ? '—' : new Date(lastTime).toISOString(),
      signals: group.length, excess: excessOf(group, s => foldBase.get(s.symbol)!) }
  })

  const net = signalMean == null ? null : signalMean - rules.costRoundTrip
  const netStress = signalMean == null ? null : signalMean - rules.stressCostRoundTrip
  const positiveAssets = byAsset.filter(a => a.excess != null && a.excess > 0).length
  const positiveFolds = byFold.filter(f => f.excess != null && f.excess > 0).length
  const checks: Check[] = [
    { id: 'no-lookahead', label: 'No mira el futuro', passed: leaks === 0,
      value: `${leaks} de ${leakChecks} puntos cambian`, required: '0 cambios' },
    { id: 'sample', label: 'Muestra suficiente', passed: episodeCount >= rules.minEpisodes,
      value: `${episodeCount} episodios independientes (${signals.length} señales)`, required: `≥ ${rules.minEpisodes}` },
    { id: 'beats-random', label: 'Le gana al azar', passed: excess != null && excess > 0 && p != null && p < rules.alpha,
      value: `${pct(excess)} por operación (p ${p == null ? '—' : p.toFixed(3)})`, required: `> 0 y p < ${rules.alpha}` },
    { id: 'net-of-costs', label: 'Gana después de comisiones', passed: net != null && net > 0,
      value: `${pct(net)} con ${rules.costRoundTrip * 1e4} bps (${pct(netStress)} con ${rules.stressCostRoundTrip * 1e4} bps)`,
      required: '> 0' },
    { id: 'stable', label: 'Estable en el tiempo', passed: positiveFolds === byFold.length,
      value: `${positiveFolds} de ${byFold.length} periodos le ganan al azar`, required: `${byFold.length} de ${byFold.length}` },
    { id: 'breadth', label: 'No depende de una sola moneda', passed: positiveAssets >= rules.minPositiveAssets,
      value: `${positiveAssets} de ${symbols.length} monedas le ganan al azar`, required: `≥ ${rules.minPositiveAssets}` },
  ]

  return {
    candidate: { id: candidate.id, kind: candidate.kind, hypothesis: candidate.hypothesis, horizon: candidate.horizon },
    rules,
    verdict: checks.every(c => c.passed) ? 'CANDIDATO A PAPEL' : 'RECHAZADO',
    checks,
    metrics: { signals: signals.length, episodes: episodeCount, leak_checks: leakChecks, leak_divergences: leaks,
      signal_mean: signalMean, matched_baseline: matched, excess, p_outperformance: p,
      net_cost: net, net_stress_cost: netStress, by_asset: byAsset, by_fold: byFold },
  }
}

type FicheContext = { period: string; commit: string; generatedAt: string; data: string }

// Plain-language summary for people who will not read the JSON report.
export function renderFiche(result: GateResult, context: FicheContext) {
  const m = result.metrics
  const lines = [
    `# Ficha de evaluación: ${result.candidate.id}`,
    '',
    `**Veredicto: ${result.verdict}**${result.candidate.kind === 'control' ? ' · control del gate, no es una estrategia' : ''}`,
    '',
    `- Idea evaluada: ${result.candidate.hypothesis}`,
    `- Horizonte declarado antes de correr: ${result.candidate.horizon}`,
    `- Periodo: ${context.period} · Datos: ${context.data}`,
    `- Reglas: ${result.rules.version} · Commit: \`${context.commit}\` · Generado: ${context.generatedAt}`,
    '',
    '| Prueba | Resultado | Exigido | ¿Pasa? |',
    '| --- | --- | --- | --- |',
    ...result.checks.map(c => `| ${c.label} | ${c.value} | ${c.required} | ${c.passed ? 'Sí' : '**No**'} |`),
    '',
    result.verdict === 'RECHAZADO'
      ? 'Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.'
      : 'Pasa el histórico. Siguiente paso: seguimiento en papel con datos nuevos antes de cualquier uso real.',
    '',
    '**Por moneda** (diferencia frente a entrar al azar en la misma moneda)',
    '',
    '| Moneda | Señales | Frente al azar |',
    '| --- | ---: | ---: |',
    ...m.by_asset.map(a => `| ${a.symbol.replace('USDT', '')} | ${a.signals} | ${pct(a.excess)} |`),
    '',
    '**Por periodo**',
    '',
    '| Desde | Hasta | Señales | Frente al azar |',
    '| --- | --- | ---: | ---: |',
    ...m.by_fold.map(f => `| ${f.from.slice(0, 10)} | ${f.to.slice(0, 10)} | ${f.signals} | ${pct(f.excess)} |`),
    '',
    `Cómo se mide: ${result.rules.execution} Comisiones de ida y vuelta: ${result.rules.costRoundTrip * 1e4} bps (prueba de estrés ${result.rules.stressCostRoundTrip * 1e4} bps). ` +
      `"Frente al azar" compara con entrar en cada vela de la misma moneda y periodo; el valor p sale de ${result.rules.permutations} desplazamientos circulares que conservan los grupos de señales.`,
    '',
  ]
  return lines.join('\n')
}

export const REGISTRY_HEADER = ['date', 'candidate', 'kind', 'horizon', 'rules', 'period', 'commit', 'verdict',
  'signals', 'episodes', 'excess', 'p_outperformance', 'net_cost', 'leak_divergences'].join('\t')

export function registryRow(result: GateResult, context: FicheContext) {
  const m = result.metrics
  const num = (v: number | null) => v == null ? '' : v.toPrecision(6)
  return [context.generatedAt, result.candidate.id, result.candidate.kind, result.candidate.horizon,
    result.rules.version, context.period, context.commit, result.verdict, m.signals, m.episodes,
    num(m.excess), num(m.p_outperformance), num(m.net_cost), m.leak_divergences].join('\t')
}
