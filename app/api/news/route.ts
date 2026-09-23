import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET(req: Request){
  const { searchParams } = new URL(req.url)
  const symbol = (searchParams.get('symbol') || 'BTC').toUpperCase()

  try {
    // API gratis de CryptoCompare - noticias reales de Coindesk, Cointelegraph, etc
    const res = await fetch(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=${symbol}&extraParams=radar-crypto`, {
      next: { revalidate: 300 } // cache 5 min
    })
    const json = await res.json()
    
    if(!json.Data) throw new Error('no data')

    const news = json.Data.slice(0,6).map((n:any)=>({
      title: n.title,
      source: n.categories?.split('|')[0] || n.source_info?.name || 'Crypto',
      url: n.url,
      body: n.body?.slice(0,180) + '...',
      time: n.published_on,
      sentiment: n.categories?.toLowerCase().includes('bull') ? 'alcista' : 'neutral'
    }))

    return NextResponse.json({ ok:true, symbol, news })
  } catch(e:any){
    // fallback si falla la API - al menos regresa algo
    return NextResponse.json({
      ok:false,
      symbol,
      news: [
        { title: `${symbol} mantiene tendencia con volumen alto`, source: 'Radar Analysis', url:'#', body:'Analisis tecnico basado en RSI y MACD de tu radar', sentiment:'alcista' },
      ]
    })
  }
}
