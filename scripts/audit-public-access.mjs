#!/usr/bin/env node
// Read-only PostgREST smoke test. Never prints a key or research row.
import { readFileSync } from 'node:fs'

function localEnv() {
  try {
    const lines = readFileSync('.env.local', 'utf8').split(/\r?\n/)
    return Object.fromEntries(lines.filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
      const equal = line.indexOf('=')
      return [line.slice(0, equal), line.slice(equal + 1).trim().replace(/^['"]|['"]$/g, '')]
    }))
  } catch {
    return {}
  }
}

function keyRole(key) {
  if (key.startsWith('sb_publishable_')) return 'anon'
  try {
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role
  } catch {
    return 'unknown'
  }
}

const config = { ...localEnv(), ...process.env }
const base = (config.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '')
const key = config.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
if (!base || keyRole(key) !== 'anon') {
  throw new Error('Set a publishable/anon key in NEXT_PUBLIC_SUPABASE_ANON_KEY; privileged keys are refused')
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }
const cases = [
  ['market_snapshots', 'id'],
  ['features', 'id'],
  ['radar_signals', 'symbol'], // A permitted column exposed this table before the fix.
  ['signal_outcomes', 'id'],
  // Legacy production objects created outside the migrations (audit 2026-10-23).
  ['signals', 'id'],
  ['radar_public_metrics', 'signal_id'],
  ['public_current_signals', 'symbol'],
  ['public_signal_history', 'symbol'],
]
let failures = 0
for (const [table, column] of cases) {
  const response = await fetch(`${base}/rest/v1/${table}?select=${column}&limit=1`, {
    method: 'HEAD', headers, signal: AbortSignal.timeout(10000),
  })
  const denied = response.status === 401 || response.status === 403
  console.log(`${table}: HTTP ${response.status}${denied ? ' denied' : ' ACCESSIBLE'}`)
  if (process.argv.includes('--expect-locked') && !denied) failures++
}

const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']
for (const symbol of symbols) {
  const query = new URLSearchParams({ select: 'symbol', symbol: `eq.${symbol}`,
    model_version: 'eq.v1.1-live', timeframe: 'eq.15m', order: 'signal_timestamp.desc', limit: '1' })
  const response = await fetch(`${base}/rest/v1/current_signals_public?${query}`, {
    headers, signal: AbortSignal.timeout(10000),
  })
  const rows = response.ok ? await response.json() : []
  const okay = response.ok && rows.length === 1 && rows[0].symbol === symbol
  console.log(`current_signals_public ${symbol}: HTTP ${response.status}${okay ? ' visible' : ' FAILED'}`)
  if (!okay) failures++
}

if (failures) {
  console.error(`Access audit failed: ${failures} checks`)
  process.exitCode = 1
}
