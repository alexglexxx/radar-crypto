import { type Candle } from '../../lib/features'
import { BAR_MS, LIVE_HISTORY_LIMIT, candleCloseTime, replayLiveSignal } from '../../lib/live-window'
import { type Candidate } from './evaluation-gate'

// The live request returns 249 closed candles plus the open one. The open
// row only reserves a slot and its OHLC is never read, so a placeholder
// reproduces the live window without reading anything after archive[index].
export function liveWindowDecision(archive: Candle[], index: number) {
  const closed = archive.slice(Math.max(0, index - (LIVE_HISTORY_LIMIT - 2)), index + 1)
  const current = archive[index]
  const openRow = { ...current, openTime: current.openTime + BAR_MS, volume: 0 }
  const replay = replayLiveSignal([...closed, openRow], current.openTime + BAR_MS + 1000)
  if (!replay || replay.signalTimestamp !== candleCloseTime(current) || replay.sampleSize !== LIVE_HISTORY_LIMIT - 1) return null
  return replay
}

// Deterministic pseudo-random draw from data already known at index.
function draw(archive: Candle[], index: number) {
  let x = (Math.floor(archive[index].openTime / BAR_MS) ^ Math.round(archive[0].open * 1e4)) >>> 0
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  return (x >>> 0) / 0x100000000
}

// Upper volatility tercile of every eligible candle, 4 assets pooled,
// 2023-10..2026-09: the cut of the descriptive split in historical-baseline.ts,
// frozen here. It was read from the same months the gate runs on.
export const HIGH_VOLATILITY_CUT = 0.0144746

export const CANDIDATES: Record<string, Candidate> = {
  'v1.2-trend-vol': {
    id: 'v1.2-trend-vol',
    kind: 'strategy',
    hypothesis: 'Las señales LONG de v1.1-live solo cuando EMA50 > EMA200 y la volatilidad de 20 velas está en el tercil alto ' +
      `(≥ ${HIGH_VOLATILITY_CUT}) le ganan al azar. Se declara 4h porque ahí se vieron ambos cortes. ` +
      'Los dos cortes y el umbral salieron de mirar estos 36 meses: pasar aquí es necesario pero no suficiente.',
    horizon: '4h',
    decide: (archive, index) => {
      const replay = liveWindowDecision(archive, index)
      if (replay?.decision !== 'LONG') return false
      const { ema_50, ema_200, volatility } = replay.features
      return ema_50 != null && ema_200 != null && volatility != null &&
        ema_50 > ema_200 && volatility >= HIGH_VOLATILITY_CUT
    },
  },
  'v1.1-live': {
    id: 'v1.1-live',
    kind: 'strategy',
    hypothesis: 'El radar en producción (score ≥ 75, ventana live de 249 velas) anticipa subidas mejor que entrar al azar. ' +
      'Se declara 4h porque fue el horizonte menos malo en análisis previos: un rechazo ahí es el más fuerte.',
    horizon: '4h',
    decide: (archive, index) => liveWindowDecision(archive, index)?.decision === 'LONG',
  },
  'control-random': {
    id: 'control-random',
    kind: 'control',
    hypothesis: 'Control nulo: compra al azar en ~12 % de las velas, la misma frecuencia que v1.1-live. El gate debe rechazarlo.',
    horizon: '4h',
    decide: (archive, index) => draw(archive, index) < 0.12,
  },
  'control-lookahead': {
    id: 'control-lookahead',
    kind: 'control',
    hypothesis: 'Control de trampa: compra solo si el precio de salida a 4h ya se sabe mayor que el de entrada (mira el futuro). ' +
      'Parece perfecto; el gate debe detectarlo y rechazarlo.',
    horizon: '4h',
    decide: (archive, index) => archive[index + 17].open > archive[index + 1].open,
  },
}
