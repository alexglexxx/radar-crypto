import { describe, expect, it } from 'vitest'
import { signalHealth } from '../lib/system-status'

describe('dashboard freshness', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  it('separates missing, invalid, stale and current source timestamps', () => {
    expect(signalHealth(null, now)).toBe('SIN DATOS')
    expect(signalHealth('invalid', now)).toBe('FECHA INVÁLIDA')
    expect(signalHealth(new Date(now + 60_000).toISOString(), now)).toBe('FECHA INVÁLIDA')
    expect(signalHealth(new Date(now - 21 * 60_000).toISOString(), now)).toBe('ATRASADO')
    expect(signalHealth(new Date(now - 15 * 60_000).toISOString(), now)).toBe('AL DÍA')
  })
})
