-- Rollback for 20261021200000_lock_down_research_access.sql.
-- Kept outside supabase/migrations so the CLI never applies it automatically.
-- Restores only the pre-migration dashboard path (security-invoker view with
-- column grants and the seven-day policy). It deliberately does not reopen
-- legacy tables, research tables or write grants.

alter view public.current_signals_public
  set (security_invoker = true, security_barrier = false);

drop policy if exists "public current radar signals" on public.radar_signals;
create policy "public current radar signals" on public.radar_signals
  for select to anon, authenticated
  using (model_version = 'v1.1-live' and created_at >= now() - interval '7 days');

grant select (
  symbol, signal_score, decision, regime, entry_price, created_at,
  signal_timestamp, timeframe, model_version, sample_size, rationale
) on public.radar_signals to anon, authenticated;
