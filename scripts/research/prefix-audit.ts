import { calculateFeatures, type Candle as FeatureCandle } from '../../lib/features'
import { replayLiveSignal } from '../../lib/live-window'
import { calculateRadarScore } from '../../lib/scoring'
import { BAR_MS, type Candle } from './live-baseline-core'

type Evaluator = (archive: FeatureCandle[], asOf: number) => unknown

export function prefixDifferences(archive: FeatureCandle[], positions: number[], evaluate: Evaluator = replayLiveSignal) {
  const differences: number[] = []
  for (const i of positions) {
    const asOf = archive[i].openTime + BAR_MS + 1000
    const complete = evaluate(archive, asOf)
    const prefix = evaluate(archive.slice(0, i + 2), asOf) // Includes the currently open row.
    if (JSON.stringify(complete) !== JSON.stringify(prefix)) differences.push(i)
  }
  return differences
}

export function auditPrefix(symbol: string, series: Candle[], signalIndices: number[], windowBars: number) {
  const archive: FeatureCandle[] = series.map(c => ({ openTime: c.time - BAR_MS + 1,
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
  const positions = [...new Set([
    ...Array.from({ length: windowBars }, (_, i) => i).filter(i => i >= 250 && i % 16 === 0),
    ...signalIndices.filter(i => i >= 250 && i < windowBars),
  ])].sort((a, b) => a - b)
  if (!positions.length) throw new Error(`${symbol}: no prefix checkpoints`)
  const differences = prefixDifferences(archive, positions)
  if (differences.length) throw new Error(`${symbol}: ${differences.length} future-dependent checkpoints`)
  const leaky = prefixDifferences(archive, positions.slice(0, 3), (candles, asOf) => ({
    result: replayLiveSignal(candles, asOf), future: candles.at(-1)?.close,
  }))
  if (!leaky.length) throw new Error(`${symbol}: positive leakage control was not detected`)
  let featureDrift = 0, scoreDrift = 0, decisionDrift = 0
  for (const i of positions) {
    const asOf = archive[i].openTime + BAR_MS + 1000
    const live = replayLiveSignal(archive, asOf)
    if (!live) throw new Error(`${symbol}: no live replay at checkpoint ${i}`)
    const growingFeatures = calculateFeatures(archive.slice(0, i + 1))
    const growingScore = calculateRadarScore(growingFeatures)
    if (JSON.stringify(growingFeatures) !== JSON.stringify(live.features)) featureDrift++
    if (growingScore.score !== live.score) scoreDrift++
    if ((growingScore.status === 'SETUP LONG') !== (live.decision === 'LONG')) decisionDrift++
  }
  return { symbol, checkpoints: positions.length, first: new Date(series[positions[0]].time).toISOString(),
    last: new Date(series[positions.at(-1)!].time).toISOString(), future_dependent: 0,
    positive_control_detected: true, growing_history_feature_drift: featureDrift,
    growing_history_score_drift: scoreDrift, growing_history_decision_drift: decisionDrift }
}
