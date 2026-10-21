import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBinanceClosedCandles } from '../lib/market/binance'

const BAR = 900_000
const NOW = Date.parse('2026-10-20T12:01:00Z')
const OPEN = Math.floor(NOW / BAR) * BAR
const row = (open: number) => [open, '100', '110', '90', '105', '1000', open + BAR - 1]
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function feed(rows: unknown) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows)))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
describe('Binance closed 15m candles', () => {
  it('excludes the open candle and sends a bounded, uncached request', async () => {
    const fetcher = feed([row(OPEN - BAR * 2), row(OPEN - BAR), row(OPEN)])
    const candles = await fetchBinanceClosedCandles('BTCUSDT')
    expect(candles.map(c => c.openTime)).toEqual([OPEN - BAR * 2, OPEN - BAR])
    const [url, options] = fetcher.mock.calls[0]
    expect(url.hostname).toBe('data-api.binance.vision')
    expect(url.searchParams.get('limit')).toBe('250')
    expect(options.cache).toBe('no-store')
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })
  it.each([
    ['duplicates', () => [row(OPEN - BAR), row(OPEN - BAR)]],
    ['gaps', () => [row(OPEN - BAR * 3), row(OPEN - BAR)]],
    ['incorrect boundaries', () => [row(OPEN - BAR + 1)]],
    ['zero price', () => [[OPEN - BAR, '0', '110', '0', '0', '1', OPEN - 1]]],
    ['non-finite values', () => [[OPEN - BAR, 'x', '110', '90', '100', '1', OPEN - 1]]],
  ])('rejects %s', async (_, rows) => {
    feed(rows())
    await expect(fetchBinanceClosedCandles('BTCUSDT')).rejects.toThrow()
  })
  it('propagates upstream errors instead of treating them as an empty feed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 451 })))
    await expect(fetchBinanceClosedCandles('BTCUSDT')).rejects.toThrow('HTTP 451')
  })
})
