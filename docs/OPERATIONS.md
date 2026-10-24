# Radar Crypto — operational verification

Session date: 2026-10-20 (America/Mexico_City).

## What changed

- Binance requests have a 10-second timeout. The existing 250-row request and
  closed-candle safety margin remain unchanged. Invalid prices, duplicate or
  unordered rows, missing 15m bars and incorrect candle boundaries are rejected.
- Ingestion requires at least 200 closed candles and a source close no older
  than 20 minutes. A failed asset does not prevent ingestion of healthy assets.
- Snapshots retain their existing composite conflict key. Only the latest
  feature row is calculated; retries preserve stored features and signals.
  The score is calculated from the feature row read back from Supabase.
- Outcomes select up to 200 **missing results per horizon**, rather than the
  first 200 signals forever. Snapshot reads are batched per asset and paginated.
- Outcomes require the exact horizon and every intervening 15m candle. Missing
  data stays pending for 24 hours after the target; then the result is explicitly
  `INVALIDATED`, with null returns, so incomplete history cannot block the queue.
  Existing outcomes remain unchanged, including concurrent writes.
- The authenticated cron returns `200/ok:true` on complete success, `503` with
  per-asset/evaluation errors on partial failure, `401` without valid auth and
  `500` when server configuration fails. No secrets are included in responses.
- Dashboard reads each asset independently, orders by market-event timestamp,
  refreshes history every minute and shows missing/stale/unverified assets.
  The displayed candle count is input size, not statistical evidence.
- Dependencies are locked. Active CI workflows now use Node 24, matching the
  existing Vercel project and local runtime. The resolved Supabase SDK requires
  Node >=22; leaving CI on Node 20 would produce an unsupported environment.

## Reproduce locally

```powershell
npm ci
npm run typecheck -- --incremental false
npm test -- --reporter=verbose
npm run verify:engine
npm run lint
npm run build
npm run start -- --hostname 127.0.0.1 --port 3100
```

Open `http://127.0.0.1:3100`. Without Supabase public environment values the
dashboard must show a connection error and all assets as `SIN VERIFICAR`, never
claim a healthy feed. Public values must be present **at build time**.

`GET http://127.0.0.1:3100/api/cron` without a bearer token must return HTTP 401
and `{"ok":false,"error":"Unauthorized"}` without touching the database.

For an authorized local integration run, copy `.env.example` to `.env.local`
and configure a **test Supabase project** with the existing migrations. Restart
the server, then call `/api/cron` with `Authorization: Bearer <CRON_SECRET>`.
An authorized request writes data: do not point a local write test at production.
Invoke twice and verify unchanged counts on the same source candle. Counts are
verified automatically by `tests/cron.test.ts` using HTTP fixtures and the real
Supabase SDK; they are not a claim that a production write was performed.

## Engine contract

`lib/features.ts` and `lib/scoring.ts` are unchanged. The cron and
`scripts/backtest.ts` import these production functions. The optimized
`scripts/backtest-baseline.ts` uses the production score and an incremental
feature implementation with existing runtime parity checks.

`npm run verify:engine` adds an offline check of all features and scores at 18
checkpoints across flat, trending and oscillating data, including 249/250-candle
inputs. It performs no downloads or database writes.

This verifies equal mathematics for equal input history, **not identical live
and historical signal streams**. Live requests retain their existing rolling
history, while research uses growing history. The separate 1h discovery and
walk-forward scripts are research candidates, not the deployed 15m model.
No feature/scoring parameters or historical outcomes were tuned or rewritten.

## Production observations (read only)

Connected Supabase project: `radar-crypto`, active and healthy.

- Initial audit: 9,316 snapshots, 7,797 signals, 600 outcomes.
- Exactly 200 outcomes in each of `15m`, `1h`, `4h`; latest evaluations dated
  2026-10-05. This matches the old evaluator's fixed-first-200 failure.
- Subsequent audit: zero duplicate snapshot keys and zero duplicate signal keys.
- Unique indexes for snapshot events, snapshot features, snapshot/model signals
  and signal/horizon outcomes exist in the connected database.
- All four assets are readable through `current_signals_public` with recent
  source timestamps. This was a connector SQL read, not an anonymous browser
  authentication test.
- A later audit found 355/355/351 missing mature outcomes for 15m/1h/4h. Counts
  change while the existing production scheduler continues running.

No schema migration or production data write was performed by this session.

## Verification results

- `npm test -- --reporter=verbose`: 25/25 passed across 5 files, including
  concurrent cron invocations, partial-write recovery, no duplicate events,
  pending-outcome batches beyond the original 200, pagination and candle gaps.
- `npm run verify:engine`: 18/18 feature and score checkpoints passed.
- TypeScript (`--incremental false`), ESLint and production build: passed.
- `git diff --check`: passed. Feature and scoring source files have no diff.
- Local production server: `/` returned HTTP 200 with radar and health status
  markup; `/api/cron` without a token returned HTTP 401 with
  `{"ok":false,"error":"Unauthorized"}`. Full browser access to live Supabase
  was not validated because no local public environment values were configured.

## Delivery files

- `app/api/cron/route.ts`
- `app/page.tsx`
- `lib/market/binance.ts`
- `lib/outcomes.ts` (new)
- `lib/system-status.ts` (new)
- `tests/binance.test.ts` (new)
- `tests/cron.test.ts` (new)
- `tests/outcomes.test.ts` (new)
- `tests/system-status.test.ts` (new)
- `scripts/backtest-baseline.ts`
- `package.json`
- `package-lock.json` (new)
- `.gitignore` (new)
- `.env.example`
- `.github/workflows/quality.yml`
- `.github/workflows/backtest.yml`
- `.github/workflows/backtest-discovery.yml`
- `.github/workflows/backtest-walkforward.yml`
- `README.md` (scheduler documentation observed during this session)
- `docs/OPERATIONS.md` (new)

ALE updates live outside the repository: `PROJECT_STATE.md`, generated
`HANDOFF.md`, `MEMORY_INDEX.md`, and `projects/radar-crypto/` current state,
decisions and lessons. Unrelated workspace configuration was preserved.

## Remaining deployment checks

1. Review the existing external scheduler before adding another trigger.
   The README identifies cron-job.org as the ingestion caller. Its configuration
   has not been inspected. Git commit `b9682e2` confirms the earlier 15m Vercel
   cron was removed for the Hobby plan. Supabase has no `cron` schema. Do not
   create a duplicate trigger. Vercel Hobby only supports daily cron jobs; a 15m Vercel
   schedule needs an eligible plan. See
   https://vercel.com/docs/cron-jobs/usage-and-pricing.
2. After an explicitly authorized deployment, verify the pending-outcome backlog
   decreases over successive runs, check logs for `INVALIDATED` gaps and confirm
   public browser reads under the actual anonymous role.
3. Compare paper outcomes with a live-history replay before interpreting
   research performance. No new historical performance claim is made here.
4. The existing `github/workflows/baseline-backtest.yml` is outside GitHub's
   workflow directory; the active `.github/workflows/backtest.yml` already runs
   the baseline. Consolidation can be handled separately without losing research.

## Job health and production migration history (2026-10-24)

**Job health.** `/api/cron` records every authorized run in the private table `job_runs` (status, assets, error text). The dashboard reads `job_health_public`, which exposes only the latest run, the latest success and the 24-hour failure count per job, never the error text. A failed health write is logged and does not change the job's response; the dashboard then shows the job as stale. Read the error details with the service role:

```sql
select job, finished_at, http_status, assets_ok, errors
from public.job_runs order by finished_at desc limit 20;
```

Migration `20261024120000_job_runs_health.sql`, rollback in `supabase/rollback/`. The code works with or without the table, so the migration and the deploy can go in either order.

**Daily news removed (2026-10-24).** It never ran successfully: `news_briefings` and `news_items` have 0 rows in production because production has no `OPENAI_API_KEY` (and no `NEWS_AI_MODEL`; the code fell back to the unverified `gpt-6-luna`), so `/api/daily-news` returned HTTP 500 every day at 13:00 UTC. Vercel Hobby keeps runtime logs for one hour, so nobody saw it. By decision of Alex the cron, the API routes and the dashboard section were removed; the empty tables and public news views stay. To restore: recover `app/api/daily-news`, `app/api/news-briefing` and `app/components/NewsIntelligence.tsx` from commit `1f88ecb` (the daily route already records its runs as job `daily-news`), set the key and an explicit model in Vercel, and re-add the cron to `vercel.json`.

**Repo migrations vs. `supabase_migrations.schema_migrations`.** Production versions were assigned when the SQL was applied through the Supabase tools, so they do not match the file names. Do not use `supabase db push`; apply reviewed SQL.

| Repo file | Production record |
| --- | --- |
| `20260923230000_phase1_data_foundation.sql` | not recorded (applied before the history existed) |
| — | `20261001001546 create_news_intelligence` (production only; superseded by the next file) |
| `20261001090000_hardening_idempotency_security.sql` | `20261002002040` |
| `20261001091000_hardening_public_views.sql` | `20261002002046` |
| `20261001092000_hardening_rls_invoker_views.sql` | `20261002002120` |
| `20261001093000_hardening_remove_legacy_public_policies.sql` | `20261002002145` |
| `20261021200000_lock_down_research_access.sql` | not recorded (applied in the SQL Editor on 2026-10-24) |
| `20261024120000_job_runs_health.sql` | pending |
