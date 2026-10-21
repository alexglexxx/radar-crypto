import type { SupabaseClient } from '@supabase/supabase-js'

const BAR_MS = 15 * 60 * 1000
export const OUTCOME_HORIZONS = [
  { name: '15m', ms: BAR_MS },
  { name: '1h', ms: 4 * BAR_MS },
  { name: '4h', ms: 16 * BAR_MS },
] as const

type Snapshot = { source_timestamp: string; close: number; high: number; low: number }

// Exact source timestamps and a complete path are required. Never substitute a
// later candle for a missing horizon, or silently understate MAE/MFE after gaps.
export function measureOutcome(signalTime: number, entry: number, horizonMs: number, snapshots: Snapshot[]) {
  const target = signalTime + horizonMs
  const path = snapshots.filter(s => {
    const time = Date.parse(s.source_timestamp)
    return time > signalTime && time <= target
  })
  const complete = path.length === horizonMs / BAR_MS && path.every((s, i) =>
    Date.parse(s.source_timestamp) === signalTime + (i + 1) * BAR_MS &&
    [s.close, s.high, s.low].every(v => Number.isFinite(Number(v)) && Number(v) > 0),
  )
  if (!complete || !Number.isFinite(entry) || entry <= 0) return null
  const price = Number(path[path.length - 1].close)
  const realizedReturn = (price - entry) / entry
  return {
    outcome_price: price,
    realized_return: realizedReturn,
    max_favorable_excursion: Math.max(...path.map(s => (Number(s.high) - entry) / entry)),
    max_adverse_excursion: Math.min(...path.map(s => (Number(s.low) - entry) / entry)),
    outcome: realizedReturn > 0 ? 'WIN' : realizedReturn < 0 ? 'LOSS' : 'TIMEOUT',
  }
}

export async function evaluateMaturedLongSignals(supabase: SupabaseClient, modelVersion = 'v1.1-live', now = Date.now()) {
  const pending = []
  for (const horizon of OUTCOME_HORIZONS) {
    // Anti-join per horizon: completed rows cannot occupy the batch forever.
    const { data, error } = await supabase.from('radar_signals')
      .select('id,symbol,signal_timestamp,entry_price,completed:signal_outcomes!left(id)')
      .eq('decision', 'LONG').eq('model_version', modelVersion).eq('timeframe', '15m')
      .eq('completed.horizon', horizon.name).is('completed', null)
      .lte('signal_timestamp', new Date(now - horizon.ms).toISOString())
      .order('signal_timestamp', { ascending: true }).order('id', { ascending: true }).limit(200)
    if (error) throw new Error(`Supabase pending outcomes ${horizon.name}: ${error.message}`)
    for (const signal of data ?? []) pending.push({ signal, horizon })
  }
  if (!pending.length) return { evaluated: 0, invalidated: 0, pending: 0 }

  const rows = []
  let waiting = 0
  let invalidated = 0
  for (const symbol of [...new Set(pending.map(p => p.signal.symbol))]) {
    const tasks = pending.filter(p => p.signal.symbol === symbol)
    const start = Math.min(...tasks.map(p => Date.parse(p.signal.signal_timestamp)))
    const end = Math.max(...tasks.map(p => Date.parse(p.signal.signal_timestamp) + p.horizon.ms))
    const snapshots: Snapshot[] = []
    // Supabase caps responses. Read every page before judging completeness.
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('market_snapshots')
        .select('source_timestamp,close,high,low').eq('symbol', symbol)
        .eq('exchange', 'binance').eq('timeframe', '15m')
        .gt('source_timestamp', new Date(start).toISOString())
        .lte('source_timestamp', new Date(end).toISOString())
        .order('source_timestamp', { ascending: true }).range(offset, offset + 999)
      if (error) throw new Error(`Supabase outcome candles ${symbol}: ${error.message}`)
      snapshots.push(...(data ?? []))
      if (!data || data.length < 1000) break
      if (offset >= 19_000) throw new Error(`Outcome candle batch too large for ${symbol}`)
    }
    for (const { signal, horizon } of tasks) {
      const signalTime = Date.parse(signal.signal_timestamp)
      const measured = measureOutcome(signalTime, Number(signal.entry_price), horizon.ms, snapshots)
      // Give ingestion a day to recover a missing candle. Terminal gaps are
      // recorded explicitly, so bad history cannot starve all future results.
      if (!measured && now < signalTime + horizon.ms + 24 * 60 * 60 * 1000) {
        waiting++
        continue
      }
      if (!measured) invalidated++
      rows.push({
        signal_id: signal.id, horizon: horizon.name, evaluated_at: new Date(now).toISOString(),
        realized_r: null,
        ...(measured ?? { outcome: 'INVALIDATED', outcome_price: null, realized_return: null,
          max_favorable_excursion: null, max_adverse_excursion: null }),
      })
    }
  }
  if (rows.length) {
    const { error } = await supabase.from('signal_outcomes')
      .upsert(rows, { onConflict: 'signal_id,horizon', ignoreDuplicates: true })
    if (error) throw new Error(`Supabase outcome writes: ${error.message}`)
  }
  return { evaluated: rows.length - invalidated, invalidated, pending: waiting }
}
