# Cloudflare deployment — AI Trading WarRoom Phase 1

## Design
- Worker serves static dashboard assets and `/api/*`.
- Aiven PostgreSQL stores operational records through a Cloudflare Hyperdrive
  binding named `HYPERDRIVE`.
- Queues decouple market ingestion and agent task processing.
- R2 archives raw market events in JSONL batches.
- Durable Object holds per-account pause/kill-switch state.
- Cron checks Windows bridge heartbeat.
- Windows VPS runs MT5 and a telemetry-only Python bridge.
- Trade execution is deliberately locked; `/api/v1/trading/execute` is not implemented as an order sender.

## Prerequisites
- Cloudflare account with Workers, Hyperdrive, Queues and R2 enabled.
- An Aiven PostgreSQL database.
- Node.js 20+ and npm on your development PC.
- Wrangler 4.x.
- Exness MT5 Demo terminal on Windows VPS.

## 1. Install dependencies
```bash
npm install
npx wrangler login
```

## 2. Create Cloudflare resources
```bash
npx wrangler queues create warroom-market-ingest
npx wrangler queues create warroom-agent-tasks
npx wrangler queues create warroom-trade-commands
npx wrangler queues create warroom-market-dlq
npx wrangler queues create warroom-agent-dlq
npx wrangler r2 bucket create warroom-market-archive
```
Queue producer/consumer names and R2 bucket name must match exactly. Rotate the
Aiven password before configuring Hyperdrive: the previously shared database
URL is compromised. Create a Hyperdrive configuration with the new URL and add
the returned ID to `wrangler.jsonc`:

```jsonc
"compatibility_flags": ["nodejs_compat"],
"hyperdrive": [
  { "binding": "HYPERDRIVE", "id": "<hyperdrive-configuration-id>" }
]
```

Remove the `d1_databases` section when the Hyperdrive binding is available.

## 3. Initialize PostgreSQL
This deployment starts with an empty Aiven database; D1 records are not copied.
Apply `postgres/001_initial_schema.sql` using the Aiven console or `psql`.
For an existing database already initialized with 001, apply
`postgres/002_multi_timeframe_scanner.sql` before deploying this scanner
version. Fresh databases may apply 001 directly.
Keep the connection URL in a secure environment variable or password manager;
never commit or print it.

Validate locally first, and do not continue if anything fails:

```bash
npm ci
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

## 4. Configure secrets
```bash
npx wrangler secret put WARROOM_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```
For API key, generate a long random value locally, then paste it into Wrangler and the Windows bridge `.env.windows`. Telegram secrets can be left unset until Telegram is configured. Never commit secrets.

## 5. Deploy
```bash
npm run deploy
```
Open the deployed `workers.dev` URL. `/` serves dashboard and `/health` checks API.

## 6. Windows bridge
Install Python 3.11/3.12 64-bit, install MT5 desktop and log into Exness Demo.
```powershell
cd windows-bridge
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.windows.example .env.windows
notepad .env.windows
python bridge.py
```
Set `WARROOM_API_URL` to the deployed Worker URL, `WARROOM_API_KEY` to the secret set above, and the terminal path. The bridge automatically scans every instrument visible in MT5 Market Watch.

## 7. Verify
- `GET /health`
- `GET /api/v1/agents`
- `GET /api/v1/bridge/status`
- `GET /api/v1/market/latest`
- Dashboard shows agents, heartbeat, and market symbols.
- `GET /api/v1/system/config` reports `execution_enabled:false`.
- `POST /api/v1/trading/execute` is not an active order route; execution remains locked.
- `GET /api/v1/scanner/status` and `GET /api/v1/scanner/latest` (both require the `x-api-key` header). The scanner warms up after MT5 sends at least 200 completed candles per timeframe.
- `GET /api/v1/bridge/status` returns liveness only (no account login, server, balance or equity).

## Deterministic scanner (MULTI_TIMEFRAME_INDICATORS_V1)

Research-only: it produces a separate result for each visible MT5 symbol and
M5/M15/H1/H4 timeframe from completed candles, using EMA(20/50/200),
MACD(12/26/9), RSI(14), ATR(14), and Bollinger Bands(20, 2). The rule score is
weighted 25/25/15/20/15 with a 70-point candidate threshold; it is a heuristic,
not a probability of profit. Hypothetical SL uses 2x M1 ATR(14) and TP is 2R.
The bridge discovers all instruments visible in MT5 Market Watch and chunks its
market, candle, and sizing payloads to the Worker limits. It has no path to the
executor; `TRADING_ENABLED=false` and `PAPER_MODE=true` must stay set. Tick
observations are retained for 48 hours and scan results for 14 days (pruned by
the cron trigger).

## Notes on the architecture
- Queue delivery can retry. Consumers must be idempotent; never treat a queue delivery as proof that a broker order has executed.
- The bridge archives market events in R2, retains a bounded tick-observation history for Risk Check, and stores only the latest completed scanner candle snapshot per symbol/timeframe in PostgreSQL. Keep bridge batches bounded when adding more instruments.
- Queue `warroom-trade-commands` is provisioned but has no consumer or order sender in Phase 1. Later, Windows can use an HTTP pull consumer for commands, with a separate restricted Cloudflare API token. The Windows bridge must validate account, environment, expiry, idempotency key, symbol, risk approval, and kill-switch before forwarding any command to MT5.
- Durable Object pause/resume/kill endpoints in Phase 1 control system state only. They do not close broker positions or enable execution.
- Cron schedules use UTC.
- Use Cloudflare Access or another strong authentication layer for the dashboard before exposing it publicly. The static dashboard is a starter UI; its admin buttons prompt for the API key and should be replaced with a proper Access-protected session flow before production.
