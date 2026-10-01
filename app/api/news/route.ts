import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ALLOWED_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP'])

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = (searchParams.get('symbol') || 'BTC').toUpperCase()

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return NextResponse.json(
      { ok: false, error: 'Unsupported symbol' },
      { status: 400 },
    )
  }

  try {
    const rssUrl = 'https://cointelegraph.com/rss/tag/' + symbol.toLowerCase()
    const apiUrl = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(rssUrl)
    const res = await fetch(apiUrl, { next: { revalidate: 600 } })

    if (!res.ok) {
      throw new Error(`RSS provider failed: HTTP ${res.status}`)
    }

    const json = await res.json()
    const items = Array.isArray(json?.items) ? json.items : []
    const news = items.slice(0, 6).map((item: Record<string, unknown>) => ({
      title: typeof item.title === 'string' ? item.title : 'Sin título',
      source: 'CoinTelegraph',
      url: typeof item.link === 'string' ? item.link : null,
      body: typeof item.description === 'string'
        ? item.description.replace(/<[^>]*>/g, '').slice(0, 160)
        : '',
      time: typeof item.pubDate === 'string' ? Math.floor(new Date(item.pubDate).getTime() / 1000) : null,
      published: typeof item.pubDate === 'string' ? item.pubDate : null,
    }))

    return NextResponse.json({
      ok: true,
      symbol,
      source_available: news.length > 0,
      news,
    })
  } catch (error) {
    console.error('[radar-crypto news]', { symbol, error })
    return NextResponse.json({
      ok: true,
      symbol,
      source_available: false,
      news: [],
    })
  }
}
