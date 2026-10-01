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

drop policy if exists "public read market snapshots" on public.market_snapshots;
drop policy if exists "public read features" on public.features;
drop policy if exists "public read radar signals" on public.radar_signals;
drop policy if exists "public read signal outcomes" on public.signal_outcomes;

revoke select on table public.market_snapshots from anon, authenticated;
revoke select on table public.features from anon, authenticated;
revoke select on table public.radar_signals from anon, authenticated;
revoke select on table public.signal_outcomes from anon, authenticated;

drop view if exists public.public_signal_history;
drop view if exists public.public_current_signals;

create view public.public_current_signals as
select distinct on (symbol)
  symbol,
  signal_score,
  decision,
  regime,
  entry_price,
  created_at,
  timeframe,
  sample_size,
  model_version,
  (rationale->>'rsi_14')::numeric as rsi_14,
  (rationale->>'macd_histogram')::numeric as macd_histogram,
  (rationale->>'volume_ratio')::numeric as volume_ratio
from public.radar_signals
where timeframe = '15m'
  and model_version = 'v1.1-live'
  and rationale->>'exchange' = 'binance'
order by symbol, created_at desc;

create view public.public_signal_history as
select
  symbol,
  signal_score,
  decision,
  regime,
  entry_price,
  created_at,
  timeframe,
  sample_size,
  model_version
from public.radar_signals
where timeframe = '15m'
  and model_version = 'v1.1-live'
  and rationale->>'exchange' = 'binance'
order by created_at desc
limit 96;

grant select on public.public_current_signals to anon, authenticated;
grant select on public.public_signal_history to anon, authenticated;
