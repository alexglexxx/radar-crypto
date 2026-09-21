import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(){
 const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
 const mockSignal = { symbol:'BTC', action:'COMPRAR', score: Math.floor(Math.random()*30)+65, reason:{rsi:34, macd:'alcista', vol:'+32%', fuente:'Vercel Cron'} }
 await supabase.from('signals').insert(mockSignal)
 return NextResponse.json({ok:true, saved: mockSignal})
}
