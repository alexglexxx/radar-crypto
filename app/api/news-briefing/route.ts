import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ ok:false, error:'Missing Supabase client credentials' }, { status:500 })
  const supabase = createClient(url, key)
  const { data: briefing, error } = await supabase.from('news_briefings').select('*').order('briefing_date',{ascending:false}).limit(1).maybeSingle()
  if (error) return NextResponse.json({ ok:false, error:error.message }, { status:500 })
  if (!briefing) return NextResponse.json({ ok:true, briefing:null })
  const { data: items, error:itemError } = await supabase.from('news_items').select('*').eq('briefing_id',briefing.id).order('rank',{ascending:true})
  if (itemError) return NextResponse.json({ ok:false, error:itemError.message }, { status:500 })
  return NextResponse.json({ ok:true, briefing:{...briefing,items:items||[]} })
}
