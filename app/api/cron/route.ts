import { LIVE_HISTORY_LIMIT } from '../../../lib/live-window'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetchBinanceClosedCandles } from '../../../lib/market/binance'
import { calculateFeatures } from '../../../lib/features'
import { calculateRadarScore } from '../../../lib/scoring'
import { evaluateMaturedLongSignals } from '../../../lib/outcomes'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
const TIMEFRAME = '15m'
const HISTORY_LIMIT = LIVE_HISTORY_LIMIT
const MODEL_VERSION = 'v1.1-live'

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) throw new Error('Missing Supabase server credentials')
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }) },
  })
}

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  const authorization = request.headers.get('authorization')?.trim()
  if (!secret || !authorization) return false
  const [scheme, ...tokenParts] = authorization.split(/\s+/)
  const token = tokenParts.join(' ')
  return scheme.toLowerCase() === 'bearer' && token === secret
}

async function fetchWithRetry(symbol: string) {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchBinanceClosedCandles(symbol, TIMEFRAME, HISTORY_LIMIT)
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Binance failed for ${symbol}`)
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()
    const results = []
    const errors: { symbol: string; error: string }[] = []

    for (const symbol of SYMBOLS) {
      try {
        const candles = await fetchWithRetry(symbol)
        if (candles.length < 200) throw new Error(`Insufficient closed candles for ${symbol}: ${candles.length}`)
        if (Date.now() - candles[candles.length - 1].closeTime > 20 * 60 * 1000) {
          throw new Error(`Stale Binance candles for ${symbol}`)
        }

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

        // Keep the existing live input and scoring parameters. Compute only the
        // latest event: older feature rows must not be rewritten with a shorter
        // warm-up window on every poll.
        const lastCandle = candles[candles.length - 1]
        const latestSnapshot = snapshots.find(s => Date.parse(s.captured_at) === lastCandle.openTime)
        if (!latestSnapshot) throw new Error(`Missing latest snapshot for ${symbol}`)
        const latest = calculateFeatures(candles)
        const { error: featureError } = await supabase.from('features').upsert({
          snapshot_id: latestSnapshot.id, symbol, timeframe: TIMEFRAME,
          captured_at: latestSnapshot.captured_at, ...latest,
        }, { onConflict: 'snapshot_id', ignoreDuplicates: true })
        if (featureError) throw new Error(`Supabase features ${symbol}: ${featureError.message}`)

        const { data: persistedFeature, error: featureLookupError } = await supabase
          .from('features')
          .select('*')
          .eq('snapshot_id', latestSnapshot.id)
          .single()

        if (featureLookupError || !persistedFeature) throw new Error(`Missing persisted feature for ${symbol}`)

        // Read back persisted features, including on a retry/concurrent run.
        const { score, status } = calculateRadarScore(persistedFeature)
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
            signal_timestamp: latestSnapshot.source_timestamp,
            stop_price: null,
            target_price: null,
            risk_reward: null,
            estimated_probability: null,
            expected_r: null,
            sample_size: candles.length,
            rationale: {
              exchange: 'binance',
              price: latestSnapshot.close,
              return_15m: persistedFeature.return_15m,
              return_1h: persistedFeature.return_1h,
              return_4h: persistedFeature.return_4h,
              return_24h: persistedFeature.return_24h,
              ema_20: persistedFeature.ema_20,
              ema_50: persistedFeature.ema_50,
              ema_200: persistedFeature.ema_200,
              trend_strength: persistedFeature.trend_strength,
              rsi_14: persistedFeature.rsi_14,
              macd_histogram: persistedFeature.macd_histogram,
              volume_ratio: persistedFeature.volume_ratio,
              atr: persistedFeature.atr,
            },
            model_version: MODEL_VERSION,
          }, { onConflict: 'snapshot_id,model_version', ignoreDuplicates: true })

        if (signalError) throw new Error(`Supabase radar signal ${symbol}: ${signalError.message}`)

        results.push({
          symbol,
          candles: candles.length,
          snapshots: snapshots.length,
          features: 1,
          latest: latestSnapshot.source_timestamp,
          score,
          status,
          decision,
        })
      } catch (error) {
        console.error(`[radar-crypto cron ${symbol}]`, error)
        errors.push({ symbol, error: error instanceof Error ? error.message : 'Ingestion failed' })
      }
    }

    let outcomes = null
    try {
      outcomes = await evaluateMaturedLongSignals(supabase, MODEL_VERSION)
    } catch (error) {
      console.error('[radar-crypto outcomes]', error)
      errors.push({ symbol: 'outcomes', error: error instanceof Error ? error.message : 'Evaluation failed' })
    }

    return NextResponse.json({
      ok: errors.length === 0,
      exchange: 'binance',
      timeframe: TIMEFRAME,
      model_version: MODEL_VERSION,
      generated_at: new Date().toISOString(),
      outcomes,
      results,
      errors,
    }, { status: errors.length ? 503 : 200 })
  } catch (error) {
    console.error('[radar-crypto cron]', error)
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown ingestion error',
    }, { status: 500 })
  }
}
