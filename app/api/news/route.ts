import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ALLOWED_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP'])

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = (searchParams.get('symbol') || 'BTC').toUpperCase()

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return NextResponse.json({ ok: false, error: 'Unsupported symbol' }, { status: 400 })
  }

  try {
    const rssUrl = `https://cointelegraph.com/rss/tag/${symbol.toLowerCase()}`
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`
    const res = await fetch(apiUrl, { next: { revalidate: 600 } })
    if (!res.ok) throw new Error(`RSS provider HTTP ${res.status}`)

    const json = await res.json()
    const news = Array.isArray(json.items)
      ? json.items.slice(0, 6).map((item: any) => ({
          title: item.title,
          source: 'CoinTelegraph',
          url: item.link,
          body: (item.description || '').replace(/<[^>]*>/g, '').slice(0, 160),
          time: Math.floor(new Date(item.pubDate).getTime() / 1000),
          published: item.pubDate,
        })).filter((item: any) => item.title && item.url)
      : []

    return NextResponse.json({ ok: true, symbol, news, sourceUnavailable: news.length === 0 })
  } catch (error) {
    console.error('[news]', error)
    return NextResponse.json({ ok: true, symbol, news: [], sourceUnavailable: true })
  }
}
