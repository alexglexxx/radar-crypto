#!/usr/bin/env node
// gate-v2 (spot-long swing) on complete Binance monthly archives (no database access).
// Usage: npx tsx scripts/research/run-gate-v2.mts --stage=desarrollo --candidates=swing-random,swing-lookahead,swing-btc-lookahead
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type Candle } from '../../lib/features'
import { loadArchivedCandlesWithOutages, type ArchiveFile } from './binance-archive'
import { loadArchivedFunding, type FundingPoint } from './funding-archive'
import { type Outage } from './historical-coverage'
import { SYMBOLS } from './live-baseline-core'
import { pct } from './evaluation-gate'
import { GATE_V2_RULES, evaluateSwingCandidate, type SwingStage } from './swing-gate'
import { SWING_CANDIDATES } from './swing-candidates'
import {
  REGISTRY_V2_HEADER, STAGES, assertStageAllowed, parseRegistryV2, renderSwingFiche, swingRegistryRow,
  type SwingContextInfo,
} from './swing-registry'

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(stage|candidates)=(.+)$/.exec(arg)
  if (!match) throw new Error(`Unknown argument: ${arg}`)
  return [match[1], match[2]]
}))
const monthStart = (key: string, offset = 0) => {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  if (!match) throw new Error(`Month must be YYYY-MM: ${key}`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1)
}
if (args.stage !== 'desarrollo' && args.stage !== 'examen') throw new Error('--stage=desarrollo|examen is required')
if (!args.candidates) throw new Error('--candidates=a,b is required')
const stage: SwingStage = args.stage
const ids = args.candidates.split(',')
for (const id of ids) {
  if (!SWING_CANDIDATES[id]) throw new Error(`Unknown candidate ${id}; known: ${Object.keys(SWING_CANDIDATES).join(', ')}`)
}
const candidates = ids.map(id => SWING_CANDIDATES[id])

const registryFile = 'docs/evaluation/registry-v2.tsv'
const dirtyOutput = execFileSync('git', ['status', '--porcelain', '--', 'scripts', 'lib'], { encoding: 'utf8' }).trim()
// Registry rules are enforced before any data is downloaded.
assertStageAllowed({ stage, candidates, registry: parseRegistryV2(existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : ''), dirty: dirtyOutput !== '' })

const { loadFrom, periodFrom, periodTo, years } = STAGES[stage]
const startMs = monthStart(loadFrom), endMs = monthStart(periodTo, 1) - 1
const periodStart = monthStart(periodFrom), periodEnd = monthStart(periodTo, 1)
const yearStarts = years.map(y => monthStart(y))

const candles = new Map<string, Candle[]>()
const funding = new Map<string, FundingPoint[]>()
const spotManifest: ArchiveFile[] = [], fundingManifest: ArchiveFile[] = []
let outages: Outage[] | undefined
for (const symbol of SYMBOLS) {
  const spot = await loadArchivedCandlesWithOutages(symbol, startMs, endMs, { maxOutageBars: GATE_V2_RULES.maxOutageBars })
  if (outages && JSON.stringify(outages) !== JSON.stringify(spot.outages)) {
    throw new Error(`Outages of ${symbol} differ from the other coins; only gaps identical in all coins are accepted`)
  }
  outages = spot.outages
  candles.set(symbol, spot.candles)
  spotManifest.push(...spot.manifest)
  const fund = await loadArchivedFunding(symbol, startMs, endMs)
  funding.set(symbol, fund.points)
  fundingManifest.push(...fund.manifest)
  console.log(`${symbol}: ${spot.candles.length} candles, ${fund.points.length} funding points verified, ${spot.outages.length} outages`)
}
const rate = (v: number | null) => v == null ? '—' : `${(v * 100).toFixed(1)} %`
const sha = (m: ArchiveFile[]) => createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 16)

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const info: SwingContextInfo = {
  period: `${periodFrom} a ${periodTo}`,
  commit: dirtyOutput ? `${commit}+cambios` : commit,
  generatedAt: new Date().toISOString().slice(0, 10),
  data: `${spotManifest.length} archivos mensuales de velas (manifiesto ${sha(spotManifest)}) y ${fundingManifest.length} de funding ` +
    `(manifiesto ${sha(fundingManifest)}) de data.binance.vision`,
  outages: outages ?? [],
}

mkdirSync('reports/gate-v2', { recursive: true })
mkdirSync('docs/evaluation/fichas', { recursive: true })

for (const candidate of candidates) {
  console.log(`${candidate.id}: evaluating...`)
  const result = evaluateSwingCandidate(candidate, { candles, funding }, { stage, periodStart, periodEnd, yearStarts })
  // The attempt is recorded first, whatever the verdict, so a later write failure cannot lose it.
  if (!existsSync(registryFile)) writeFileSync(registryFile, REGISTRY_V2_HEADER + '\n')
  appendFileSync(registryFile, swingRegistryRow(result, info) + '\n')
  writeFileSync(`reports/gate-v2/${stage}-${candidate.id}.json`,
    JSON.stringify({ ...result, info, spot_files: spotManifest, funding_files: fundingManifest }, null, 2) + '\n')
  writeFileSync(`docs/evaluation/fichas/${info.generatedAt}-${stage}-${candidate.id}.md`, renderSwingFiche(result, info))
  const m = result.metrics
  console.log(`${candidate.id}: ${result.verdict} · ${m.trades} operaciones · frente al azar ${pct(m.excess)} ` +
    `(p ${m.p_outperformance?.toFixed(3) ?? '—'}) · neto ${pct(m.net_cost)} · fugas ${m.leak_divergences}/${m.leak_checks}`)
  console.log(`  TP ${rate(m.tp_rate)} · SL ${rate(m.sl_rate)} · tiempo ${rate(m.timeout_rate)} ` +
    `(azar: TP ${rate(m.random.tp_rate)} · SL ${rate(m.random.sl_rate)} · tiempo ${rate(m.random.timeout_rate)})`)
  for (const check of result.checks) console.log(`  ${check.passed ? 'PASA' : 'NO  '} ${check.label}: ${check.value}`)
}
console.log(`Rules ${GATE_V2_RULES.version}; registry ${registryFile}`)
