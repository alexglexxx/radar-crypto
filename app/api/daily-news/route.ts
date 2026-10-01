import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const
const FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
]

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase server credentials')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return false
  const auth = request.headers.get('authorization')?.trim() || ''
  return auth.toLowerCase() === `bearer ${secret}`
}

type Candidate = {
  source: string
  url: string
  title: string
  description: string
  publishedAt: string | null
}

function xmlText(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim()
}

function tag(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return match ? xmlText(match[1]) : ''
}

function parseRss(xml: string, source: string): Candidate[] {
  const items: string[] = []
  const regex = /<item[\s\S]*?<\/item>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) items.push(match[0])
  return items.map(item => ({
    source,
    url: tag(item, 'link'),
    title: tag(item, 'title'),
    description: tag(item, 'description').slice(0, 1200),
    publishedAt: tag(item, 'pubDate') || null,
  })).filter(x => x.title && x.url)
}

const macroTerms = ['fed', 'federal reserve', 'fomc', 'cpi', 'inflation', 'interest rate', 'rates', 'treasury', 'dollar', 'dxy', 'jobs report', 'employment', 'recession', 'liquidity', 'etf', 'sec', 'regulation', 'regulator', 'stablecoin', 'tariff', 'china', 'europe', 'hack', 'exploit', 'liquidation', 'bankruptcy']

function relevance(candidate: Candidate) {
  const text = `${candidate.title} ${candidate.description}`.toLowerCase()
  const scores = Object.fromEntries(ASSETS.map(a => [a, 0])) as Record<string, number>
  for (const asset of ASSETS) {
    const terms = asset === 'BTC' ? ['bitcoin', 'btc'] : asset === 'ETH' ? ['ethereum', 'ether', 'eth'] : asset === 'SOL' ? ['solana', 'sol'] : ['xrp', 'ripple']
    if (terms.some(t => text.includes(t))) scores[asset] += 70
  }
  if (macroTerms.some(t => text.includes(t))) for (const asset of ASSETS) scores[asset] += 30
  const max = Math.max(...Object.values(scores))
  return { scores, max }
}

async function collectNews(): Promise<Candidate[]> {
  const cutoff = Date.now() - 36 * 60 * 60 * 1000
  const all: Candidate[] = []
  for (const feed of FEEDS) {
    const response = await fetch(feed.url, { cache: 'no-store', headers: { 'user-agent': 'RadarCrypto/1.0' } })
    if (!response.ok) continue
    const xml = await response.text()
    all.push(...parseRss(xml, feed.name))
  }
  const filtered = all.filter(x => {
    const published = x.publishedAt ? new Date(x.publishedAt).getTime() : Date.now()
    return Number.isFinite(published) && published >= cutoff && relevance(x).max >= 30
  })
  const seen = new Set<string>()
  return filtered.filter(x => {
    const key = x.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime()).slice(0, 30)
}

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    intro: { type: 'string' }, market_read: { type: 'string' }, risk_read: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      source_index: { type: 'integer' }, summary: { type: 'string' }, why_it_matters: { type: 'string' },
      impact_direction: { type: 'string', enum: ['positive','negative','mixed','neutral'] },
      impact_intensity: { type: 'string', enum: ['low','medium','high','critical'] },
      impact_start: { type: 'string' }, primary_window: { type: 'string' }, persistence_window: { type: 'string' },
      affected_assets: { type: 'array', items: { type: 'string', enum: ['BTC','ETH','SOL','XRP'] } },
      relevance_score: { type: 'integer', minimum: 0, maximum: 100 }, confidence: { type: 'integer', minimum: 0, maximum: 100 },
    }, required: ['source_index','summary','why_it_matters','impact_direction','impact_intensity','impact_start','primary_window','persistence_window','affected_assets','relevance_score','confidence'] } }
  }, required: ['intro','market_read','risk_read','items']
}

async function analyze(candidates: Candidate[]) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY')
  const payload = candidates.map((x, i) => ({ index: i, source: x.source, title: x.title, description: x.description, published_at: x.publishedAt }))
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.NEWS_AI_MODEL || 'gpt-5.6-luna',
      input: [
        { role: 'system', content: 'Eres News Intelligence de Radar Crypto. Analiza SOLO noticias relevantes para BTC, ETH, SOL y XRP. No inventes hechos. Resume en español claro y corto. Diferencia hecho de interpretación. La ventana temporal es una estimación, no una predicción de precio. Una noticia macro puede afectar las cuatro. Elige solo las 5 a 7 noticias de mayor relevancia; elimina duplicados y ruido. relevance_score mide relevancia para nuestro universo, no probabilidad de subida. confidence mide confianza en la clasificación.' },
        { role: 'user', content: `Noticias candidatas de las últimas 36 horas:\n${JSON.stringify(payload)}` }
      ],
      text: { format: { type: 'json_schema', name: 'crypto_daily', strict: true, schema } },
    }),
  })
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const json = await response.json()
  const text = json.output_text
  if (!text) throw new Error('OpenAI returned no output_text')
  return JSON.parse(text)
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const today = new Date().toISOString().slice(0, 10)
    const supabase = admin()
    const existing = await supabase.from('news_briefings').select('id,briefing_date,item_count,generated_at').eq('briefing_date', today).maybeSingle()
    if (existing.data) return NextResponse.json({ ok: true, reused: true, briefing: existing.data })

    const candidates = await collectNews()
    if (!candidates.length) throw new Error('No relevant crypto news found for BTC/ETH/SOL/XRP')
    const analysis = await analyze(candidates)
    const selected = analysis.items.filter((x: any) => candidates[x.source_index]).sort((a: any, b: any) => b.relevance_score - a.relevance_score).slice(0, 7)
    const { data: briefing, error: briefingError } = await supabase.from('news_briefings').insert({ briefing_date: today, title: `Crypto Daily — ${today}`, intro: analysis.intro, market_read: analysis.market_read, risk_read: analysis.risk_read, model_version: process.env.NEWS_AI_MODEL || 'gpt-5.6-luna', item_count: selected.length }).select().single()
    if (briefingError || !briefing) throw new Error(briefingError?.message || 'Could not create briefing')

    const rows = selected.map((x: any, rank: number) => {
      const source = candidates[x.source_index]
      const confirmation = 'pending'
      return { briefing_id: briefing.id, source: source.source, url: source.url, title: source.title, published_at: source.publishedAt, summary: x.summary, why_it_matters: x.why_it_matters, impact_direction: x.impact_direction, impact_intensity: x.impact_intensity, impact_start: x.impact_start, primary_window: x.primary_window, persistence_window: x.persistence_window, affected_assets: x.affected_assets, relevance_score: x.relevance_score, confidence: x.confidence, market_confirmation: confirmation, rank: rank + 1 }
    })
    const { error: itemError } = await supabase.from('news_items').insert(rows)
    if (itemError) throw new Error(itemError.message)
    return NextResponse.json({ ok: true, briefing: { ...briefing, item_count: rows.length }, candidates: candidates.length })
  } catch (error) {
    console.error('[daily-news]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 })
  }
}
