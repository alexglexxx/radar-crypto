import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  try {
    // Trae top monedas de CoinGecko
    const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=20&page=1&price_change_percentage=24h', { cache: 'no-store' })
    const data = await res.json()

    const signals = data.map((c: any) => ({
      symbol: c.symbol.toUpperCase(),
      price: c.current_price,
      change_24h: c.price_change_percentage_24h,
      volume: c.total_volume,
      score: Math.round((c.price_change_percentage_24h || 0) * 10 + Math.random() * 20 + 50),
      status: c.price_change_percentage_24h > 5 ? 'TOP' : c.price_change_percentage_24h < -2 ? 'BAJO' : 'MEDIO'
    }))

    const { error } = await supabase.from('signals').insert(signals)
    if (error) throw error

    return NextResponse.json({ ok: true, inserted: signals.length })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}
