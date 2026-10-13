import { cached, productionScores, type Context, type SymbolContext } from './context'
import { rollingMaxPrev, rollingStd, smaSeries } from './indicators'
import { barsPerDay, type EntryPlan, type FundingPoint, type ParamSet, type Timeframe } from './types'

type Base = {
  id: string
  /** 0 = reference (unchanged production score), 1..8 = idea number from the research proposal. */
  idea: number
  title: string
  hypothesis: string
  timeframe: Timeframe
  grid: ParamSet[]
  /** Minimum pooled training trades required to trust a parameter set. */
  minTrainTrades: number
  needsFunding?: boolean
}

export type EventStrategy = Base & {
  kind: 'events'
  plan(ctx: Context, symbolIndex: number, params: ParamSet): EntryPlan
}

export type RotationStrategy = Base & {
  kind: 'rotation'
  /** targets[i] = symbol index to hold after the close of bar i, or -1 for cash. */
  targets(ctx: Context, params: ParamSet): number[]
}

export type Strategy = EventStrategy | RotationStrategy

const num = (p: ParamSet, key: string): number => Number(p[key])
const str = (p: ParamSet, key: string): string => String(p[key])

export function product(dims: Record<string, (number | string)[]>): ParamSet[] {
  let out: ParamSet[] = [{}]
  for (const [key, values] of Object.entries(dims)) {
    out = out.flatMap(base => values.map(value => ({ ...base, [key]: value })))
  }
  return out
}

function gate(sc: SymbolContext, regime: string): boolean[] {
  return regime === 'trend_calm' ? sc.trendCalm : sc.trend
}

function marketLeaderIndex(ctx: Context): number {
  const btc = ctx.symbols.findIndex(s => s.symbol === 'BTCUSDT')
  return btc >= 0 ? btc : 0
}

// ---------------------------------------------------------------------------
// Funding helpers (idea 6)
// ---------------------------------------------------------------------------

/** Percentile rank of each funding point among up to the previous 270 observations (~90 days). */
export function fundingPercentiles(points: FundingPoint[], window = 270, minHistory = 90): (number | null)[] {
  return points.map((point, k) => {
    if (k < minHistory) return null
    const start = Math.max(0, k - window)
    let notAbove = 0
    for (let j = start; j < k; j++) if (points[j].rate <= point.rate) notAbove++
    return notAbove / (k - start)
  })
}

/** For each bar, the percentile of the latest funding observation published at or before the bar OPEN. */
export function fundingPctByBar(ctx: Context, symbolIndex: number): (number | null)[] {
  return cached(ctx, 'fundingPct:' + ctx.symbols[symbolIndex].symbol, () => {
    const sc = ctx.symbols[symbolIndex]
    const points = ctx.data.funding?.[sc.symbol]
    if (!points || !points.length) return sc.candles.map(() => null)
    const pct = fundingPercentiles(points)
    const out: (number | null)[] = []
    let k = -1
    for (const candle of sc.candles) {
      while (k + 1 < points.length && points[k + 1].time <= candle.openTime) k++
      out.push(k >= 0 ? pct[k] : null)
    }
    return out
  })
}

// ---------------------------------------------------------------------------
// Donchian breakout (ideas 3, 2+3, 5, 6)
// ---------------------------------------------------------------------------

const MAX_HOLD_DAYS = 90

function breakoutEntries(ctx: Context, symbolIndex: number, days: number, minVol: number): boolean[] {
  const sc = ctx.symbols[symbolIndex]
  const bars = Math.max(2, Math.round(days * barsPerDay(ctx.data.timeframe)))
  const channel = cached(ctx, `maxPrev:${sc.symbol}:${bars}`, () => rollingMaxPrev(sc.high, bars))
  return sc.close.map((price, i) => {
    const top = channel[i]
    if (top === null || !(price > top)) return false
    return minVol <= 0 || (sc.volRatio[i] ?? 0) >= minVol
  })
}

function trailExit(ctx: Context, symbolIndex: number, trailMult: number): EntryPlan['exit'] {
  return {
    maxBars: Math.round(MAX_HOLD_DAYS * barsPerDay(ctx.data.timeframe)),
    atr: ctx.symbols[symbolIndex].atr14,
    trailAtrMult: trailMult,
  }
}

function donchianPlan(
  ctx: Context,
  symbolIndex: number,
  p: ParamSet,
  allow: (i: number) => boolean,
): EntryPlan {
  const base = breakoutEntries(ctx, symbolIndex, num(p, 'days'), p.vol === undefined ? 0 : num(p, 'vol'))
  return { entries: base.map((hit, i) => hit && allow(i)), exit: trailExit(ctx, symbolIndex, num(p, 'stop')) }
}

function donchianStrategies(timeframe: Timeframe): Strategy[] {
  const tf = timeframe
  return [
    {
      kind: 'events',
      id: `s3_donchian_${tf}`,
      idea: 3,
      title: `Ruptura de rango (Donchian) con volumen y stop por ATR — ${tf}`,
      hypothesis:
        'Comprar cuando el cierre supera el máximo de los últimos N días (con volumen alto) y dejar correr la ganancia con un stop que sube.',
      timeframe,
      grid: product({ days: [5, 10, 20], vol: [0, 1.3], stop: [2, 3, 4] }),
      minTrainTrades: 30,
      plan: (ctx, i, p) => donchianPlan(ctx, i, p, () => true),
    },
    {
      kind: 'events',
      id: `s3r_donchian_regime_${tf}`,
      idea: 2,
      title: `Donchian + filtro de régimen (solo en tendencia) — ${tf}`,
      hypothesis: 'La misma ruptura, pero solo si el mercado ya está en tendencia alcista (y sin picos de volatilidad en la variante calm).',
      timeframe,
      grid: product({ days: [5, 10, 20], vol: [0, 1.3], stop: [2, 3, 4], regime: ['trend', 'trend_calm'] }),
      minTrainTrades: 30,
      plan: (ctx, i, p) => {
        const allowed = gate(ctx.symbols[i], str(p, 'regime'))
        return donchianPlan(ctx, i, p, k => allowed[k])
      },
    },
    {
      kind: 'events',
      id: `s5_donchian_btc_tide_${tf}`,
      idea: 5,
      title: `Donchian + marea de BTC (alts solo si BTC está en tendencia) — ${tf}`,
      hypothesis: 'Las alts casi siempre siguen a BTC: solo se permiten compras cuando BTC también está en tendencia alcista.',
      timeframe,
      grid: product({ days: [5, 10, 20], vol: [0, 1.3], stop: [2, 3, 4] }),
      minTrainTrades: 30,
      plan: (ctx, i, p) => {
        const own = ctx.symbols[i].trend
        const leader = ctx.symbols[marketLeaderIndex(ctx)].trend
        return donchianPlan(ctx, i, p, k => own[k] && leader[k])
      },
    },
    {
      kind: 'events',
      id: `s6_donchian_funding_${tf}`,
      idea: 6,
      title: `Donchian + funding (evitar mercado sobrecargado a la compra) — ${tf}`,
      hypothesis: 'Un funding en su percentil alto indica demasiados apostando al alza; en ese caso la ruptura se ignora.',
      timeframe,
      needsFunding: true,
      grid: product({ days: [5, 10, 20], stop: [2, 3, 4], fundingMax: [0.8, 0.9] }),
      minTrainTrades: 30,
      plan: (ctx, i, p) => {
        const own = ctx.symbols[i].trend
        const pct = fundingPctByBar(ctx, i)
        const max = num(p, 'fundingMax')
        return donchianPlan(ctx, i, p, k => own[k] && pct[k] !== null && (pct[k] as number) < max)
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Production score based studies (ideas 1, 2, 8) — 15m, scoring code untouched
// ---------------------------------------------------------------------------

function scoreEntries(ctx: Context, symbolIndex: number, threshold: number, allow: (i: number) => boolean): boolean[] {
  const scores = productionScores(ctx, symbolIndex)
  return scores.map((score, i) => i >= 200 && score >= threshold && allow(i))
}

const scoreStrategies: Strategy[] = [
  {
    kind: 'events',
    id: 's0_baseline_score_15m',
    idea: 0,
    title: 'Referencia: score de producción sin cambios (SETUP LONG ≥ 75, salida a 4 h)',
    hypothesis: 'Punto de comparación. Es lo que hace hoy el radar, medido con el mismo marco que las ideas nuevas.',
    timeframe: '15m',
    grid: [{ threshold: 75, hold: 16 }],
    minTrainTrades: 0,
    plan: (ctx, i, p) => ({
      entries: scoreEntries(ctx, i, num(p, 'threshold'), () => true),
      exit: { maxBars: num(p, 'hold'), atr: ctx.symbols[i].atr14 },
    }),
  },
  {
    kind: 'events',
    id: 's1_score_horizon_15m',
    idea: 1,
    title: 'Mismo score, mantener la posición más tiempo (4 h a 48 h)',
    hypothesis: 'Con costos fijos por operación, un movimiento más largo diluye el costo: la ventaja (si existe) debería crecer con el plazo.',
    timeframe: '15m',
    grid: product({ threshold: [70, 75, 80, 85], hold: [16, 48, 96, 192] }),
    minTrainTrades: 100,
    plan: (ctx, i, p) => ({
      entries: scoreEntries(ctx, i, num(p, 'threshold'), () => true),
      exit: { maxBars: num(p, 'hold'), atr: ctx.symbols[i].atr14 },
    }),
  },
  {
    kind: 'events',
    id: 's2_score_regime_15m',
    idea: 2,
    title: 'Mismo score, solo cuando el mercado está en tendencia',
    hypothesis: 'Filtrar los momentos de lateralidad o volatilidad extrema elimina muchas malas operaciones.',
    timeframe: '15m',
    grid: product({ threshold: [70, 75, 80], hold: [16, 48, 96], regime: ['trend', 'trend_calm'] }),
    minTrainTrades: 100,
    plan: (ctx, i, p) => {
      const allowed = gate(ctx.symbols[i], str(p, 'regime'))
      return {
        entries: scoreEntries(ctx, i, num(p, 'threshold'), k => allowed[k]),
        exit: { maxBars: num(p, 'hold'), atr: ctx.symbols[i].atr14 },
      }
    },
  },
  {
    kind: 'events',
    id: 's8_score_exits_15m',
    idea: 8,
    title: 'Mismo score, salidas definidas (stop, objetivo o stop que sube)',
    hypothesis: 'Hoy no hay stop ni objetivo; definir cuándo salir puede cambiar los resultados más que mejorar la entrada.',
    timeframe: '15m',
    grid: [
      ...[75, 80].flatMap(threshold => [
        { threshold, exit: 'fixed', hold: 16 },
        ...[2, 3, 4].map(trail => ({ threshold, exit: 'trail', trail, hold: 192 })),
        ...[
          [1.5, 3],
          [2, 4],
        ].map(([stop, target]) => ({ threshold, exit: 'stop_target', stop, target, hold: 192 })),
      ]),
    ],
    minTrainTrades: 100,
    plan: (ctx, i, p) => {
      const atr = ctx.symbols[i].atr14
      const entries = scoreEntries(ctx, i, num(p, 'threshold'), () => true)
      const kind = str(p, 'exit')
      if (kind === 'trail') return { entries, exit: { maxBars: num(p, 'hold'), atr, trailAtrMult: num(p, 'trail') } }
      if (kind === 'stop_target') {
        return { entries, exit: { maxBars: num(p, 'hold'), atr, stopAtrMult: num(p, 'stop'), targetAtrMult: num(p, 'target') } }
      }
      return { entries, exit: { maxBars: num(p, 'hold'), atr } }
    },
  },
]

// ---------------------------------------------------------------------------
// Mean reversion in sideways markets (idea 7)
// ---------------------------------------------------------------------------

function meanReversionStrategy(timeframe: Timeframe): Strategy {
  return {
    kind: 'events',
    id: `s7_meanrev_sideways_${timeframe}`,
    idea: 7,
    title: `Reversión a la media solo en mercado lateral — ${timeframe}`,
    hypothesis: 'En un mercado sin tendencia, una caída exagerada (z-score) tiende a regresar a su promedio de 20 velas.',
    timeframe,
    grid: product({ z: [2, 2.5], maxDays: [0.5, 1, 2], stop: [2, 3], band: [0.02, 0.04] }),
    minTrainTrades: 30,
    plan: (ctx, i, p) => {
      const sc = ctx.symbols[i]
      const perDay = barsPerDay(ctx.data.timeframe)
      const mean = cached(ctx, `sma20:${sc.symbol}`, () => smaSeries(sc.close, 20))
      const std = cached(ctx, `std20:${sc.symbol}`, () => rollingStd(sc.close, 20))
      const k = num(p, 'z')
      const band = num(p, 'band')
      const entries = sc.close.map((price, idx) => {
        const m = mean[idx]
        const s = std[idx]
        const fast = sc.emaFast[idx]
        const slow = sc.emaSlow[idx]
        if (m === null || s === null || s <= 0 || fast === null || slow === null) return false
        const sideways = Math.abs(fast / slow - 1) <= band
        return sideways && (price - m) / s <= -k
      })
      return {
        entries,
        exit: {
          maxBars: Math.max(2, Math.round(num(p, 'maxDays') * perDay)),
          atr: sc.atr14,
          stopAtrMult: num(p, 'stop'),
          exitAtOrAbove: mean,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Relative strength rotation across the universe (idea 4)
// ---------------------------------------------------------------------------

function rotationStrategy(timeframe: Timeframe): Strategy {
  return {
    kind: 'rotation',
    id: `s4_relative_strength_${timeframe}`,
    idea: 4,
    title: `Fuerza relativa: tener solo la moneda más fuerte — ${timeframe}`,
    hypothesis: 'Quien más sube en 30–90 días tiende a seguir liderando; si ninguna sube, quedarse en efectivo.',
    timeframe,
    grid: product({ lookbackDays: [30, 60, 90], rebalanceDays: [1, 3, 7], absolute: [0, 1] }),
    minTrainTrades: 15,
    targets: (ctx, p) => {
      const perDay = barsPerDay(ctx.data.timeframe)
      const lookback = Math.round(num(p, 'lookbackDays') * perDay)
      const every = Math.max(1, Math.round(num(p, 'rebalanceDays') * perDay))
      const requirePositive = num(p, 'absolute') === 1
      const n = ctx.symbols[0].close.length
      const out: number[] = Array(n).fill(-1)
      let held = -1
      for (let i = 0; i < n; i++) {
        if (i >= lookback && i % every === 0) {
          let best = -1
          let bestReturn = -Infinity
          ctx.symbols.forEach((sc, idx) => {
            const ret = sc.close[i] / sc.close[i - lookback] - 1
            if (ret > bestReturn) {
              bestReturn = ret
              best = idx
            }
          })
          held = requirePositive && bestReturn <= 0 ? -1 : best
        }
        out[i] = held
      }
      return out
    },
  }
}

export function buildStrategies(): Strategy[] {
  return [
    ...scoreStrategies,
    ...donchianStrategies('1h'),
    ...donchianStrategies('4h'),
    meanReversionStrategy('1h'),
    meanReversionStrategy('4h'),
    rotationStrategy('4h'),
  ]
}
