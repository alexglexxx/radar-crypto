-- Radar Crypto — close the open write access on the legacy public.signals table.
--
-- Found during the October 2026 audit: public.signals carried the policy "Allow all"
-- (role public, cmd ALL, using true) and anon/authenticated held INSERT/UPDATE/DELETE/TRUNCATE.
-- Anyone with the public anon key (shipped in the web bundle) could modify or delete its rows.
-- The application no longer reads or writes this table; it holds 888 legacy rows
-- (2026-09-23 .. 2026-09-25).
--
-- Non-destructive: data is kept, reads keep working exactly as before, only writes are closed.
-- service_role (used by the server routes) is unaffected.
-- Idempotent, and safe on a fresh database: it only touches objects that exist
-- (signals, public_current_signals, public_signal_history and radar_public_metrics are not
-- created by the earlier migrations in this repository).

do $$
begin
  if to_regclass('public.signals') is not null then
    execute 'drop policy if exists "Allow all" on public.signals';
    execute 'drop policy if exists "public read legacy signals" on public.signals';
    execute 'create policy "public read legacy signals" on public.signals for select to anon, authenticated using (true)';
    execute 'revoke insert, update, delete, truncate, references, trigger on public.signals from anon, authenticated';
  end if;
end
$$;

-- Defense in depth: the public views and the metrics table are read-only products.
-- (Views are security_invoker, so base-table RLS already blocks writes; this removes dormant grants.)
do $$
declare
  relation text;
begin
  foreach relation in array array[
    'public.current_news_items_public',
    'public.current_news_public',
    'public.current_signals_public',
    'public.public_current_signals',
    'public.public_signal_history',
    'public.radar_public_metrics'
  ]
  loop
    if to_regclass(relation) is not null then
      execute format('revoke insert, update, delete, truncate, references, trigger on %s from anon, authenticated', relation);
    end if;
  end loop;
end
$$;
