import fs from 'node:fs/promises'
import path from 'node:path'
import { buildContext } from './context'
import { loadFunding, loadKlines, validateCandles } from './data'
import { buildStrategies, type Strategy } from './strategies'
import { syntheticMarket, type SyntheticMode } from './synthetic'
import { TF_MS, type MarketData, type Timeframe } from './types'
import { COSTS_BPS, Evaluator, PRIMARY_COST_BPS, STRESS_COST_BPS, addMonths, buildFolds, runStrategy, type StrategyResult } from './walkforward'

const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(s => s.trim()).filter(Boolean)
const MONTHS = Number(process.env.MONTHS ?? 36)
const WARMUP_MONTHS = 3
const TIMEFRAMES = (process.env.TIMEFRAMES ?? '15m,1h,4h').split(',').map(s => s.trim()) as Timeframe[]
const ONLY = (process.env.ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean)
const SYNTHETIC = (process.env.SYNTHETIC ?? '') as SyntheticMode | ''
const SEED = Number(process.env.SEED ?? 20261012)
const REPORT_DIR = path.resolve(process.env.REPORT_DIR ?? path.join(process.cwd(), 'reports', 'ideas-v2'))
const CACHE_DIR = path.resolve(process.env.CACHE_DIR ?? path.join(process.cwd(), '.backtest-cache-ideas'))

const pct = (value: number | null | undefined, digits = 3) =>
  value === null || value === undefined ? 'n/d' : (value * 100).toFixed(digits) + '%'

function skipped(strategy: Strategy, reason: string): StrategyResult {
  return {
    id: strategy.id, idea: strategy.idea, title: strategy.title, hypothesis: strategy.hypothesis,
    timeframe: strategy.timeframe, gridSize: strategy.grid.length, verdict: 'skipped', verdictReasons: [reason],
    pooled: {}, pooledCI: null, alwaysInPooledExpectancy: null, edgeOverAlwaysIn: null, positiveFolds: 0,
    foldsWithTrades: 0, totalFolds: 0, exposure: null, buyAndHoldAvg: null, perSymbol: [], exitReasons: {}, folds: [],
  }
}

async function loadMarket(timeframe: Timeframe, needFunding: boolean): Promise<{ data: MarketData; evalStart: number; fundingError?: string }> {
  const step = TF_MS[timeframe]
  if (SYNTHETIC) {
    const startTime = Date.UTC(2023, 0, 1)
    const total = MONTHS + WARMUP_MONTHS
    const bars = Math.round((addMonths(startTime, total) - startTime) / step)
    const data = syntheticMarket({ symbols: SYMBOLS, timeframe, bars, seed: SEED, mode: SYNTHETIC, startTime, withFunding: needFunding })
    return { data, evalStart: addMonths(startTime, WARMUP_MONTHS) }
  }

  const now = new Date()
  const currentMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const end = currentMonth - step
  const loadStart = addMonths(currentMonth, -(MONTHS + WARMUP_MONTHS))
  const series = []
  for (const symbol of SYMBOLS) {
    console.log(`[ideas] loading ${symbol} ${timeframe}`)
    const candles = await loadKlines(symbol, timeframe, loadStart, end, CACHE_DIR)
    validateCandles(symbol, candles, loadStart, end, timeframe)
    series.push({ symbol, candles })
  }
  let funding: MarketData['funding'] = null
  let fundingError: string | undefined
  if (needFunding) {
    try {
      funding = {}
      for (const symbol of SYMBOLS) {
        const points = await loadFunding(symbol, loadStart, end, CACHE_DIR)
        const expected = Math.floor((end - loadStart) / (8 * 3_600_000))
        if (points.length < expected * 0.9) throw new Error(`funding ${symbol}: ${points.length}/${expected} points`)
        funding[symbol] = points
      }
    } catch (error) {
      funding = null
      fundingError = error instanceof Error ? error.message : String(error)
    }
  }
  return { data: { timeframe, series, funding }, evalStart: addMonths(currentMonth, -MONTHS), fundingError }
}

function renderMarkdown(results: StrategyResult[], meta: Record<string, unknown>): string {
  const rows = [...results].sort((a, b) => a.idea - b.idea || a.id.localeCompare(b.id))
  const lines: string[] = []
  lines.push('# Radar Crypto — pruebas de ideas de estrategia (rama de investigación)', '')
  lines.push(`Generado: ${meta.generatedAt} · Datos: **${meta.dataSource}** · Meses evaluados: ${meta.months} · Símbolos: ${SYMBOLS.join(', ')}`, '')
  if (SYNTHETIC) {
    lines.push(`> ⚠️ **DATOS SINTÉTICOS (${SYNTHETIC}).** Solo prueban que el sistema de pruebas funciona. Nada de esto describe el mercado real.`, '')
  }
  lines.push(
    `Costo principal: ${PRIMARY_COST_BPS} bps ida y vuelta · Estrés: ${STRESS_COST_BPS} bps · Un resultado "no calificada" es un resultado válido: significa que la idea no pasó la prueba.`,
    '',
  )
  lines.push('| Idea | Estrategia | Plazo | Ops. fuera de muestra | Ganancia media por op. | IC 95% corregido | A 30 bps | Periodos + | Mejora vs. "siempre dentro" | Veredicto |')
  lines.push('|---|---|---|---:|---:|---|---:|---:|---:|---|')
  for (const r of rows) {
    const primary = r.pooled[String(PRIMARY_COST_BPS)]
    const stress = r.pooled[String(STRESS_COST_BPS)]
    const ci = r.pooledCI ? `[${pct(r.pooledCI.lo, 2)}, ${pct(r.pooledCI.hi, 2)}]` : 'n/d'
    lines.push(
      `| ${r.idea} | ${r.id} | ${r.timeframe} | ${primary?.trades ?? 0} | ${pct(primary?.expectancy)} | ${ci} | ${pct(stress?.expectancy)} | ${r.positiveFolds}/${r.totalFolds} | ${pct(r.edgeOverAlwaysIn)} | **${r.verdict}** |`,
    )
  }
  lines.push('', '## Por qué cada una pasó o no', '')
  for (const r of rows) {
    lines.push(`### ${r.id}`, `*${r.title}*`, '', `Hipótesis: ${r.hypothesis}`, '')
    if (r.verdictReasons.length) for (const reason of r.verdictReasons) lines.push(`- ${reason}`)
    else lines.push('- Pasó todos los criterios. Sigue siendo solo un candidato: falta validarla con otros periodos y con ejecución real.')
    if (r.pooled[String(PRIMARY_COST_BPS)]?.trades) {
      const p = r.pooled[String(PRIMARY_COST_BPS)]
      lines.push(`- Aciertos: ${pct(p.winRate, 1)} · Caída máxima: ${pct(p.maxDrawdown, 1)} · Exposición: ${pct(r.exposure, 1)} · Comprar y mantener (promedio por periodo): ${pct(r.buyAndHoldAvg, 1)}`)
    }
    lines.push('')
  }
  lines.push(
    '## Cómo leer esto',
    '',
    '- **Fuera de muestra**: los parámetros se eligen solo con 12 meses de entrenamiento y se prueban en los 3 meses siguientes, que el sistema no vio.',
    '- **IC corregido**: intervalo de confianza que descuenta haber probado varias ideas a la vez (cuantas más pruebas, más fácil engañarse con la suerte).',
    '- **Siempre dentro**: lo que ganaría quien entra sin ninguna señal usando la misma salida. Si la idea no lo supera, la señal de entrada no aporta nada.',
    '- Pasar estas pruebas **no** demuestra rentabilidad futura; solo permite seguir validando con otros datos y con ejecución real.',
    '',
  )
  return lines.join('\n')
}

async function main() {
  if (!Number.isInteger(MONTHS) || MONTHS < 15) throw new Error('MONTHS must be an integer >= 15.')
  const all = buildStrategies()
    .filter(s => TIMEFRAMES.includes(s.timeframe))
    .filter(s => ONLY.length === 0 || ONLY.some(token => s.id === token || s.id.startsWith(token)))
  if (!all.length) throw new Error('No strategies selected (check TIMEFRAMES / ONLY).')

  await fs.mkdir(REPORT_DIR, { recursive: true })
  const results: StrategyResult[] = []

  for (const timeframe of TIMEFRAMES) {
    const group = all.filter(s => s.timeframe === timeframe)
    if (!group.length) continue
    const needFunding = group.some(s => s.needsFunding)
    const { data, evalStart, fundingError } = await loadMarket(timeframe, needFunding)
    const folds = buildFolds(data, evalStart, MONTHS)
    if (!folds.length) throw new Error('No folds could be built.')
    const evaluator = new Evaluator(buildContext(data))
    console.log(`[ideas] ${timeframe}: ${data.series[0].candles.length} bars/symbol, ${folds.length} folds, ${group.length} strategies`)

    for (const strategy of group) {
      const result =
        strategy.needsFunding && !data.funding
          ? skipped(strategy, `Sin datos de funding: ${fundingError ?? 'no disponibles'}`)
          : runStrategy(strategy, data, folds, all.length, evaluator)
      results.push(result)
      const p = result.pooled[String(PRIMARY_COST_BPS)]
      console.log(
        `[ideas] ${result.id.padEnd(34)} trades=${String(p?.trades ?? 0).padStart(6)} exp@${PRIMARY_COST_BPS}=${pct(p?.expectancy).padStart(9)} folds+=${result.positiveFolds}/${result.totalFolds} -> ${result.verdict}`,
      )
      await fs.writeFile(path.join(REPORT_DIR, `${result.id}.json`), JSON.stringify(result, null, 2) + '\n')
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    dataSource: SYNTHETIC ? `sintéticos (${SYNTHETIC}, semilla ${SEED})` : 'Binance spot (data.binance.vision)',
    months: MONTHS,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
    costsBps: COSTS_BPS,
    primaryCostBps: PRIMARY_COST_BPS,
    stressCostBps: STRESS_COST_BPS,
    strategiesEvaluated: all.length,
    productionFilesModified: false,
  }
  await fs.writeFile(path.join(REPORT_DIR, 'summary.json'), JSON.stringify({ meta, results }, null, 2) + '\n')
  await fs.writeFile(path.join(REPORT_DIR, 'summary.md'), renderMarkdown(results, meta))
  console.log(`[ideas] reports written to ${REPORT_DIR}`)
  const candidates = results.filter(r => r.verdict === 'candidate_for_further_validation').length
  console.log(`[ideas] candidates for further validation: ${candidates}/${results.length} (not_qualified is a valid research outcome; exit code stays 0)`)
}

main().catch(error => {
  console.error('[ideas] Error:', error)
  process.exitCode = 1
})
