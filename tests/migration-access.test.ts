import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite, type PGliteInterface } from '@electric-sql/pglite'
import { afterAll, describe, expect, it } from 'vitest'

// Isolated replay of the Supabase access model. No network or production database.
const MIGRATIONS = 'supabase/migrations'
const LOCKDOWN = '20261021200000_lock_down_research_access.sql'
const ROLLBACK = 'supabase/rollback/20261021200000_lock_down_research_access.down.sql'
const PUBLIC_ROLES = ['anon', 'authenticated'] as const
const DASHBOARD_COLUMNS = ['symbol', 'signal_score', 'decision', 'regime', 'entry_price', 'created_at',
  'signal_timestamp', 'timeframe', 'model_version', 'sample_size', 'rationale']

// Supabase roles and the default privileges read from production pg_default_acl.
const SUPABASE_BOOTSTRAP = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

// Production state read on 2026-10-23 that no repository migration produces.
const PRODUCTION_DRIFT = `
  drop policy "public read radar signals" on public.radar_signals;
  drop policy "public read market snapshots" on public.market_snapshots;
  drop policy "public read features" on public.features;
  drop policy "public read signal outcomes" on public.signal_outcomes;

  create table public.signals (id bigint generated always as identity primary key,
    created_at timestamptz default now(), symbol text, price numeric, score numeric,
    change_24h numeric, volume numeric, status text);
  alter table public.signals enable row level security;
  create policy "Allow all" on public.signals for all to public using (true) with check (true);

  create table public.radar_public_metrics (signal_id bigint, symbol text, rsi_14 numeric,
    macd_histogram numeric, volume_ratio numeric, created_at timestamptz);
  alter table public.radar_public_metrics enable row level security;
  create policy "public read radar public metrics" on public.radar_public_metrics
    for select to anon, authenticated using (true);

  create view public.public_current_signals with (security_invoker = true) as
    select distinct on (s.symbol) s.symbol, s.signal_score, s.decision, s.regime, s.entry_price,
      s.created_at, s.timeframe, s.sample_size, s.model_version, m.rsi_14, m.macd_histogram, m.volume_ratio
    from public.radar_signals s left join public.radar_public_metrics m on m.signal_id = s.id
    where s.timeframe = '15m' and s.model_version = 'v1.1-live'
    order by s.symbol, s.created_at desc;
  create view public.public_signal_history with (security_invoker = true) as
    select symbol, signal_score, decision, regime, entry_price, created_at, timeframe, sample_size, model_version
    from public.radar_signals
    where timeframe = '15m' and model_version = 'v1.1-live'
    order by created_at desc limit 96;
`

const SEED = `
  insert into public.market_snapshots (captured_at, symbol, exchange, timeframe, open, high, low, close, volume, source_timestamp)
    select now() - n * interval '15 minutes', 'BTCUSDT', 'binance', '15m', 1, 1, 1, 1, 1, now() from generate_series(1, 3) n;
  -- One recent production signal, one older than the view window, one from another model.
  insert into public.radar_signals (snapshot_id, symbol, timeframe, regime, signal_score, decision, model_version, created_at)
    select s.id, 'BTCUSDT', '15m', 'NEUTRAL', 50, 'WAIT', seed.v, seed.c
    from (select id, row_number() over (order by id) n from public.market_snapshots) s
    join (values (1, 'v1.1-live', now()), (2, 'v1.1-live', now() - interval '8 days'), (3, 'v1', now())) seed(n, v, c)
      using (n);
  insert into public.signal_outcomes (signal_id, horizon, outcome) select min(id), '15m', 'WIN' from public.radar_signals;
  insert into public.signals (symbol, price) values ('BTCUSDT', 1);
`

const PRIVATE_RELATIONS = ['market_snapshots', 'features', 'radar_signals', 'signal_outcomes',
  'signals', 'radar_public_metrics', 'public_current_signals', 'public_signal_history']

function sql(file: string) {
  return readFileSync(file, 'utf8')
}

function migrationFiles() {
  return readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort()
}

// Booting PGlite is CPU-heavy; build the replica once and clone it per test.
let replica: Promise<PGlite> | undefined

function buildReplica() {
  replica ??= (async () => {
    const db = new PGlite()
    await db.exec(SUPABASE_BOOTSTRAP)
    // Migrations after the lockdown run after it, in currentReplica().
    for (const file of migrationFiles().filter(name => name < LOCKDOWN)) {
      await db.exec(sql(join(MIGRATIONS, file)))
    }
    await db.exec(PRODUCTION_DRIFT)
    await db.exec(SEED)
    return db
  })()
  return replica
}

async function productionReplica({ lockdown }: { lockdown: boolean }) {
  const db = await (await buildReplica()).clone()
  if (lockdown) await db.exec(sql(join(MIGRATIONS, LOCKDOWN)))
  return db
}

// Production today: the lockdown plus every later migration, in order.
async function currentReplica() {
  const db = await productionReplica({ lockdown: true })
  for (const file of migrationFiles().filter(name => name > LOCKDOWN)) {
    await db.exec(sql(join(MIGRATIONS, file)))
  }
  return db
}

afterAll(async () => {
  await (await replica)?.close()
})

async function asRole<T>(db: PGliteInterface, role: string, query: string) {
  await db.exec(`set role ${role}`)
  try {
    return (await db.query<T>(query)).rows
  } finally {
    await db.exec('reset role')
  }
}

describe('lock down research access migration', () => {
  it('replays the access state observed in production before the lockdown', async () => {
    const db = await productionReplica({ lockdown: false })
    const policies = await db.query<{ p: string }>(
      `select tablename || ':' || policyname as p from pg_policies where schemaname = 'public' order by 1`)
    expect(policies.rows.map(row => row.p)).toEqual([
      'features:deny anon features', 'market_snapshots:deny anon market snapshots',
      'news_briefings:public read news briefings', 'news_items:public read news items',
      'radar_public_metrics:public read radar public metrics', 'radar_signals:public current radar signals',
      'signal_outcomes:deny anon signal outcomes', 'signals:Allow all',
    ])
    // PostgREST HTTP 206 with the publishable key: column grants expose the base table.
    expect(await asRole(db, 'anon', 'select symbol from public.radar_signals')).toHaveLength(1)
    expect(await asRole(db, 'anon', 'select * from public.public_signal_history')).toHaveLength(1)
    await expect(asRole(db, 'anon', 'select id from public.signal_outcomes')).rejects.toThrow(/permission denied/)
    // The legacy table accepts anonymous writes and deletes.
    await asRole(db, 'anon', `insert into public.signals (symbol) values ('ANON')`)
    expect(await asRole(db, 'anon', `delete from public.signals returning id`)).toHaveLength(2)
    await db.close()
  }, 60000)

  it('denies every direct read and write to public roles after the lockdown', async () => {
    const db = await productionReplica({ lockdown: true })
    for (const role of PUBLIC_ROLES) {
      for (const relation of PRIVATE_RELATIONS) {
        await expect(asRole(db, role, `select 1 from public.${relation} limit 1`)).rejects.toThrow(/permission denied/)
      }
      await expect(asRole(db, role, `insert into public.signals (symbol) values ('ANON')`)).rejects.toThrow(/permission denied/)
      await expect(asRole(db, role, 'delete from public.signals')).rejects.toThrow(/permission denied/)
      await expect(asRole(db, role, `update public.current_signals_public set signal_score = 1`)).rejects.toThrow(/permission denied/)
      await expect(asRole(db, role, 'delete from public.current_signals_public')).rejects.toThrow(/permission denied/)
    }
    expect((await db.query('select id from public.signals')).rows).toHaveLength(1)
    await db.close()
  }, 60000)

  it('keeps the dashboard view bounded to the recent production model', async () => {
    const db = await productionReplica({ lockdown: true })
    for (const role of PUBLIC_ROLES) {
      const rows = await asRole<Record<string, unknown>>(db, role,
        `select ${DASHBOARD_COLUMNS.join(', ')} from public.current_signals_public
         where symbol = 'BTCUSDT' and model_version = 'v1.1-live' and timeframe = '15m'
         order by signal_timestamp desc nulls last limit 24`)
      expect(rows).toHaveLength(1)
      expect(Object.keys(rows[0])).toEqual(DASHBOARD_COLUMNS)
      expect(await asRole(db, role, 'select * from public.current_signals_public')).toHaveLength(1)
      expect(await asRole(db, role, 'select 1 from public.current_news_public')).toHaveLength(0)
      expect(await asRole(db, role, 'select 1 from public.current_news_items_public')).toHaveLength(0)
    }
    await db.close()
  }, 60000)

  it('preserves the service-role ingestion and evaluation path', async () => {
    const db = await productionReplica({ lockdown: true })
    await db.exec('set role service_role')
    await db.exec(`
      insert into public.market_snapshots (captured_at, symbol, exchange, timeframe, open, high, low, close, volume)
        values (now(), 'ETHUSDT', 'binance', '15m', 1, 1, 1, 1, 1);
      insert into public.features (snapshot_id, symbol, timeframe, captured_at)
        select id, symbol, timeframe, captured_at from public.market_snapshots where symbol = 'ETHUSDT';
      insert into public.radar_signals (snapshot_id, feature_id, symbol, timeframe, regime, signal_score, decision, model_version)
        select snapshot_id, id, symbol, timeframe, 'NEUTRAL', 60, 'LONG', 'v1.1-live' from public.features;
      insert into public.signal_outcomes (signal_id, horizon, outcome)
        select id, '1h', 'LOSS' from public.radar_signals where symbol = 'ETHUSDT';
      insert into public.news_briefings (briefing_date, title) values (current_date, 'test');
    `)
    expect((await db.query('select 1 from public.signal_outcomes')).rows).toHaveLength(2)
    await db.exec('reset role')
    expect(await asRole(db, 'anon', 'select * from public.current_news_public')).toHaveLength(1)
    await db.close()
  }, 60000)

  it('is idempotent and aborts atomically when an unknown relation is publicly granted', async () => {
    const db = await productionReplica({ lockdown: true })
    await db.exec(sql(join(MIGRATIONS, LOCKDOWN)))
    // Supabase default privileges give every new table full anon grants.
    await db.exec('create table public.unexpected (id int)')
    await expect(db.exec(sql(join(MIGRATIONS, LOCKDOWN)))).rejects.toThrow(/Unexpected .* on public\.unexpected/)
    const fresh = await productionReplica({ lockdown: false })
    await fresh.exec('create table public.unexpected (id int)')
    await expect(fresh.exec(sql(join(MIGRATIONS, LOCKDOWN)))).rejects.toThrow(/Unexpected/)
    // The failed run left the pre-migration state untouched.
    expect(await asRole(fresh, 'anon', 'select symbol from public.radar_signals')).toHaveLength(1)
    await db.close()
    await fresh.close()
  }, 60000)

  it('rolls back only the dashboard path without reopening legacy access', async () => {
    const db = await productionReplica({ lockdown: true })
    await db.exec(sql(ROLLBACK))
    expect(await asRole(db, 'anon', 'select symbol from public.current_signals_public')).toHaveLength(1)
    await expect(asRole(db, 'anon', 'select 1 from public.signals')).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', `insert into public.signals (symbol) values ('ANON')`)).rejects.toThrow(/permission denied/)
    await db.exec(sql(join(MIGRATIONS, LOCKDOWN)))
    await expect(asRole(db, 'anon', 'select symbol from public.radar_signals')).rejects.toThrow(/permission denied/)
    await db.close()
  }, 60000)
})

const JOB_HEALTH = '20261024120000_job_runs_health.sql'
const JOB_HEALTH_ROLLBACK = 'supabase/rollback/20261024120000_job_runs_health.down.sql'
const JOB_HEALTH_COLUMNS = ['job', 'last_run_at', 'last_status', 'last_ok', 'assets_ok', 'assets_total',
  'last_ok_at', 'failures_24h']

describe('job health migration', () => {
  it('keeps run details private and exposes only the bounded health view', async () => {
    const db = await currentReplica()
    await db.exec('set role service_role')
    await db.exec(`
      insert into public.job_runs (job, started_at, finished_at, http_status, ok, assets_ok, assets_total, errors) values
        ('ingest', now() - interval '31 minutes', now() - interval '30 minutes', 200, true, 4, 4, '[]'),
        ('ingest', now() - interval '16 minutes', now() - interval '15 minutes', 503, false, 3, 4,
          '[{"symbol":"SOLUSDT","error":"internal detail"}]'),
        ('ingest', now() - interval '2 days', now() - interval '2 days', 500, false, null, null, '[]'),
        ('daily-news', now() - interval '3 hours', now() - interval '3 hours', 500, false, null, null,
          '[{"error":"Missing OPENAI_API_KEY"}]');
    `)
    await db.exec('reset role')
    for (const role of PUBLIC_ROLES) {
      await expect(asRole(db, role, 'select 1 from public.job_runs')).rejects.toThrow(/permission denied/)
      await expect(asRole(db, role, `insert into public.job_runs (job, started_at, http_status, ok)
        values ('ingest', now(), 200, true)`)).rejects.toThrow(/permission denied/)
      await expect(asRole(db, role, 'delete from public.job_health_public')).rejects.toThrow(/permission denied|cannot delete/)
      const rows = await asRole<Record<string, unknown>>(db, role, 'select * from public.job_health_public order by job')
      expect(rows.map(row => Object.keys(row))).toEqual([JOB_HEALTH_COLUMNS, JOB_HEALTH_COLUMNS])
      const [news, ingest] = rows
      // Latest ingest run failed after an earlier success; the 2-day-old failure is outside 24 h.
      expect(ingest).toMatchObject({ job: 'ingest', last_status: 503, last_ok: false, assets_ok: 3, failures_24h: 1 })
      expect(ingest.last_ok_at).not.toBeNull()
      expect(news).toMatchObject({ job: 'daily-news', last_ok: false, last_ok_at: null, failures_24h: 1 })
      expect(JSON.stringify(rows)).not.toMatch(/internal detail|OPENAI/)
    }
    await db.close()
  }, 60000)

  it('is idempotent, keeps the allowlist guard and rolls back cleanly', async () => {
    const db = await currentReplica()
    await db.exec(sql(join(MIGRATIONS, JOB_HEALTH)))
    await db.exec('create table public.unexpected (id int)')
    await expect(db.exec(sql(join(MIGRATIONS, JOB_HEALTH)))).rejects.toThrow(/Unexpected .* on public\.unexpected/)
    await db.exec('drop table public.unexpected')
    await db.exec(sql(JOB_HEALTH_ROLLBACK))
    await expect(asRole(db, 'anon', 'select 1 from public.job_health_public')).rejects.toThrow(/does not exist/)
    // The dashboard path and the lockdown are unaffected by the rollback.
    expect(await asRole(db, 'anon', 'select symbol from public.current_signals_public')).toHaveLength(1)
    await expect(asRole(db, 'anon', 'select symbol from public.radar_signals')).rejects.toThrow(/permission denied/)
    await db.close()
  }, 60000)
})
