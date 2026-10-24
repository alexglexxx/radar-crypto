export const RADAR_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const

export function signalHealth(timestamp: string | null | undefined, now = Date.now()) {
  if (!timestamp) return 'SIN DATOS'
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time) || time > now + 1000) return 'FECHA INVÁLIDA'
  return now - time > 20 * 60 * 1000 ? 'ATRASADO' : 'AL DÍA'
}

export type JobHealthRow = {
  job: string
  last_run_at: string | null
  last_ok: boolean | null
  last_ok_at: string | null
  failures_24h: number | null
}

// Ingestion runs every 15 minutes.
export const JOB_MAX_AGE_MS: Record<string, number> = {
  ingest: 20 * 60 * 1000,
}

// A stopped scheduler (stale last run) is reported before a failing job.
export function jobHealth(row: JobHealthRow | null | undefined, now = Date.now()) {
  if (!row?.last_run_at) return 'SIN REGISTRO'
  const time = Date.parse(row.last_run_at)
  if (!Number.isFinite(time) || time > now + 1000) return 'FECHA INVÁLIDA'
  if (now - time > (JOB_MAX_AGE_MS[row.job] ?? JOB_MAX_AGE_MS.ingest)) return 'ATRASADO'
  return row.last_ok ? 'AL DÍA' : 'FALLANDO'
}
