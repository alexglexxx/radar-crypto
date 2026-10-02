export type BinanceCandle = {
  openTime: number
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// Binance documents data-api.binance.vision as a public market-data
// endpoint for unauthenticated REST market data, including /api/v3/klines.
// This avoids routing public market-data requests through api.binance.com,
// which currently returns HTTP 451 from Vercel's runtime region.
const BASE_URL = 'https://data-api.binance.vision'

function parseCandle(row: unknown): BinanceCandle {
  if (!Array.isArray(row) || row.length < 7) throw new Error('Binance returned a malformed kline')

  const openTime = Number(row[0])
  const open = Number(row[1])
  const high = Number(row[2])
  const low = Number(row[3])
  const close = Number(row[4])
  const volume = Number(row[5])
  const closeTime = Number(row[6])
  const values = [openTime, open, high, low, close, volume, closeTime]

  if (!values.every(Number.isFinite)) throw new Error('Binance returned non-finite candle values')
  if (openTime < 0 || closeTime < 0 || open < 0 || high < 0 || low < 0 || close < 0 || volume < 0) {
    throw new Error('Binance returned negative candle values')
  }
  if (closeTime <= openTime) throw new Error('Binance returned an invalid candle interval')
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new Error('Binance returned inconsistent OHLC values')
  }

  return { openTime, open, high, low, close, volume, closeTime }
}

export async function fetchBinanceClosedCandles(symbol: string, interval = '15m', limit = 250): Promise<BinanceCandle[]> {
  const url = new URL('/api/v3/klines', BASE_URL)
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', interval)
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 1000)))

  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })

  if (!response.ok) throw new Error(`Binance klines failed: HTTP ${response.status}`)

  const rows = (await response.json()) as unknown
  if (!Array.isArray(rows)) throw new Error('Binance klines returned an invalid payload')

  const now = Date.now()
  const candles = rows.map(parseCandle).filter(c => c.closeTime < now - 1000)

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].openTime <= candles[i - 1].openTime) {
      throw new Error('Binance returned candles out of order')
    }
  }

  return candles
}
