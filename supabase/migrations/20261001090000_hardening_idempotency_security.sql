-- Radar Crypto — production hardening
-- Idempotent signals, canonical signal timestamp, public surface minimization.

-- 1) One production signal per closed market snapshot + model.
create unique index if not exists radar_signals_snapshot_model_uidx
  on public.radar_signals (snapshot_id, model_version);

-- 2) Timestamp of the market event that generated the signal.
alter table public.radar_signals
  add column if not exists signal_timestamp timestamptz;

-- Backfill existing rows from the source candle timestamp.
update public.radar_signals rs
set signal_timestamp = ms.source_timestamp
from public.market_snapshots ms
where rs.snapshot_id = ms.id
  and rs.signal_timestamp is null;

-- Future rows must always carry the market-event timestamp.
alter table public.radar_signals
  alter column signal_timestamp set default now();

-- 3) News tables are versioned here so a fresh environment is reproducible.
create table if not exists public.news_briefings (
  id bigint generated always as identity primary key,
  briefing_date date not null unique,
  title text not null,
  intro text,
  market_read text,
  risk_read text,
  generated_at timestamptz not null default now(),
  model_version text not null default 'v1',
  item_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.news_items (
  id bigint generated always as identity primary key,
  briefing_id bigint not null references public.news_briefings(id) on delete cascade,
  source text not null,
  url text not null,
  title text not null,
  published_at timestamptz,
  summary text not null,
  why_it_matters text not null,
  impact_direction text not null,
  impact_intensity text not null,
  impact_start text not null,
  primary_window text not null,
  persistence_window text not null,
  affected_assets text[] not null,
  relevance_score integer not null check (relevance_score between 0 and 100),
  confidence integer not null check (confidence between 0 and 100),
  market_confirmation text not null default 'pending',
  rank integer not null,
  created_at timestamptz not null default now()
);

create index if not exists news_items_briefing_rank_idx
  on public.news_items (briefing_id, rank);

-- 4) Keep research tables private to server/service-role access.
-- The dashboard receives only the intentionally limited public view below.
revoke all on public.market_snapshots from anon, authenticated;
revoke all on public.features from anon, authenticated;
revoke all on public.radar_signals from anon, authenticated;
revoke all on public.signal_outcomes from anon, authenticated;

alter table public.news_briefings enable row level security;
alter table public.news_items enable row level security;
revoke all on public.news_briefings from anon, authenticated;
revoke all on public.news_items from anon, authenticated;

-- Public dashboard surface: current production model only, recent enough to be useful.
drop view if exists public.current_signals_public;
create view public.current_signals_public
with (security_invoker = true) as
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

-- News is public product data, but only through read-only views.
create or replace view public.current_news_public
with (security_invoker = true) as
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

create or replace view public.current_news_items_public
with (security_invoker = true) as
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
