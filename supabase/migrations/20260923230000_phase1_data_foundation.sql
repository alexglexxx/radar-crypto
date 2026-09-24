-- Radar Crypto — Phase 1 data foundation
-- Research tables are intentionally separate from the legacy public.signals table.

create table if not exists public.market_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null,
  symbol text not null,
  exchange text not null,
  timeframe text not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric not null,
  source_timestamp timestamptz,
  created_at timestamptz not null default now(),
  unique (captured_at, symbol, exchange, timeframe)
);

create index if not exists market_snapshots_symbol_time_idx on public.market_snapshots (symbol, captured_at desc);

create table if not exists public.features (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references public.market_snapshots(id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  captured_at timestamptz not null,
  return_5m numeric, return_15m numeric, return_1h numeric, return_4h numeric, return_24h numeric,
  ema_20 numeric, ema_50 numeric, ema_200 numeric, trend_strength numeric,
  rsi_14 numeric, macd numeric, macd_signal numeric, macd_histogram numeric,
  volume_sma numeric, volume_ratio numeric, volatility numeric, atr numeric,
  created_at timestamptz not null default now(),
  unique (snapshot_id)
);

create index if not exists features_symbol_time_idx on public.features (symbol, captured_at desc);

create table if not exists public.radar_signals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  snapshot_id bigint not null references public.market_snapshots(id) on delete restrict,
  feature_id bigint references public.features(id) on delete restrict,
  symbol text not null, timeframe text not null, regime text not null,
  signal_score numeric not null check (signal_score between 0 and 100),
  decision text not null check (decision in ('LONG','SHORT','WAIT')),
  entry_price numeric, stop_price numeric, target_price numeric, risk_reward numeric,
  estimated_probability numeric, expected_r numeric, sample_size integer,
  rationale jsonb not null default '{}'::jsonb,
  model_version text not null default 'v1'
);

create index if not exists radar_signals_symbol_time_idx on public.radar_signals (symbol, created_at desc);

create table if not exists public.signal_outcomes (
  id bigint generated always as identity primary key,
  signal_id bigint not null references public.radar_signals(id) on delete cascade,
  evaluated_at timestamptz not null default now(),
  horizon text not null, outcome_price numeric, realized_return numeric, realized_r numeric,
  max_favorable_excursion numeric, max_adverse_excursion numeric,
  outcome text not null check (outcome in ('WIN','LOSS','TIMEOUT','INVALIDATED','PENDING')),
  created_at timestamptz not null default now(),
  unique (signal_id, horizon)
);

create index if not exists signal_outcomes_signal_idx on public.signal_outcomes (signal_id, horizon);

alter table public.market_snapshots enable row level security;
alter table public.features enable row level security;
alter table public.radar_signals enable row level security;
alter table public.signal_outcomes enable row level security;

create policy "public read market snapshots" on public.market_snapshots for select to anon, authenticated using (true);
create policy "public read features" on public.features for select to anon, authenticated using (true);
create policy "public read radar signals" on public.radar_signals for select to anon, authenticated using (true);
create policy "public read signal outcomes" on public.signal_outcomes for select to anon, authenticated using (true);
