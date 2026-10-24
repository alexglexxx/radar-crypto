import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertFundingContinuity, fundingIndexAt, loadArchivedFunding, parseFundingCsv, type FundingPoint } from '../scripts/research/funding-archive'

const H = 3600000
const T0 = Date.UTC(2024, 0, 1)
const pt = (hours: number, intervalHours = 8): FundingPoint => ({ calcTime: T0 + hours * H, intervalHours, rate: 0.0001 })

afterEach(() => { vi.unstubAllGlobals() })

// A one-file zip without compression, enough for `unzip -p`.
function storedZip(name: string, text: string): Buffer {
  const data = Buffer.from(text), file = Buffer.from(name), crc = zlib.crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + file.length, 12); end.writeUInt32LE(local.length + file.length + data.length, 16)
  return Buffer.concat([local, file, data, central, file, end])
}

describe('funding archive', () => {
  it('parses with and without header', () => {
    const body = '1704067200000,8,0.00037409\n1704096000000,8,0.00027213'
    const withHeader = parseFundingCsv(`calc_time,funding_interval_hours,last_funding_rate\n${body}\n`, 'x')
    expect(withHeader).toEqual(parseFundingCsv(body, 'x'))
    expect(withHeader[0]).toEqual({ calcTime: 1704067200000, intervalHours: 8, rate: 0.00037409 })
  })

  it('rejects an unparseable row', () => {
    expect(() => parseFundingCsv('calc_time,funding_interval_hours,last_funding_rate\n1704067200000,8,abc', 'x'))
      .toThrow(/unparseable funding row 2/)
  })

  it('reports gaps with count and first date', () => {
    const points = [pt(0), pt(8), pt(32), pt(40), pt(64), pt(72)]
    expect(() => assertFundingContinuity(points, 'BTCUSDT')).toThrow(/2 funding gaps, first after 2024-01-01T08:00/)
  })

  it('accepts a switch from 8h to 4h settlements', () => {
    expect(() => assertFundingContinuity([pt(0, 8), pt(8, 8), pt(16, 4), pt(20, 4), pt(24, 4)], 'X')).not.toThrow()
    expect(() => assertFundingContinuity([pt(0, 4), pt(4, 4), pt(11, 4)], 'X')).toThrow(/funding gap/)
  })

  it('rejects unsorted or duplicate settlements', () => {
    expect(() => assertFundingContinuity([pt(8), pt(0)], 'X')).toThrow(/unsorted or duplicate/)
    expect(() => assertFundingContinuity([pt(0), pt(0)], 'X')).toThrow(/unsorted or duplicate/)
  })

  it('accepts a series that starts mid-month with millisecond jitter', () => {
    const start = 1600012800004
    const points = [0, 1, 2, 3].map(i => ({ calcTime: start + i * 8 * H, intervalHours: 8, rate: 0 }))
    expect(() => assertFundingContinuity(points, 'SOLUSDT')).not.toThrow()
  })

  it('never returns a settlement after t', () => {
    const points = Array.from({ length: 10 }, (_, i) => pt(i * 8))
    for (let t = T0 - H; t <= T0 + 72 * H; t += 15 * 60000) {
      const idx = fundingIndexAt(points, t)
      expect(idx === -1 || points[idx].calcTime <= t).toBe(true)
      expect(idx + 1 >= points.length || points[idx + 1].calcTime > t).toBe(true)
    }
  })

  it('does not see a 00:00:00.004 settlement at the 00:00 decision', () => {
    const points = [1600012800004, 1600012800004 + 8 * H].map(calcTime => ({ calcTime, intervalHours: 8, rate: 0 }))
    expect(fundingIndexAt(points, 1600012800000)).toBe(-1)
  })

  it('refuses a window without any settlement', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'funding-'))
    vi.stubGlobal('fetch', async () => { throw new Error('no network in tests') })
    try {
      // The month file exists but its only settlement is before the window.
      const csv = `calc_time,funding_interval_hours,last_funding_rate\n${Date.UTC(2023, 11, 31)},8,0.0001\n`
      await fs.writeFile(path.join(tmp, 'SOLUSDT-fundingRate-2024-01.zip'), storedZip('SOLUSDT-fundingRate-2024-01.csv', csv))
      await expect(loadArchivedFunding('SOLUSDT', Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1) - 1, { cacheDir: tmp }))
        .rejects.toThrow(/SOLUSDT: no funding settlement from 2024-01-01/)
      const inside = `${Date.UTC(2024, 0, 1, 8)},8,0.0001\n${Date.UTC(2024, 0, 1, 16)},8,0.0002\n`
      await fs.writeFile(path.join(tmp, 'SOLUSDT-fundingRate-2024-01.zip'), storedZip('SOLUSDT-fundingRate-2024-01.csv', inside))
      const { points } = await loadArchivedFunding('SOLUSDT', Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1) - 1, { cacheDir: tmp })
      expect(points.map(p => p.rate)).toEqual([0.0001, 0.0002])
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('refuses a missing month', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'funding-'))
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    try {
      await expect(loadArchivedFunding('BTCUSDT', Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1) - 1, { cacheDir: tmp }))
        .rejects.toThrow(/unavailable/)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
