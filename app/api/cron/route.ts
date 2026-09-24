import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetchBinanceClosedCandles } from '@/lib/market/binance'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
const TIMEFRAME = '15m'
const HISTORY_LIMIT = 250

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL')
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()
    const results = []

    for (const symbol of SYMBOLS) {
      const candles = await fetchBinanceClosedCandles(symbol, TIMEFRAME, HISTORY_LIMIT)
      const rows = candles.map((candle) => ({
        captured_at: new Date(candle.openTime).toISOString(),
        source_timestamp: new Date(candle.closeTime).toISOString(),
        symbol,
        exchange: 'binance',
        timeframe: TIMEFRAME,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }))

      if (!rows.length) throw new Error(`No closed candles returned for ${symbol}`)

      const { error } = await supabase
        .from('market_snapshots')
        .upsert(rows, {
          onConflict: 'captured_at,symbol,exchange,timeframe',
          ignoreDuplicates: false,
        })

      if (error) throw new Error(`Supabase ${symbol}: ${error.message}`)

      results.push({
        symbol,
        candles: rows.length,
        first: rows[0].captured_at,
        last: rows[rows.length - 1].captured_at,
      })
    }

    return NextResponse.json({ ok: true, exchange: 'binance', timeframe: TIMEFRAME, results })
  } catch (error) {
    console.error('[radar-crypto cron]', error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown ingestion error' },
      { status: 500 },
    )
  }
}
