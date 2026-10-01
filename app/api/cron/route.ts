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
const MODEL_VERSION = 'v1.1-live'

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

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const runId = crypto.randomUUID()
  const startedAt = Date.now()

  try {
    const supabase = getSupabaseAdmin()
    const results: Array<Record<string, unknown>> = []

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

      const featureRows = snapshots.map(s => {
        const candleSet = candles.filter(c => c.openTime <= new Date(s.captured_at).getTime())
        const f = calculateFeatures(candleSet)
        return {
          snapshot_id: s.id,
          symbol,
          timeframe: TIMEFRAME,
          captured_at: s.captured_at,
          ...f,
        }
      }).filter(r => r.ema_200 !== null)

      if (featureRows.length) {
        const { error: featureError } = await supabase
          .from('features')
          .upsert(featureRows, { onConflict: 'snapshot_id' })
        if (featureError) throw new Error(`Supabase features ${symbol}: ${featureError.message}`)
      }

      const latest = featureRows.sort((a, b) =>
        new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime(),
      )[0]

      if (!latest) throw new Error(`No usable features for ${symbol}`)

      const latestSnapshot = snapshots.find(s => s.id === latest.snapshot_id)
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
        .upsert({
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
          model_version: MODEL_VERSION,
        }, { onConflict: 'snapshot_id,model_version' })
        .select('id')
        .single()

      if (signalError || !signal?.id) throw new Error(`Supabase radar signal ${symbol}: ${signalError?.message ?? 'missing signal id'}`)

      const { error: publicMetricsError } = await supabase
        .from('radar_public_metrics')
        .upsert({
          signal_id: signal.id,
          symbol,
          rsi_14: latest.rsi_14,
          macd_histogram: latest.macd_histogram,
          volume_ratio: latest.volume_ratio,
        }, { onConflict: 'signal_id' })

      if (publicMetricsError) throw new Error(`Supabase public metrics ${symbol}: ${publicMetricsError.message}`)

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

    return NextResponse.json({
      ok: true,
      run_id: runId,
      duration_ms: Date.now() - startedAt,
      exchange: 'binance',
      timeframe: TIMEFRAME,
      model_version: MODEL_VERSION,
      generated_at: new Date().toISOString(),
      results,
    })
  } catch (error) {
    console.error('[radar-crypto cron]', {
      run_id: runId,
      duration_ms: Date.now() - startedAt,
      error,
    })
    return NextResponse.json({
      ok: false,
      run_id: runId,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown ingestion error',
    }, { status: 500 })
  }
}
