export const RADAR_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const

export function signalHealth(timestamp: string | null | undefined, now = Date.now()) {
  if (!timestamp) return 'SIN DATOS'
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time) || time > now + 1000) return 'FECHA INVÁLIDA'
  return now - time > 20 * 60 * 1000 ? 'ATRASADO' : 'AL DÍA'
}
