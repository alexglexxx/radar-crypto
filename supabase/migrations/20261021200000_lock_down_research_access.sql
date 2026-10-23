-- Public clients read the bounded dashboard view, never its source table.
-- The previous security-invoker view required column-level SELECT on
-- radar_signals, which also made those columns queryable through PostgREST.

-- The view has an explicit projection and seven-day production-model filter.
-- Its postgres owner can read the source after callers lose base-table grants.
alter view public.current_signals_public
  set (security_invoker = false, security_barrier = true);

-- A simple view is auto-updatable; with owner privileges it must stay SELECT-only.
revoke all on public.current_signals_public from public, anon, authenticated;
grant select on public.current_signals_public to anon, authenticated;

-- Table-level REVOKE also removes column grants; the explicit column REVOKE
-- documents the grants added by 20261001092000 and is a harmless no-op.
revoke all on public.market_snapshots, public.features,
  public.radar_signals, public.signal_outcomes from public, anon, authenticated;
revoke select (
  symbol, signal_score, decision, regime, entry_price, created_at,
  signal_timestamp, timeframe, model_version, sample_size, rationale
) on public.radar_signals from anon, authenticated;

-- A permissive USING (false) policy does not override another permissive
-- policy. With no SELECT policies and no grants, these tables fail closed.
-- The "public read" policies come from the phase 1 migration; production
-- no longer has them, but a fresh replay does.
drop policy if exists "public current radar signals" on public.radar_signals;
drop policy if exists "public read radar signals" on public.radar_signals;
drop policy if exists "public read market snapshots" on public.market_snapshots;
drop policy if exists "public read features" on public.features;
drop policy if exists "public read signal outcomes" on public.signal_outcomes;
drop policy if exists "deny anon market snapshots" on public.market_snapshots;
drop policy if exists "deny anon features" on public.features;
drop policy if exists "deny anon signal outcomes" on public.signal_outcomes;

alter table public.market_snapshots enable row level security;
alter table public.features enable row level security;
alter table public.radar_signals enable row level security;
alter table public.signal_outcomes enable row level security;

-- News views are read-only product surface. Remove default write grants.
revoke all on public.current_news_public, public.current_news_items_public
  from public, anon, authenticated;
grant select on public.current_news_public, public.current_news_items_public
  to anon, authenticated;

-- Legacy objects present in production (audit 2026-10-23) but created outside
-- these migrations. `signals` had an "Allow all" policy and full anon DML
-- grants. Rows are kept; only public access is removed. Guards keep a fresh
-- environment, where these objects do not exist, reproducible.
do $$
declare
  legacy text;
begin
  if to_regclass('public.signals') is not null then
    drop policy if exists "Allow all" on public.signals;
    alter table public.signals enable row level security;
  end if;
  if to_regclass('public.radar_public_metrics') is not null then
    drop policy if exists "public read radar public metrics" on public.radar_public_metrics;
    alter table public.radar_public_metrics enable row level security;
  end if;
  foreach legacy in array array[
    'signals', 'radar_public_metrics', 'public_current_signals', 'public_signal_history'
  ] loop
    if to_regclass(format('public.%I', legacy)) is not null then
      execute format('revoke all on public.%I from public, anon, authenticated', legacy);
    end if;
  end loop;
end;
$$;

-- Reject drift: public roles may read only the allowlisted product surface
-- and may never write to any relation in the public schema.
do $$
declare
  relation record;
  role_name text;
begin
  for relation in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f')
  loop
    foreach role_name in array array['anon', 'authenticated'] loop
      if relation.relname not in (
        'current_signals_public', 'current_news_public',
        'current_news_items_public', 'news_briefings', 'news_items'
      ) and has_any_column_privilege(role_name, relation.oid, 'SELECT') then
        raise exception 'Unexpected direct SELECT on public.% for %',
          relation.relname, role_name;
      end if;
      if has_table_privilege(role_name, relation.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
        or has_any_column_privilege(role_name, relation.oid, 'INSERT, UPDATE') then
        raise exception 'Unexpected write privilege on public.% for %',
          relation.relname, role_name;
      end if;
    end loop;
  end loop;
end;
$$;
