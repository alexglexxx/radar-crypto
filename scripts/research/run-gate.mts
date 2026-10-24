#!/usr/bin/env node
// Evaluation gate on complete Binance monthly archives (no database access).
// Usage: npx tsx scripts/research/run-gate.mts --candidates=v1.1-live,control-random,control-lookahead
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type Candle } from '../../lib/features'
import { loadArchivedCandles, type ArchiveFile } from './binance-archive'
import { SYMBOLS } from './live-baseline-core'
import { GATE_RULES, REGISTRY_HEADER, evaluateCandidate, pct, registryRow, renderFiche } from './evaluation-gate'
import { CANDIDATES } from './gate-candidates'

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(candidates|from-month|to-month|seed)=(.+)$/.exec(arg)
  if (!match) throw new Error(`Unknown argument: ${arg}`)
  return [match[1], match[2]]
}))
const monthStart = (key: string, offset = 0) => {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  if (!match) throw new Error(`Month must be YYYY-MM: ${key}`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1)
}
const ids = (args.candidates ?? 'v1.1-live').split(',')
for (const id of ids) if (!CANDIDATES[id]) throw new Error(`Unknown candidate ${id}; known: ${Object.keys(CANDIDATES).join(', ')}`)
const fromMonth = args['from-month'] ?? '2023-10', toMonth = args['to-month'] ?? '2026-09'
const startMs = monthStart(fromMonth), endMs = monthStart(toMonth, 1) - 1
const seed = Number(args.seed ?? 20261024)
if (!Number.isSafeInteger(seed)) throw new Error('Invalid seed')
// Annual folds from the window start; the last one runs to the window end.
const foldStarts = [0, 12, 24].map(offset => monthStart(fromMonth, offset)).filter(t => t < endMs)

const archives = new Map<string, Candle[]>()
const manifest: ArchiveFile[] = []
for (const symbol of SYMBOLS) {
  const loaded = await loadArchivedCandles(symbol, startMs, endMs)
  archives.set(symbol, loaded.candles)
  manifest.push(...loaded.manifest)
  console.log(`${symbol}: ${loaded.candles.length} candles verified`)
}

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'scripts', 'lib'], { encoding: 'utf8' }).trim()
const context = {
  period: `${fromMonth} a ${toMonth}`,
  commit: dirty ? `${commit}+cambios` : commit,
  generatedAt: new Date().toISOString().slice(0, 10),
  data: `${manifest.length} archivos mensuales de data.binance.vision, manifiesto ${createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16)}`,
}

mkdirSync('reports/gate', { recursive: true })
mkdirSync('docs/evaluation/fichas', { recursive: true })
const registry = 'docs/evaluation/registry.tsv'
if (!existsSync(registry)) writeFileSync(registry, REGISTRY_HEADER + '\n')

for (const id of ids) {
  console.log(`${id}: evaluating...`)
  const result = evaluateCandidate(CANDIDATES[id], archives, { foldStarts, seed })
  writeFileSync(`reports/gate/${id}.json`, JSON.stringify({ ...result, context, data_files: manifest }, null, 2) + '\n')
  writeFileSync(`docs/evaluation/fichas/${context.generatedAt}-${id}.md`, renderFiche(result, context))
  appendFileSync(registry, registryRow(result, context) + '\n')
  console.log(`${id}: ${result.verdict} · ${result.metrics.signals} señales · frente al azar ${pct(result.metrics.excess)} ` +
    `(p ${result.metrics.p_outperformance?.toFixed(3) ?? '—'}) · neto ${pct(result.metrics.net_cost)} · ` +
    `fugas ${result.metrics.leak_divergences}/${result.metrics.leak_checks}`)
  for (const check of result.checks) console.log(`  ${check.passed ? 'PASA' : 'NO  '} ${check.label}: ${check.value}`)
}
console.log(`Rules ${GATE_RULES.version}; registry ${registry}`)
