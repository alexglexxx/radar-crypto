// Publishes one GitHub Actions "notice" annotation per strategy so the results can be read
// through the API without downloading artifacts. Research only; reads reports/ideas-v2/summary.json.
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(process.env.REPORT_DIR || path.join(process.cwd(), 'reports', 'ideas-v2'), 'summary.json')
if (!fs.existsSync(file)) {
  console.log('::warning title=ideas-v2::summary.json not found')
  process.exit(0)
}

const { meta, results } = JSON.parse(fs.readFileSync(file, 'utf8'))
const pct = (v, d = 3) => (v === null || v === undefined ? 'n/d' : (v * 100).toFixed(d) + '%')
const clean = text => String(text).replace(/[\r\n%]/g, ' ')

console.log(`::notice title=ideas-v2 meta::${clean(JSON.stringify({ source: meta.dataSource, months: meta.months, strategies: meta.strategiesEvaluated, generatedAt: meta.generatedAt }))}`)

for (const r of [...results].sort((a, b) => a.idea - b.idea || a.id.localeCompare(b.id))) {
  const p = (r.pooled && r.pooled['20']) || {}
  const s = (r.pooled && r.pooled['30']) || {}
  const line = {
    verdict: r.verdict,
    trades: p.trades ?? 0,
    exp20: pct(p.expectancy),
    exp30: pct(s.expectancy),
    ci: r.pooledCI ? `[${pct(r.pooledCI.lo, 2)}, ${pct(r.pooledCI.hi, 2)}]` : 'n/d',
    folds: `${r.positiveFolds}/${r.totalFolds}`,
    vsAlwaysIn: pct(r.edgeOverAlwaysIn),
    win: pct(p.winRate, 1),
    dd: pct(p.maxDrawdown, 1),
    exposure: pct(r.exposure, 1),
    buyHold: pct(r.buyAndHoldAvg, 1),
    why: (r.verdictReasons || []).join(' | '),
  }
  console.log(`::notice title=${r.id}::${clean(JSON.stringify(line))}`)
}
