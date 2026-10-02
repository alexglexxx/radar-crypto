# Radar Crypto

Radar Crypto is an experimental 15-minute crypto market radar for BTC, ETH, SOL and XRP using closed Binance candles, deterministic technical features and the `v1.1-live` scoring engine.

## Architecture

- **Market data:** Binance `data-api.binance.vision`
- **Runtime:** Next.js on Vercel
- **Persistence:** Supabase/PostgreSQL
- **Live engine:** `app/api/cron/route.ts`
- **Features:** `lib/features.ts`
- **Scoring:** `lib/scoring.ts`
- **Historical research:** `scripts/backtest.ts`
- **News intelligence:** RSS candidates + OpenAI Responses API

## Important model rule

`v1.1-live` is treated as a frozen production research model while it is being evaluated. Do not tune the score based on the test period. Changes to features or scoring should create a new model version and a new research run.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Quality gate:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

## Environment

Server-side:

```dotenv
SUPABASE_SERVICE_ROLE_KEY=...
CRON_SECRET=...
OPENAI_API_KEY=...
NEWS_AI_MODEL=gpt-6-luna
```

Public client values:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

The service-role key must never use a `NEXT_PUBLIC_` prefix.

## Historical backtest

The canonical backtest imports the exact production feature and scoring functions rather than maintaining a second copy of the strategy logic.

Default run:

```bash
npm run backtest
```

Defaults:

- 36 months
- 15-minute candles
- BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT
- 10 bps fees
- 5 bps slippage
- development / validation / out-of-sample splits

The GitHub Actions workflow can be launched manually and uploads `report.json` and `trades.json` as artifacts.

## Data integrity

Live signal writes are idempotent on `(snapshot_id, model_version)`. Outcomes are timestamped from the source candle close rather than database insertion time. Public clients read restricted views instead of research tables.

## Status

**Experimental / research.** The radar is not an automated trading system and its score is not a guarantee of future returns. Quantitative validation, out-of-sample stability and live paper-trading evidence are required before risking capital.
