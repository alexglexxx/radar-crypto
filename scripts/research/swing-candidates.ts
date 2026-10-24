import { BAR_MS } from './live-baseline-core'
import { simulateTrade, type SwingCandidate } from './swing-gate'

// Deterministic pseudo-random draw from the candle's open time and the symbol:
// identical in the full and in the windowed context.
function draw(openTime: number, symbol: string) {
  let h = 0x811c9dc5
  for (let k = 0; k < symbol.length; k++) h = Math.imul(h ^ symbol.charCodeAt(k), 0x01000193)
  let x = (Math.floor(openTime / BAR_MS) ^ h) >>> 0
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  return ((x ^ (x >>> 16)) >>> 0) / 0x100000000
}

export const SWING_CANDIDATES: Record<string, SwingCandidate> = {
  'swing-random': {
    id: 'swing-random',
    kind: 'control',
    hypothesis: 'Control nulo: compra al azar en ~15 % de los momentos de decisión (sorteo fijo por hora y moneda). ' +
      'El gate debe rechazarlo en "Le gana al azar" y aprobar "No mira el futuro".',
    decide: (ctx, symbol, index) => draw(ctx.candles.get(symbol)![index].openTime, symbol) < 0.15,
  },
  'swing-lookahead': {
    id: 'swing-lookahead',
    kind: 'control',
    hypothesis: 'Control de futuro: compra solo si la operación va a tocar el TP antes que el SL, leyendo las velas siguientes. ' +
      'Parece perfecto; el gate debe rechazarlo en "No mira el futuro".',
    decide: (ctx, symbol, index) => simulateTrade(ctx.candles.get(symbol)!, index)?.reason === 'tp',
  },
  'swing-btc-lookahead': {
    id: 'swing-btc-lookahead',
    kind: 'control',
    hypothesis: 'Control de futuro entre monedas: compra cualquier moneda si BTC cierra más alto 24 h después. ' +
      'El gate debe rechazarlo en "No mira el futuro".',
    decide: (ctx, _symbol, index) => {
      const btc = ctx.candles.get('BTCUSDT')!
      return btc[index + 96].close > btc[index].close
    },
  },
}
