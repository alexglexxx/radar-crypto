-- Public clients read the bounded dashboard view, never its source table.
-- The previous security-invoker view required column-level SELECT on
-- radar_signals, which also made those columns queryable through PostgREST.

-- The view has an explicit projection and seven-day production-model filter.
-- Its postgres owner can read the source after callers lose base-table grants.
alter view public.current_signals_public
  set (security_invoker = false, security_barrier = true);

revoke all on public.current_signals_public from public, anon, authenticated;
grant select on public.current_signals_public to anon, authenticated;

-- Table-level REVOKE does not remove column-level grants. Both are required.
revoke all on public.market_snapshots, public.features,
  public.radar_signals, public.signal_outcomes from public, anon, authenticated;
revoke select (
  symbol, signal_score, decision, regime, entry_price, created_at,
  signal_timestamp, timeframe, model_version, sample_size, rationale
) on public.radar_signals from anon, authenticated;

-- A permissive USING (false) policy does not override another permissive
-- policy. With no SELECT policies and no grants, these tables fail closed.
drop policy if exists "public current radar signals" on public.radar_signals;
drop policy if exists "deny anon market snapshots" on public.market_snapshots;
drop policy if exists "deny anon features" on public.features;
drop policy if exists "deny anon signal outcomes" on public.signal_outcomes;

alter table public.market_snapshots enable row level security;
alter table public.features enable row level security;
alter table public.radar_signals enable row level security;
alter table public.signal_outcomes enable row level security;

-- Reject drift, including an unexpected column grant or PUBLIC grant.
do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'market_snapshots', 'features', 'radar_signals', 'signal_outcomes'
  ] loop
    foreach role_name in array array['anon', 'authenticated'] loop
      if has_any_column_privilege(
        role_name, format('public.%I', table_name), 'SELECT'
      ) then
        raise exception 'Unexpected direct SELECT on %.% for %',
          'public', table_name, role_name;
      end if;
    end loop;
  end loop;
end;
$$;
