import { describe, expect, it } from 'vitest'
import { jobHealth, signalHealth } from '../lib/system-status'

describe('dashboard freshness', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  it('separates missing, invalid, stale and current source timestamps', () => {
    expect(signalHealth(null, now)).toBe('SIN DATOS')
    expect(signalHealth('invalid', now)).toBe('FECHA INVÁLIDA')
    expect(signalHealth(new Date(now + 60_000).toISOString(), now)).toBe('FECHA INVÁLIDA')
    expect(signalHealth(new Date(now - 21 * 60_000).toISOString(), now)).toBe('ATRASADO')
    expect(signalHealth(new Date(now - 15 * 60_000).toISOString(), now)).toBe('AL DÍA')
  })

  it('classifies scheduled jobs by their own cadence, stale before failing', () => {
    const ago = (ms: number) => new Date(now - ms).toISOString()
    const row = (job: string, lastRun: string, ok: boolean) =>
      ({ job, last_run_at: lastRun, last_ok: ok, last_ok_at: ok ? lastRun : null, failures_24h: ok ? 0 : 1 })
    expect(jobHealth(null, now)).toBe('SIN REGISTRO')
    expect(jobHealth(row('ingest', 'invalid', true), now)).toBe('FECHA INVÁLIDA')
    expect(jobHealth(row('ingest', ago(10 * 60_000), true), now)).toBe('AL DÍA')
    expect(jobHealth(row('ingest', ago(10 * 60_000), false), now)).toBe('FALLANDO')
    expect(jobHealth(row('ingest', ago(21 * 60_000), false), now)).toBe('ATRASADO')
    expect(jobHealth(row('daily-news', ago(20 * 3_600_000), true), now)).toBe('AL DÍA')
    expect(jobHealth(row('daily-news', ago(27 * 3_600_000), true), now)).toBe('ATRASADO')
  })
})
