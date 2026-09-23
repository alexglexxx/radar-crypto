import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  
  // Simula tu scoring real 0-100 como en la foto
  const coins = [
    { symbol: 'BTC', price: 68234.21 + (Math.random()*500-250), rsi: 30 + Math.floor(Math.random()*15), macd: 'alcista', vol: `+${30+Math.floor(Math.random()*10)}%`, score: 75+Math.floor(Math.random()*10) },
    { symbol: 'ETH', price: 3456.12 + (Math.random()*50-25), rsi: 50+Math.floor(Math.random()*10), macd: 'neutral', vol: `+${Math.floor(Math.random()*10)}%`, score: 40+Math.floor(Math.random()*15) },
    { symbol: 'SOL', price: 118.14, rsi: 68, macd: 'alcista', vol: '+45%', score: 82 },
    { symbol: 'XRP', price: 1.58, rsi: 72, macd: 'alcista', vol: '+60%', score: 88 },
  ]

  const toInsert = coins.map(c => ({
    symbol: c.symbol,
    price: c.price,
    score: c.score,
    change_24h: c.rsi,
    volume: parseInt(c.vol),
    status: c.score >= 70 ? 'COMPRAR' : c.score >= 40 ? 'MANTENER' : 'VENDER'
  }))

  await supabase.from('signals').insert(toInsert)
  return NextResponse.json({ ok: true, inserted: toInsert.length, data: toInsert })
}
