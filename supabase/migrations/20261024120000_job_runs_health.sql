-- Scheduled-job health that the dashboard can read. Vercel Hobby keeps
-- runtime logs for one hour and the external scheduler only emails, so the
-- jobs record their own outcome here. Only authorized runs are recorded.

create table if not exists public.job_runs (
  id bigint generated always as identity primary key,
  job text not null check (job in ('ingest', 'daily-news')),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  http_status integer not null,
  ok boolean not null,
  assets_ok integer,
  assets_total integer,
  errors jsonb not null default '[]'::jsonb
);

create index if not exists job_runs_job_finished_idx
  on public.job_runs (job, finished_at desc);

-- Error text stays private; Supabase default privileges grant anon full DML
-- on new tables, so revoke and rely on RLS with no policies.
alter table public.job_runs enable row level security;
revoke all on public.job_runs from public, anon, authenticated;

-- Bounded public surface: latest run, latest success and 24-hour failures per
-- job. Owner privileges read the private table, as with current_signals_public.
create or replace view public.job_health_public
  with (security_invoker = false, security_barrier = true) as
select
  latest.job,
  latest.finished_at as last_run_at,
  latest.http_status as last_status,
  latest.ok as last_ok,
  latest.assets_ok,
  latest.assets_total,
  (select max(r.finished_at) from public.job_runs r
    where r.job = latest.job and r.ok) as last_ok_at,
  (select count(*) from public.job_runs r
    where r.job = latest.job and not r.ok
      and r.finished_at > now() - interval '24 hours')::integer as failures_24h
from (
  select distinct on (job) job, finished_at, http_status, ok, assets_ok, assets_total
  from public.job_runs
  order by job, finished_at desc
) latest;

revoke all on public.job_health_public from public, anon, authenticated;
grant select on public.job_health_public to anon, authenticated;

-- Same drift guard as 20261021200000, with the new view allowlisted.
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
        'current_news_items_public', 'news_briefings', 'news_items',
        'job_health_public'
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
