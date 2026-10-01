-- Radar Crypto audit hardening
-- Idempotent signal persistence + controlled public dashboard projections.

with duplicates as (
  select id,
         row_number() over (
           partition by snapshot_id, model_version
           order by id
         ) as rn
  from public.radar_signals
)
delete from public.radar_signals s
using duplicates d
where s.id = d.id
  and d.rn > 1;

create unique index if not exists radar_signals_snapshot_model_uidx
  on public.radar_signals (snapshot_id, model_version);

create table if not exists public.radar_public_metrics (
  signal_id bigint primary key references public.radar_signals(id) on delete cascade,
  symbol text not null,
  rsi_14 numeric,
  macd_histogram numeric,
  volume_ratio numeric,
  created_at timestamptz not null default now()
);

create index if not exists radar_public_metrics_symbol_time_idx
  on public.radar_public_metrics (symbol, created_at desc);

alter table public.radar_public_metrics enable row level security;

drop policy if exists "public read market snapshots" on public.market_snapshots;
drop policy if exists "public read features" on public.features;
drop policy if exists "public read radar signals" on public.radar_signals;
drop policy if exists "public read signal outcomes" on public.signal_outcomes;
drop policy if exists "public read radar public metrics" on public.radar_public_metrics;
drop policy if exists "public read dashboard signal fields" on public.radar_signals;

create policy "public read dashboard signal fields"
  on public.radar_signals
  for select
  to anon, authenticated
  using (true);

create policy "public read radar public metrics"
  on public.radar_public_metrics
  for select
  to anon, authenticated
  using (true);

revoke select on table public.market_snapshots from anon, authenticated;
revoke select on table public.features from anon, authenticated;
revoke select on table public.signal_outcomes from anon, authenticated;

revoke select on table public.radar_signals from anon, authenticated;
grant select (
  symbol,
  signal_score,
  decision,
  regime,
  entry_price,
  created_at,
  timeframe,
  sample_size,
  model_version
) on table public.radar_signals to anon, authenticated;

grant select on table public.radar_public_metrics to anon, authenticated;

drop view if exists public.public_signal_history;
drop view if exists public.public_current_signals;

create view public.public_current_signals
with (security_invoker = true)
as
select distinct on (s.symbol)
  s.symbol,
  s.signal_score,
  s.decision,
  s.regime,
  s.entry_price,
  s.created_at,
  s.timeframe,
  s.sample_size,
  s.model_version,
  m.rsi_14,
  m.macd_histogram,
  m.volume_ratio
from public.radar_signals s
left join public.radar_public_metrics m on m.signal_id = s.id
where s.timeframe = '15m'
  and s.model_version = 'v1.1-live'
order by s.symbol, s.created_at desc;

create view public.public_signal_history
with (security_invoker = true)
as
select
  s.symbol,
  s.signal_score,
  s.decision,
  s.regime,
  s.entry_price,
  s.created_at,
  s.timeframe,
  s.sample_size,
  s.model_version
from public.radar_signals s
where s.timeframe = '15m'
  and s.model_version = 'v1.1-live'
order by s.created_at desc
limit 96;

grant select on public.public_current_signals to anon, authenticated;
grant select on public.public_signal_history to anon, authenticated;
