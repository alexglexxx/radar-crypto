-- Radar Crypto — keep public views security-invoker and make base-table access explicit.

-- Research tables: RLS stays enabled and anon/authenticated are explicitly denied.
drop policy if exists "deny anon market snapshots" on public.market_snapshots;
create policy "deny anon market snapshots" on public.market_snapshots for all to anon, authenticated using (false) with check (false);

drop policy if exists "deny anon features" on public.features;
create policy "deny anon features" on public.features for all to anon, authenticated using (false) with check (false);

drop policy if exists "deny anon signal outcomes" on public.signal_outcomes;
create policy "deny anon signal outcomes" on public.signal_outcomes for all to anon, authenticated using (false) with check (false);

-- Radar signals: only the current production model and recent rows are public.
drop policy if exists "public current radar signals" on public.radar_signals;
create policy "public current radar signals" on public.radar_signals
  for select to anon, authenticated
  using (model_version = 'v1.1-live' and created_at >= now() - interval '7 days');

grant select (symbol, signal_score, decision, regime, entry_price, created_at, signal_timestamp, timeframe, model_version, sample_size, rationale)
  on public.radar_signals to anon, authenticated;

-- News is intentionally public product content.
drop policy if exists "public read news briefings" on public.news_briefings;
create policy "public read news briefings" on public.news_briefings
  for select to anon, authenticated using (true);
drop policy if exists "public read news items" on public.news_items;
create policy "public read news items" on public.news_items
  for select to anon, authenticated using (true);
grant select on public.news_briefings to anon, authenticated;
grant select on public.news_items to anon, authenticated;

-- Make views security-invoker so RLS/column grants of the querying role apply.
create or replace view public.current_signals_public
with (security_invoker = true) as
select
  rs.symbol, rs.signal_score, rs.decision, rs.regime, rs.entry_price,
  rs.created_at, rs.signal_timestamp, rs.timeframe, rs.model_version,
  rs.sample_size, rs.rationale
from public.radar_signals rs
where rs.model_version = 'v1.1-live'
  and rs.created_at >= now() - interval '7 days';

grant select on public.current_signals_public to anon, authenticated;

create or replace view public.current_news_public
with (security_invoker = true) as
select b.id, b.briefing_date, b.title, b.intro, b.market_read,
  b.risk_read, b.generated_at, b.model_version, b.item_count
from public.news_briefings b
order by b.briefing_date desc
limit 1;

grant select on public.current_news_public to anon, authenticated;

create or replace view public.current_news_items_public
with (security_invoker = true) as
select ni.briefing_id, ni.source, ni.url, ni.title, ni.published_at,
  ni.summary, ni.why_it_matters, ni.impact_direction, ni.impact_intensity,
  ni.impact_start, ni.primary_window, ni.persistence_window,
  ni.affected_assets, ni.relevance_score, ni.confidence,
  ni.market_confirmation, ni.rank
from public.news_items ni;

grant select on public.current_news_items_public to anon, authenticated;
