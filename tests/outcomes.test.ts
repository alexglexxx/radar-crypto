import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { evaluateMaturedLongSignals, measureOutcome } from '../lib/outcomes'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const horizons = ['15m', '1h', '4h'] as const
const signal = (id: number, ageMinutes = 300) => ({
  id, symbol: 'BTCUSDT', timeframe: '15m', decision: 'LONG',
  model_version: 'v1.1-live', entry_price: 100,
  signal_timestamp: new Date(Math.ceil((NOW - ageMinutes * 60_000) / 900_000) * 900_000 - 1).toISOString(),
})

// Exercise the real Supabase query builder against a deterministic HTTP fixture.
function fixture(signals: ReturnType<typeof signal>[], completedIds: number[] = []) {
  const outcomes = new Map<string, Record<string, unknown>>()
  for (const id of completedIds) for (const h of horizons) outcomes.set(`${id}/${h}`, { original: true })
  const writes: Record<string, unknown>[] = []
  const requests: URL[] = []
  const state = { missingTarget: false, selectionError: false, writeError: false, race: false }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push(url)
    const q = url.searchParams
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'content-type': 'application/json' },
    })
    if (url.pathname.endsWith('/radar_signals')) {
      if (state.selectionError) return json({ message: 'selection failed' }, 400)
      const h = q.get('completed.horizon')?.replace('eq.', '')
      const cutoff = q.get('signal_timestamp')!.replace('lte.', '')
      const selected = signals.filter(s =>
        s.decision === q.get('decision')?.replace('eq.', '') &&
        s.model_version === q.get('model_version')?.replace('eq.', '') &&
        s.timeframe === q.get('timeframe')?.replace('eq.', '') &&
        s.signal_timestamp <= cutoff &&
        (q.get('completed') !== 'is.null' || !outcomes.has(`${s.id}/${h}`)),
      ).sort((a, b) => a.signal_timestamp.localeCompare(b.signal_timestamp) || a.id - b.id)
      return json(selected.slice(0, Number(q.get('limit'))))
    }
    if (url.pathname.endsWith('/market_snapshots')) {
      const filters=q.getAll('source_timestamp');
      const start=Date.parse(filters.find(x=>x.startsWith('gt.'))!.slice(3));
      const end=Date.parse(filters.find(x=>x.startsWith('lte.'))!.slice(4));
      const data=Array.from({length:Math.round((end-start)/900000)},(_,i)=>({source_timestamp:new Date(start+(i+1)*900000).toISOString(),close:110,high:112,low:95}));
      const offset=Number(q.get('offset')??0);
      return json(state.missingTarget?[]:data.slice(offset,offset+Number(q.get('limit')??1000)));
    }
    if (url.pathname.endsWith('/signal_outcomes') && init?.method === 'POST') {
      if (state.writeError) return json({ message: 'write failed' }, 400)
      const rows = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      expect(q.get('on_conflict')).toBe('signal_id,horizon');
      expect(headers.get('prefer')).toContain('resolution=ignore-duplicates');
      for (const row of rows) {
        const key = row.signal_id+'/'+row.horizon;
        if(state.race)outcomes.set(key,{concurrent:true});
        if(!outcomes.has(key))outcomes.set(key,row);
        writes.push(row);
      }
      return new Response(null, { status: 201 })
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
  const client = createClient('https://fixture.invalid', 'test-key', {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false },
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  return { client, outcomes, writes, requests, state }
}

afterEach(() => vi.restoreAllMocks())

describe('evaluateMaturedLongSignals', () => {
  it('advances beyond 200 completed signals and drains pending batches on subsequent runs', async () => {
    const f = fixture(Array.from({ length: 405 }, (_, i) => signal(i + 1)),
      Array.from({ length: 200 }, (_, i) => i + 1))
    expect(await evaluateMaturedLongSignals(f.client)).toEqual({ evaluated: 600, invalidated: 0, pending: 0 })
    expect(new Set(f.writes.map(w => w.signal_id))).toEqual(new Set(Array.from({ length: 200 }, (_, i) => i + 201)))
    expect(await evaluateMaturedLongSignals(f.client)).toEqual({ evaluated: 15, invalidated: 0, pending: 0 })
    expect(await evaluateMaturedLongSignals(f.client)).toEqual({ evaluated: 0, invalidated: 0, pending: 0 })
    expect(f.outcomes.size).toBe(405 * 3)
    expect(f.outcomes.get('1/15m')).toEqual({ original: true })
    const row = f.outcomes.get('201/4h')!
    expect(row.realized_return).toBeCloseTo(0.1)
    expect(row.max_favorable_excursion).toBeCloseTo(0.12)
    expect(row.max_adverse_excursion).toBeCloseTo(-0.05)
    expect(row.outcome).toBe('WIN')
  })

  it('selects only missing, mature horizons of the live 15m LONG model', async () => {
    const f = fixture([signal(1, 20), signal(2, 70), signal(3, 250), signal(4, 5),
      { ...signal(5), decision: 'WAIT' }, { ...signal(6), model_version: 'research' },
      { ...signal(7), timeframe: '1h' }])
    f.outcomes.set('3/15m', { original: true })
    f.outcomes.set('3/1h', { original: true })
    expect((await evaluateMaturedLongSignals(f.client)).evaluated).toBe(4)
    expect(f.writes.map(w => `${w.signal_id}/${w.horizon}`).sort()).toEqual(['1/15m', '2/15m', '2/1h', '3/4h'])
  })

  it('leaves a missing market target pending and retries it on the next run', async () => {
    const f = fixture([signal(1)])
    f.state.missingTarget = true
    expect((await evaluateMaturedLongSignals(f.client)).evaluated).toBe(0)
    expect(f.writes).toHaveLength(0)
    f.state.missingTarget = false
    expect((await evaluateMaturedLongSignals(f.client)).evaluated).toBe(3)
  })

  it('preserves a concurrently inserted outcome through ignoreDuplicates', async () => {
    const f = fixture([signal(1)])
    f.state.race = true
    await evaluateMaturedLongSignals(f.client)
    expect(f.outcomes.size).toBe(3)
    for (const row of f.outcomes.values()) expect(row).toEqual({ concurrent: true })
  })

  it('propagates selection failures instead of reporting an empty successful batch', async () => {
    const f = fixture([signal(1)])
    f.state.selectionError = true
    await expect(evaluateMaturedLongSignals(f.client)).rejects.toThrow('Supabase pending outcomes 15m: selection failed')
    expect(f.writes).toHaveLength(0)
  })

  it('propagates persistence failures and leaves the outcome retryable', async () => {
    const f = fixture([signal(1)])
    f.state.writeError = true
    await expect(evaluateMaturedLongSignals(f.client)).rejects.toThrow('Supabase outcome writes: write failed')
    expect(f.outcomes.size).toBe(0)
  })

  it('invalidates old gaps explicitly so they cannot block subsequent batches', async () => {
    const f = fixture([signal(1, 48 * 60)])
    f.state.missingTarget = true
    expect(await evaluateMaturedLongSignals(f.client)).toEqual({ evaluated: 0, invalidated: 3, pending: 0 })
    for (const row of f.outcomes.values()) {
      expect(row.outcome).toBe('INVALIDATED')
      expect(row.realized_return).toBeNull()
    }
    expect((await evaluateMaturedLongSignals(f.client)).invalidated).toBe(0)
  })

  it('loads more than one snapshot page before declaring a path incomplete', async () => {
    const f = fixture([signal(1, 300), signal(2, 300 + 1001 * 15)])
    expect((await evaluateMaturedLongSignals(f.client)).evaluated).toBe(6)
    expect(f.requests.some(url => Number(url.searchParams.get('offset')) >= 1000)).toBe(true)
  })

  it('rejects a missing exact horizon even when a later candle is available', () => {
    const snapshots = [{ source_timestamp: new Date(NOW + 2 * 900_000).toISOString(), close: 110, high: 112, low: 95 }]
    expect(measureOutcome(NOW, 100, 900_000, snapshots)).toBeNull()
  })
})
