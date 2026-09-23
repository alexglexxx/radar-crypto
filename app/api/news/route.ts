import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET(req: Request){
  const { searchParams } = new URL(req.url)
  const symbol = (searchParams.get('symbol') || 'BTC').toUpperCase()
  try {
    const rssUrl = 'https://cointelegraph.com/rss/tag/'+symbol.toLowerCase()
    const apiUrl = 'https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(rssUrl)
    const res = await fetch(apiUrl, { next: { revalidate: 600 } })
    const json = await res.json()
    let news:any[] = []
    if(json.items && json.items.length > 0){
      news = json.items.slice(0,6).map((item:any)=>({
        title: item.title,
        source: 'CoinTelegraph',
        url: item.link,
        body: (item.description || '').replace(/<[^>]*>/g,'').slice(0,160),
        time: Math.floor(new Date(item.pubDate).getTime()/1000),
        published: item.pubDate
      }))
    }
    if(news.length===0) throw new Error('empty')
    return NextResponse.json({ ok:true, symbol, news })
  } catch(e){
    return NextResponse.json({ ok:true, symbol, news: [{title: symbol+' mantiene tendencia', source:'Radar', url:'https://cointelegraph.com/tags/'+symbol.toLowerCase(), body:'Analisis tecnico'}] })
  }
}
