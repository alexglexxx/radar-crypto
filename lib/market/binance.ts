export type BinanceCandle = {
  openTime: number
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const BASE_URL = 'https://api.binance.com'

export async function fetchBinanceClosedCandles(symbol: string, interval = '15m', limit = 250): Promise<BinanceCandle[]> {
  const url = new URL('/api/v3/klines', BASE_URL)
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', interval)
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 1000)))

  const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Binance klines failed: HTTP ${response.status}`)

  const rows = (await response.json()) as unknown
  if (!Array.isArray(rows)) throw new Error('Binance klines returned an invalid payload')

  return rows.map((row): BinanceCandle => {
    if (!Array.isArray(row) || row.length < 7) throw new Error('Binance returned a malformed kline')
    return {
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }
  }).filter(c => c.closeTime <= Date.now())
}
