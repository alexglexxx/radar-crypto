import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetchBinanceClosedCandles } from '../../../lib/market/binance'
import { calculateFeatures } from '../../../lib/features'
import { calculateRadarScore } from '../../../lib/scoring'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
const TIMEFRAME = '15m'
const HISTORY_LIMIT = 250
const OUTCOME_HORIZONS = [
  { name: '15m', ms: 15 * 60 * 1000 },
  { name: '1h', ms: 60 * 60 * 1000 },
  { name: '4h', ms: 4 * 60 * 60 * 1000 },
] as const

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) throw new Error('Missing Supabase server credentials')
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  const authorization = request.headers.get('authorization')?.trim()
  if (!secret || !authorization) return false

  const [scheme, ...tokenParts] = authorization.split(/\s+/)
  const token = tokenParts.join(' ')
  return scheme.toLowerCase() === 'bearer' && token === secret
}

async function evaluateMaturedLongSignals(supabase: ReturnType<typeof getSupabaseAdmin>) {
  const cutoff = new Date(Date.now() - OUTCOME_HORIZONS[0].ms).toISOString()

  const { data: signals, error: signalError } = await supabase
    .from('radar_signals')
    .select('id,symbol,created_at,entry_price,decision')
    .eq('decision', 'LONG')
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(200)

  if (signalError) throw new Error(`Supabase outcome signals: ${signalError.message}`)
  if (!signals?.length) return { evaluated: 0, skipped: 0 }

  let evaluated = 0
  let skipped = 0

  for (const signal of signals) {
    const signalTime = new Date(signal.created_at).getTime()
    const entry = Number(signal.entry_price)
    if (!Number.isFinite(entry) || entry <= 0) {
      skipped++
      continue
    }

    for (const horizon of OUTCOME_HORIZONS) {
      const targetTime = new Date(signalTime + horizon.ms).toISOString()

      const { data: existing, error: existingError } = await supabase
        .from('signal_outcomes')
        .select('id')
        .eq('signal_id', signal.id)
        .eq('horizon', horizon.name)
        .limit(1)

      if (existingError) throw new Error(`Supabase outcome lookup ${signal.id}/${horizon.name}: ${existingError.message}`)
      if (existing?.length) continue

      const { data: target, error: targetError } = await supabase
        .from('market_snapshots')
        .select('captured_at,source_timestamp,close,high,low')
        .eq('symbol', signal.symbol)
        .eq('timeframe', TIMEFRAME)
        .gte('source_timestamp', targetTime)
        .order('source_timestamp', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (targetError) throw new Error(`Supabase outcome target ${signal.id}/${horizon.name}: ${targetError.message}`)
      if (!target) continue

      const targetClose = Number(target.close)
      if (!Number.isFinite(targetClose) || targetClose <= 0) continue

      const { data: path, error: pathError } = await supabase
        .from('market_snapshots')
        .select('high,low')
        .eq('symbol', signal.symbol)
        .eq('timeframe', TIMEFRAME)
        .gte('source_timestamp', signal.created_at)
        .lte('source_timestamp', target.source_timestamp)
        .order('source_timestamp', { ascending: true })

      if (pathError) throw new Error(`Supabase outcome path ${signal.id}/${horizon.name}: ${pathError.message}`)

      const highs = (path ?? []).map(row => Number(row.high)).filter(Number.isFinite)
      const lows = (path ?? []).map(row => Number(row.low)).filter(Number.isFinite)
      const mfe = highs.length ? Math.max(...highs.map(high => (high - entry) / entry)) : null
      const mae = lows.length ? Math.min(...lows.map(low => (low - entry) / entry)) : null
      const realizedReturn = (targetClose - entry) / entry
      const outcome = realizedReturn > 0 ? 'WIN' : realizedReturn < 0 ? 'LOSS' : 'TIMEOUT'

      const { error: insertError } = await supabase
        .from('signal_outcomes')
        .insert({
          signal_id: signal.id,
          evaluated_at: new Date().toISOString(),
          horizon: horizon.name,
          outcome_price: targetClose,
          realized_return: realizedReturn,
          realized_r: null,
          max_favorable_excursion: mfe,
          max_adverse_excursion: mae,
          outcome,
        })

      if (insertError) throw new Error(`Supabase outcome insert ${signal.id}/${horizon.name}: ${insertError.message}`)
      evaluated++
    }
  }

  return { evaluated, skipped }
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
      if (!candles.length) throw new Error(`No closed candles returned for ${symbol}`)

      const rows = candles.map(c => ({
        captured_at: new Date(c.openTime).toISOString(),
        source_timestamp: new Date(c.closeTime).toISOString(),
        symbol,
        exchange: 'binance',
        timeframe: TIMEFRAME,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }))

      const { data: snapshots, error: snapshotError } = await supabase
        .from('market_snapshots')
        .upsert(rows, { onConflict: 'captured_at,symbol,exchange,timeframe' })
        .select('id,captured_at,source_timestamp,open,high,low,close,volume')

      if (snapshotError) throw new Error(`Supabase snapshots ${symbol}: ${snapshotError.message}`)
      if (!snapshots?.length) throw new Error(`No snapshots persisted for ${symbol}`)

      const featureRows = snapshots.map((s: any) => {
        const candleSet = candles.filter(c => c.openTime <= new Date(s.captured_at).getTime())
        const f = calculateFeatures(candleSet)
        return {
          snapshot_id: s.id,
          symbol,
          timeframe: TIMEFRAME,
          captured_at: s.captured_at,
          ...f,
        }
      }).filter((r: any) => r.ema_200 !== null)

      if (featureRows.length) {
        const { error: featureError } = await supabase
          .from('features')
          .upsert(featureRows, { onConflict: 'snapshot_id' })
        if (featureError) throw new Error(`Supabase features ${symbol}: ${featureError.message}`)
      }

      const latest = featureRows.sort((a: any, b: any) =>
        new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime(),
      )[0]

      if (!latest) throw new Error(`No usable features for ${symbol}`)

      const latestSnapshot = snapshots.find((s: any) => s.id === latest.snapshot_id)
      if (!latestSnapshot) throw new Error(`Missing latest snapshot for ${symbol}`)

      const { data: persistedFeature, error: featureLookupError } = await supabase
        .from('features')
        .select('id')
        .eq('snapshot_id', latest.snapshot_id)
        .single()

      if (featureLookupError || !persistedFeature) {
        throw new Error(`Missing persisted feature for ${symbol}`)
      }

      const { score, status } = calculateRadarScore(latest)
      const decision = status === 'SETUP LONG' ? 'LONG' : 'WAIT'

      const { error: signalError } = await supabase
        .from('radar_signals')
        .insert({
          snapshot_id: latestSnapshot.id,
          feature_id: persistedFeature.id,
          symbol,
          timeframe: TIMEFRAME,
          regime: status,
          signal_score: score,
          decision,
          entry_price: latestSnapshot.close,
          stop_price: null,
          target_price: null,
          risk_reward: null,
          estimated_probability: null,
          expected_r: null,
          sample_size: featureRows.length,
          rationale: {
            exchange: 'binance',
            price: latestSnapshot.close,
            return_15m: latest.return_15m,
            return_1h: latest.return_1h,
            return_4h: latest.return_4h,
            return_24h: latest.return_24h,
            ema_20: latest.ema_20,
            ema_50: latest.ema_50,
            ema_200: latest.ema_200,
            trend_strength: latest.trend_strength,
            rsi_14: latest.rsi_14,
            macd_histogram: latest.macd_histogram,
            volume_ratio: latest.volume_ratio,
            atr: latest.atr,
          },
          model_version: 'v1.1-live',
        })

      if (signalError) throw new Error(`Supabase radar signal ${symbol}: ${signalError.message}`)

      results.push({
        symbol,
        candles: candles.length,
        snapshots: snapshots.length,
        features: featureRows.length,
        latest: latest.captured_at,
        score,
        status,
        decision,
      })
    }

    const outcomes = await evaluateMaturedLongSignals(supabase)

    return NextResponse.json({
      ok: true,
      exchange: 'binance',
      timeframe: TIMEFRAME,
      generated_at: new Date().toISOString(),
      outcomes,
      results,
    })
  } catch (error) {
    console.error('[radar-crypto cron]', error)
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown ingestion error',
    }, { status: 500 })
  }
}
