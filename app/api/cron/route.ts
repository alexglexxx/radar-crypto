import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetchBinanceClosedCandles } from '../../../lib/market/binance'
import { calculateFeatures } from '../../../lib/features'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
const TIMEFRAME = '15m'
const HISTORY_LIMIT = 250

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) throw new Error('Missing Supabase server credentials')
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const supabase = getSupabaseAdmin()
    const results = []

    for (const symbol of SYMBOLS) {
      const candles = await fetchBinanceClosedCandles(symbol, TIMEFRAME, HISTORY_LIMIT)
      if (!candles.length) throw new Error(`No closed candles returned for ${symbol}`)

      const rows = candles.map(c => ({
        captured_at: new Date(c.openTime).toISOString(),
        source_timestamp: new Date(c.closeTime).toISOString(),
        symbol, exchange: 'binance', timeframe: TIMEFRAME,
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }))

      const { data: snapshots, error: snapshotError } = await supabase
        .from('market_snapshots')
        .upsert(rows, { onConflict: 'captured_at,symbol,exchange,timeframe' })
        .select('id,captured_at,open,high,low,close,volume')
      if (snapshotError) throw new Error(`Supabase snapshots ${symbol}: ${snapshotError.message}`)

      const featureRows = snapshots.map((s: any) => {
        const candleSet = candles.filter(c => c.openTime <= new Date(s.captured_at).getTime())
        const f = calculateFeatures(candleSet)
        return {
          snapshot_id: s.id, symbol, timeframe: TIMEFRAME, captured_at: s.captured_at, ...f,
        }
      }).filter((r: any) => r.ema_200 !== null)

      if (featureRows.length) {
        const { error: featureError } = await supabase
          .from('features')
          .upsert(featureRows, { onConflict: 'snapshot_id' })
        if (featureError) throw new Error(`Supabase features ${symbol}: ${featureError.message}`)
      }

      results.push({ symbol, candles: candles.length, snapshots: snapshots.length, features: featureRows.length })
    }

    return NextResponse.json({ ok: true, exchange: 'binance', timeframe: TIMEFRAME, results })
  } catch (error) {
    console.error('[radar-crypto cron]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Unknown ingestion error' }, { status: 500 })
  }
}
