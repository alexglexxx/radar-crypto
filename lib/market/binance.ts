export type BinanceCandle = {
  openTime: number
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const BASE_URL = 'https://data-api.binance.vision'

function assertFiniteCandle(candle: BinanceCandle) {
  const values = [candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
  if (values.some(value => !Number.isFinite(value))) {
    throw new Error('Binance returned non-finite kline values')
  }
  if (candle.openTime <= 0 || candle.closeTime < candle.openTime) {
    throw new Error('Binance returned invalid kline timestamps')
  }
  if (candle.low <= 0 || candle.high <= 0 || candle.open <= 0 || candle.close <= 0) {
    throw new Error('Binance returned non-positive OHLC values')
  }
  if (candle.high < candle.low || candle.open < candle.low || candle.open > candle.high || candle.close < candle.low || candle.close > candle.high) {
    throw new Error('Binance returned inconsistent OHLC values')
  }
  if (candle.volume < 0) throw new Error('Binance returned negative volume')
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

  const candles = rows.map((row): BinanceCandle => {
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
  })

  candles.forEach(assertFiniteCandle)

  const closed = candles
    .filter(c => c.closeTime <= Date.now())
    .sort((a, b) => a.openTime - b.openTime)

  for (let i = 1; i < closed.length; i++) {
    if (closed[i].openTime <= closed[i - 1].openTime) {
      throw new Error('Binance returned duplicate or unsorted candles')
    }
  }

  return closed
}
