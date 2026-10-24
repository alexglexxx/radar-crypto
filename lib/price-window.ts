// Summarises the recent price window shown under the score. Bars are scaled
// per asset, so the absolute change and range are what make assets comparable.
export function priceWindowSummary(values: number[]) {
  const prices = values.filter(value => Number.isFinite(value) && value > 0)
  if (prices.length < 2) return null
  const first = prices[0]
  const last = prices[prices.length - 1]
  return {
    count: prices.length,
    changePct: ((last - first) / first) * 100,
    min: Math.min(...prices),
    max: Math.max(...prices),
  }
}

export function fmtPct(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value).toFixed(2)} %`
}
