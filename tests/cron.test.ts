import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../app/api/cron/route'
import { calculateFeatures } from '../lib/features'
import { calculateRadarScore } from '../lib/scoring'
import { fetchBinanceClosedCandles } from '../lib/market/binance'
import rows from './fixtures/btcusdt-15m.json'
import { replayLiveSignal, BAR_MS } from '../lib/live-window'

vi.mock('../lib/market/binance', () => ({ fetchBinanceClosedCandles: vi.fn() }))
const NOW = Date.parse('2026-10-20T12:01:00Z')
const candles = Array.from({ length: 249 }, (_, i) => ({
  openTime: NOW - 60_000 - (249 - i) * 900_000,
  closeTime: NOW - 60_000 - (248 - i) * 900_000 - 1,
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000 + i,
}))
const request = () => new NextRequest('https://radar.invalid/api/cron', { headers: { authorization: 'Bearer fixture-secret' } })

function database() {
  const snapshots = new Map<string, any>()
  const features = new Map<string, any>()
  const signals = new Map<string, any>()
  const state = { failSignal: false, failReadback: false }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), q = url.searchParams
    const table = url.pathname.split('/').pop()
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    if (init?.method === 'POST') {
      const prefer = new Headers(init.headers).get('prefer') ?? ''
      if (table === 'radar_signals' && state.failSignal) return json({ message: 'signal write failed' }, 400)
      const body = JSON.parse(String(init.body))
      const rows = Array.isArray(body) ? body : [body]
      const stored = rows.map(row => {
        const store = table === 'market_snapshots' ? snapshots : table === 'features' ? features : signals
        const key = table === 'market_snapshots' ? `${row.symbol}/${row.captured_at}` : table === 'features' ? String(row.snapshot_id) : `${row.snapshot_id}/${row.model_version}`
        const existing = store.get(key)
        const record = existing && prefer.includes('ignore-duplicates') ? existing : { ...existing, ...row, id: existing?.id ?? store.size + 1 }
        store.set(key, record)
        return record
      })
      return json(stored, 201)
    }
    if (table === 'features') {
      if (state.failReadback) return json({ message: 'feature read failed' }, 400)
      return json(features.get(q.get('snapshot_id')!.slice(3)))
    }
    if (table === 'radar_signals') return json([]) // No historical LONGs in this fixture.
    throw new Error(`Unexpected database request ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return { snapshots, features, signals, fetcher, state }
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'fixture-secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key')
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(fetchBinanceClosedCandles).mockReset().mockResolvedValue(candles)
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('cron persistence and recovery', () => {
  it('matches archive replay against actual Binance parsing, cron and persisted signals on real candles', async () => {
    const db = database()
    const actual = await vi.importActual<typeof import('../lib/market/binance')>('../lib/market/binance')
    const archive = rows.map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
      low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
    let responseRows = rows.slice(0, 250)
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('data-api.binance.vision')) return new Response(JSON.stringify(responseRows))
      return db.fetcher(input, init)
    })
    vi.mocked(fetchBinanceClosedCandles).mockImplementation(actual.fetchBinanceClosedCandles)
    // Include short startup, rolling windows, the closure safety boundary,
    // later history, and both LONG and WAIT states. All DB writes are fixtures.
    for (const index of [199, 248, 249, 350, 500, 750, 998]) {
      for (const offset of [0, 999, 1000, 5000]) {
        const now = archive[index].openTime + BAR_MS + offset
        vi.mocked(Date.now).mockReturnValue(now)
        responseRows = rows.slice(Math.max(0, index + 2 - 250), index + 2)
        const expected = replayLiveSignal(archive, now)
        const response = await GET(request())
        expect(response.status).toBe(expected ? 200 : 503)
        if (!expected) continue
        for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
          const signal = [...db.signals.values()].find(s => s.symbol === symbol &&
            s.signal_timestamp === new Date(expected.signalTimestamp).toISOString())
          expect(signal).toMatchObject({ signal_score: expected.score, regime: expected.status,
            decision: expected.decision, entry_price: expected.entryPrice, sample_size: expected.sampleSize })
          const feature = db.features.get(String(signal.snapshot_id))
          for (const [key, value] of Object.entries(expected.features)) expect(feature[key]).toBe(value)
        }
        // Isolate each response condition; retry immutability is covered above.
        db.snapshots.clear(); db.features.clear(); db.signals.clear()
      }
    }
  })

  it('rejects unauthorized callers before contacting Binance or Supabase', async () => {
    const db = database()
    expect((await GET(new NextRequest('https://radar.invalid/api/cron'))).status).toBe(401)
    expect(db.fetcher).not.toHaveBeenCalled()
    expect(fetchBinanceClosedCandles).not.toHaveBeenCalled()
  })

  it('persists and recovers the unchanged strategy output without duplicate events on concurrent retries', async () => {
    const db = database()
    const responses = await Promise.all([GET(request()), GET(request())])
    for (const response of responses) expect(response.status).toBe(200)
    expect(db.snapshots.size).toBe(249 * 4)
    expect(db.features.size).toBe(4)
    expect(db.signals.size).toBe(4)
    const expected = calculateRadarScore(calculateFeatures(candles))
    for (const signal of db.signals.values()) {
      expect(signal.signal_score).toBe(expected.score)
      expect(signal.regime).toBe(expected.status)
      expect(signal.model_version).toBe('v1.1-live')
      expect(signal.sample_size).toBe(249)
      expect(signal.signal_timestamp).toBe(new Date(candles.at(-1)!.closeTime).toISOString())
    }
    const before = JSON.stringify([...db.features.values()])
    await GET(request())
    expect(JSON.stringify([...db.features.values()])).toBe(before)
  })

  it('recovers a partial signal write failure on the next invocation', async () => {
    const db = database()
    db.state.failSignal = true
    expect((await GET(request())).status).toBe(503)
    expect(db.signals.size).toBe(0)
    db.state.failSignal = false
    expect((await GET(request())).status).toBe(200)
    expect(db.signals.size).toBe(4)
    expect(db.features.size).toBe(4)
    expect(db.snapshots.size).toBe(249 * 4)
  })

  it('continues healthy symbols when another symbol returns stale data', async () => {
    const db = database()
    vi.mocked(fetchBinanceClosedCandles).mockImplementation(async symbol => symbol === 'BTCUSDT'
      ? candles.map(c => ({ ...c, openTime: c.openTime - 3_600_000, closeTime: c.closeTime - 3_600_000 })) : candles)
    const response = await GET(request())
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.results).toHaveLength(3)
    expect(body.errors[0]).toMatchObject({ symbol: 'BTCUSDT', error: 'Stale Binance candles for BTCUSDT' })
    expect(db.signals.size).toBe(3)
  })

  it('does not emit a signal when persisted features cannot be recovered', async () => {
    const db = database()
    db.state.failReadback = true
    expect((await GET(request())).status).toBe(503)
    expect(db.signals.size).toBe(0)
  })
})
