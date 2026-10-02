-- Radar Crypto — public product views
-- These views intentionally expose only the dashboard/news surface.
-- They are owned by the database owner and do not expose base-table privileges to anon.

create or replace view public.current_signals_public as
select
  rs.symbol,
  rs.signal_score,
  rs.decision,
  rs.regime,
  rs.entry_price,
  rs.created_at,
  rs.signal_timestamp,
  rs.timeframe,
  rs.model_version,
  rs.sample_size,
  rs.rationale
from public.radar_signals rs
where rs.model_version = 'v1.1-live'
  and rs.created_at >= now() - interval '7 days';

grant select on public.current_signals_public to anon, authenticated;

create or replace view public.current_news_public as
select
  b.id,
  b.briefing_date,
  b.title,
  b.intro,
  b.market_read,
  b.risk_read,
  b.generated_at,
  b.model_version,
  b.item_count
from public.news_briefings b
order by b.briefing_date desc
limit 1;

grant select on public.current_news_public to anon, authenticated;

create or replace view public.current_news_items_public as
select
  ni.briefing_id,
  ni.source,
  ni.url,
  ni.title,
  ni.published_at,
  ni.summary,
  ni.why_it_matters,
  ni.impact_direction,
  ni.impact_intensity,
  ni.impact_start,
  ni.primary_window,
  ni.persistence_window,
  ni.affected_assets,
  ni.relevance_score,
  ni.confidence,
  ni.market_confirmation,
  ni.rank
from public.news_items ni;

grant select on public.current_news_items_public to anon, authenticated;
