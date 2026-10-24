#!/usr/bin/env node
// gate-v2 (spot-long swing) on complete Binance monthly archives (no database access).
// Usage: npx tsx scripts/research/run-gate-v2.mts --stage=desarrollo --candidates=swing-random,swing-lookahead,swing-btc-lookahead
//        npx tsx scripts/research/run-gate-v2.mts --stage=examen --check-data   (validates data only; evaluates and writes nothing)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { type Candle } from '../../lib/features'
import { loadArchivedCandlesWithOutages, type ArchiveFile } from './binance-archive'
import { loadArchivedFunding, type FundingPoint } from './funding-archive'
import { type Outage } from './historical-coverage'
import { SYMBOLS } from './live-baseline-core'
import { pct } from './evaluation-gate'
import {
  GATE_V2_RULES, evaluateSwingCandidate, freezeContext, outageDrill, type SwingContext, type SwingResult, type SwingStage,
} from './swing-gate'
import { SWING_CANDIDATES } from './swing-candidates'
import {
  REGISTRY_V2_HEADER, STAGES, assertDevelopmentReproduced, assertStageAllowed, freeFichePath, fundingCoverage,
  parseRegistryV2, renderSwingErrorFiche, renderSwingFiche, stageWindow, swingErrorRow, swingRegistryRow,
  type FundingCoverage, type SwingContextInfo,
} from './swing-registry'

const args: Record<string, string> = {}
for (const arg of process.argv.slice(2)) {
  const match = /^--(stage|candidates)=(.+)$/.exec(arg)
  if (arg === '--check-data') args.checkData = 'yes'
  else if (match) args[match[1]] = match[2]
  else throw new Error(`Unknown argument: ${arg}`)
}
if (args.stage !== 'desarrollo' && args.stage !== 'examen') throw new Error('--stage=desarrollo|examen is required')
const stage: SwingStage = args.stage
const checkData = args.checkData === 'yes'
if (checkData && args.candidates) throw new Error('--check-data evaluates nothing; drop --candidates')
if (!checkData && !args.candidates) throw new Error('--candidates=a,b is required')

// Outputs and the clean-tree check resolve from the repository root, not the working directory.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trimEnd()
const rel = (file: string) => path.relative(root, file).replaceAll('\\', '/')
const cacheDir = path.join(root, '.backtest-cache')

type StageData = {
  ctx: SwingContext; outages: Outage[]; funding: FundingCoverage[]; spotManifest: ArchiveFile[]; fundingManifest: ArchiveFile[]
}

// Loads and validates a stage's spot and funding archives: shared outages only, no funding gaps.
async function loadStage(which: SwingStage): Promise<StageData> {
  const { loadStart, loadEnd } = stageWindow(which)
  const candles = new Map<string, Candle[]>()
  const funding = new Map<string, FundingPoint[]>()
  const spotManifest: ArchiveFile[] = [], fundingManifest: ArchiveFile[] = []
  let outages: Outage[] | undefined
  for (const symbol of SYMBOLS) {
    const spot = await loadArchivedCandlesWithOutages(symbol, loadStart, loadEnd, { maxOutageBars: GATE_V2_RULES.maxOutageBars, cacheDir })
    if (outages && JSON.stringify(outages) !== JSON.stringify(spot.outages)) {
      throw new Error(`Outages of ${symbol} differ from the other coins; only gaps identical in all coins are accepted`)
    }
    outages = spot.outages
    candles.set(symbol, spot.candles)
    spotManifest.push(...spot.manifest)
    const fund = await loadArchivedFunding(symbol, loadStart, loadEnd, { cacheDir })
    funding.set(symbol, fund.points)
    fundingManifest.push(...fund.manifest)
    console.log(`${which} ${symbol}: ${spot.candles.length} candles, ${fund.points.length} funding points verified, ${spot.outages.length} outages`)
  }
  // Frozen so a candidate cannot change what the next candidate or the leak check reads.
  return { ctx: freezeContext({ candles, funding }), outages: outages ?? [], funding: fundingCoverage(funding), spotManifest, fundingManifest }
}

const stamp = (iso: string) => iso.slice(0, 19).replace('T', ' ')
const rate = (v: number | null) => v == null ? '—' : `${(v * 100).toFixed(1)} %`
const summary = (result: SwingResult) => {
  const m = result.metrics
  return `${result.verdict} · ${m.trades} operaciones · frente al azar ${pct(m.excess)} ` +
    `(p ${m.p_outperformance?.toFixed(3) ?? '—'}) · neto ${pct(m.net_cost)} · fugas ${m.leak_divergences}/${m.leak_checks}`
}

if (checkData) {
  const data = await loadStage(stage)
  console.log(`Datos de ${stage} verificados (archivos, velas, rejilla común y funding sin huecos); no se evalúa ni se escribe nada.`)
  console.log(`Caídas compartidas por las 4 monedas: ${data.outages.length} (${data.outages.reduce((s, o) => s + o.bars, 0)} velas)`)
  for (const o of data.outages) console.log(`  ${stamp(o.from)} → ${stamp(o.to)} (${o.bars} velas)`)
  console.log('Funding por moneda (primera y última liquidación cargada, UTC; huecos: 0, la carga aborta si hay alguno):')
  for (const f of data.funding) console.log(`  ${f.symbol}: ${stamp(f.first)} → ${stamp(f.last)} (${f.points} liquidaciones)`)
} else {
  await runStage(args.candidates.split(','))
}

async function runStage(ids: string[]) {
  for (const id of ids) {
    if (!SWING_CANDIDATES[id]) throw new Error(`Unknown candidate ${id}; known: ${Object.keys(SWING_CANDIDATES).join(', ')}`)
  }
  const candidates = ids.map(id => SWING_CANDIDATES[id])

  const registryFile = path.join(root, 'docs/evaluation/registry-v2.tsv')
  const codeDirty = git('status', '--porcelain', '--', 'scripts', 'lib')
  // The exam also needs the registry committed: an uncommitted exam row could be discarded and the exam repeated.
  const examDirty = stage === 'examen' ? git('status', '--porcelain', '--', 'scripts', 'lib', 'docs/evaluation/registry-v2.tsv') : ''
  if (examDirty) console.error(`Uncommitted changes:\n${examDirty}`)
  const registry = parseRegistryV2(existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : '')
  // Registry rules are enforced before any data is downloaded.
  assertStageAllowed({ stage, candidates, registry, dirty: stage === 'examen' ? examDirty !== '' : codeDirty !== '' })

  const commit = git('rev-parse', '--short', 'HEAD')
  const generatedAt = new Date().toISOString().slice(0, 10)
  const sha = (m: ArchiveFile[]) => createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 16)
  const infoOf = (which: SwingStage, data: StageData): SwingContextInfo => ({
    period: `${STAGES[which].periodFrom} a ${STAGES[which].periodTo}`,
    commit: codeDirty ? `${commit}+cambios` : commit,
    generatedAt,
    data: `${data.spotManifest.length} archivos mensuales de velas (manifiesto ${sha(data.spotManifest)}) y ${data.fundingManifest.length} de funding ` +
      `(manifiesto ${sha(data.fundingManifest)}) de data.binance.vision`,
    outages: data.outages,
    funding: data.funding,
  })

  // Exam preconditions, none of which writes anything:
  // 1. development, evaluated again with the current code, gives exactly the approved row;
  // 2. the exam outages, moved onto development data, change no decision.
  let development: StageData | undefined
  const devWindow = stageWindow('desarrollo')
  if (stage === 'examen') {
    development = await loadStage('desarrollo')
    const devInfo = infoOf('desarrollo', development)
    for (const candidate of candidates) {
      console.log(`${candidate.id}: reproduciendo desarrollo con el código actual (comprobación previa, no se registra)...`)
      const result = evaluateSwingCandidate(candidate, development.ctx, { stage: 'desarrollo', ...pick(devWindow) })
      console.log(`  ${summary(result)}`)
      const approved = registry.filter(r => r.candidate === candidate.id && r.stage === 'desarrollo').at(-1)!
      assertDevelopmentReproduced(approved, result, devInfo)
      console.log('  coincide con la fila aprobada del registro')
    }
  }

  const data = await loadStage(stage)
  const info = infoOf(stage, data)

  if (development) {
    for (const candidate of candidates) {
      const drill = outageDrill(candidate, development.ctx, data.outages, { periodStart: devWindow.periodStart, periodEnd: devWindow.periodEnd })
      console.log(`${candidate.id}: simulacro de caídas sobre desarrollo (${data.outages.length} caídas del examen +3 años, ` +
        `${drill.removed} velas quitadas): ${drill.leaks} de ${drill.checks} puntos cambian`)
      if (drill.leaks > 0) {
        throw new Error(`${candidate.id} changes ${drill.leaks} of ${drill.checks} decisions when the exam outages are removed from ` +
          'development data: it reads windows by candle count. Read candles by time (firstIndexAtOrAfter), with a new id; ' +
          'examen refused, nothing written')
      }
    }
  }

  const fichas = path.join(root, 'docs/evaluation/fichas'), reports = path.join(root, 'reports/gate-v2')
  mkdirSync(reports, { recursive: true })
  mkdirSync(fichas, { recursive: true })
  const appendRow = (line: string) => {
    if (!existsSync(registryFile)) writeFileSync(registryFile, REGISTRY_V2_HEADER + '\n')
    appendFileSync(registryFile, line + '\n')
  }
  const remindCommit = (fiche: string) => {
    if (stage === 'examen') {
      console.log(`Haz commit ahora de ${rel(registryFile)} y ${rel(fiche)}: el examen cuenta una sola vez y, sin commit, ` +
        'descartar el registro permitiría repetirlo.')
    }
  }

  for (const candidate of candidates) {
    console.log(`${candidate.id}: evaluating...`)
    const fiche = freeFichePath(path.join(fichas, `${info.generatedAt}-${stage}-${candidate.id}.md`), existsSync)
    let result: SwingResult
    try {
      result = evaluateSwingCandidate(candidate, data.ctx, { stage, ...pick(stageWindow(stage)) })
    } catch (error) {
      // The attempt counts whatever happens: a rejected row and a fiche with the error, then the run aborts.
      appendRow(swingErrorRow(candidate, stage, info))
      writeFileSync(fiche, renderSwingErrorFiche(candidate, stage, info, error))
      console.error(`${candidate.id}: RECHAZADO, la evaluación se abortó por un error del candidato (ficha ${rel(fiche)})`)
      remindCommit(fiche)
      throw error
    }
    // The attempt is recorded first, whatever the verdict, so a later write failure cannot lose it.
    appendRow(swingRegistryRow(result, info))
    writeFileSync(path.join(reports, `${stage}-${candidate.id}.json`),
      JSON.stringify({ ...result, info, spot_files: data.spotManifest, funding_files: data.fundingManifest }, null, 2) + '\n')
    writeFileSync(fiche, renderSwingFiche(result, info))
    const m = result.metrics
    console.log(`${candidate.id}: ${summary(result)}`)
    console.log(`  TP ${rate(m.tp_rate)} · SL ${rate(m.sl_rate)} · tiempo ${rate(m.timeout_rate)} ` +
      `(azar: TP ${rate(m.random.tp_rate)} · SL ${rate(m.random.sl_rate)} · tiempo ${rate(m.random.timeout_rate)})`)
    for (const check of result.checks) console.log(`  ${check.passed ? 'PASA' : 'NO  '} ${check.label}: ${check.value}`)
    console.log(`  ficha ${rel(fiche)}`)
    remindCommit(fiche)
  }
  console.log(`Rules ${GATE_V2_RULES.version}; registry ${rel(registryFile)}`)
}

function pick({ periodStart, periodEnd, yearStarts }: ReturnType<typeof stageWindow>) {
  return { periodStart, periodEnd, yearStarts }
}
