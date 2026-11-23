# Cloudflare deployment — AI Trading WarRoom Phase 1

## Design
- Worker serves static dashboard assets and `/api/*`.
- Aiven PostgreSQL stores operational records through a Cloudflare Hyperdrive
  binding named `HYPERDRIVE`.
- Queues decouple market ingestion and agent task processing.
- R2 archives raw market events in JSONL batches.
- Durable Object holds per-account pause/kill-switch state.
- Cron checks Windows bridge heartbeat.
- Windows VPS runs MT5 and the Python bridge, which can submit demo-only market
  orders when separately armed.
- Execution is locked by default. The disabled `/api/v1/trading/execute` route
  is not an order sender; the demo Executor uses a separate authenticated pull
  and acknowledgement API.

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
`postgres/002_multi_timeframe_scanner.sql` and then
`postgres/003_executor.sql` and then `postgres/004_executor_hardening.sql`
(adds `trade_intents.dispatched_at`; apply it BEFORE deploying this version).
Fresh databases should apply 001, 002, 003, and 004 in order before deploying.
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
npx wrangler secret put EXECUTOR_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```
Generate separate long random values for `WARROOM_API_KEY` and
`EXECUTOR_API_KEY`. Put the matching values into Wrangler and the Windows
bridge `.env.windows`; never reuse or commit secrets. Telegram secrets can be
left unset until Telegram is configured.

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
- `GET /api/v1/executor/status` reports the Worker gate, demo heartbeat, and
  account pause/kill state. By default, the account begins paused and both
  trading flags are false.
- `GET /api/v1/scanner/status` and `GET /api/v1/scanner/latest` (both require the `x-api-key` header). The scanner warms up after MT5 sends at least 200 completed candles per timeframe.
- `GET /api/v1/bridge/status` returns liveness only (no account login, server, balance or equity).

## Deterministic scanner (MULTI_TIMEFRAME_INDICATORS_V1)

It produces a separate result for each visible MT5 symbol and
M5/M15/H1/H4 timeframe from completed candles, using EMA(20/50/200),
MACD(12/26/9), RSI(14), ATR(14), and Bollinger Bands(20, 2). The rule score is
weighted 25/25/15/20/15 with a 70-point candidate threshold; it is a heuristic,
not a probability of profit. Hypothetical SL uses 2x M1 ATR(14) and TP is 2R.
The bridge discovers all instruments visible in MT5 Market Watch and chunks its
market, candle, and sizing payloads to the Worker limits. Scanner signals alone
never send orders. The Executor requires a fresh demo heartbeat, passing Risk
Checker and Sizer results, an unpaused account, and both Worker
`TRADING_ENABLED` and local `MT5_TRADING_ENABLED` set to `true`. The repository
Wrangler default is now `TRADING_ENABLED=true` (the Worker gate is open so the
demo run can be observed), while `PAPER_MODE=true` and the bridge's
`MT5_TRADING_ENABLED=false` remain; orders still require the bridge gate, an
unpaused account and a demo-account check. Set `TRADING_ENABLED` back to
`false` to lock the Worker side. Before arming, use the authenticated `/api/v1/control/resume`
route; a latched kill switch blocks execution and `/resume` is refused (HTTP
409) until it is cleared with `POST /api/v1/control/reset-kill`, which leaves the
account paused. Every pause/resume/kill/reset-kill is written to `system_events`
(`ACCOUNT_*`) and shows up in the Logger. To lock the Worker side again, use
`npx wrangler deploy --var TRADING_ENABLED:false`.
Tick observations are
retained for 48 hours and scan results for 14 days (pruned by the cron trigger).

## Resolving UNCERTAIN intents
An intent becomes `UNCERTAIN` when the broker outcome is unknown (no ack, or the
bridge reported it). It keeps the symbol locked. A late real acknowledgement from
the bridge is still accepted and upgrades the record. Otherwise reconcile it in
MT5 and call (authenticated with `WARROOM_API_KEY`):

```bash
# No order exists in MT5: releases the symbol
curl -X POST "$URL/api/v1/executor/intents/resolve" -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"intent_id":"<id>","resolution":"NO_FILL","note":"checked MT5 history"}'

# An order/position exists: records it (the symbol stays locked until it closes)
curl -X POST "$URL/api/v1/executor/intents/resolve" -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"intent_id":"<id>","resolution":"FILLED","broker_ticket":"123456","volume":0.1,"entry_price":1.1001}'
```
Pending UNCERTAIN intents are listed in `GET /api/v1/executor/status`
(`uncertain_intents`). Each resolution is written to `system_events`.

## Notes on the architecture
- Queue delivery can retry. Consumers must be idempotent; never treat a queue delivery as proof that a broker order has executed.
- The bridge archives market events in R2, retains a bounded tick-observation history for Risk Check, and stores only the latest completed scanner candle snapshot per symbol/timeframe in PostgreSQL. Keep bridge batches bounded when adding more instruments.
- Queue `warroom-trade-commands` remains provisioned but unused. The Executor
  uses PostgreSQL `trade_intents` and a separate-key HTTP pull/ack flow. It
  chooses the top-scoring eligible timeframe per symbol, sends one command at a
  time, validates the demo account, expiry, current spread and risk, position
  limits, and broker constraints, and does not replay dispatched commands.
- Durable Object pause/resume/kill controls gate new intents and claims. They do
  not close broker positions; trailing stops, modification, and closing remain
  deferred.
- Cron schedules use UTC.
- Use Cloudflare Access or another strong authentication layer for the dashboard before exposing it publicly. The static dashboard is a starter UI; its admin buttons prompt for the API key and should be replaced with a proper Access-protected session flow before production.
