# Cloudflare deployment — AI Trading WarRoom Phase 1

## Design
- Worker serves static dashboard assets and `/api/*`.
- D1 stores operational records and latest snapshots.
- Queues decouple market ingestion and agent task processing.
- R2 archives raw market events in JSONL batches.
- Durable Object holds per-account pause/kill-switch state.
- Cron checks Windows bridge heartbeat.
- Windows VPS runs MT5 and a telemetry-only Python bridge.
- Trade execution is deliberately locked; `/api/v1/trading/execute` is not implemented as an order sender.

## Prerequisites
- Cloudflare account with Workers, D1, Queues and R2 enabled.
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
npx wrangler d1 create warroom-db
npx wrangler queues create warroom-market-ingest
npx wrangler queues create warroom-agent-tasks
npx wrangler queues create warroom-trade-commands
npx wrangler queues create warroom-market-dlq
npx wrangler queues create warroom-agent-dlq
npx wrangler r2 bucket create warroom-market-archive
```
Copy the D1 database_id into wrangler.jsonc. Queue producer/consumer names and R2 bucket name must match exactly.

## 3. Apply D1 migration
```bash
npx wrangler d1 migrations apply warroom-db --remote
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
Set `WARROOM_API_URL` to the deployed Worker URL, `WARROOM_API_KEY` to the secret set above, exact MT5 symbol names, and terminal path.

## 7. Verify
- `GET /health`
- `GET /api/v1/agents`
- `GET /api/v1/bridge/status`
- `GET /api/v1/market/latest`
- Dashboard shows agents, heartbeat, and market symbols.
- `GET /api/v1/system/config` reports `execution_enabled:false`.
- `POST /api/v1/trading/execute` is not an active order route; execution remains locked.

## Notes on the architecture
- Queue delivery can retry. Consumers must be idempotent; never treat a queue delivery as proof that a broker order has executed.
- Do not send every raw tick to D1 at high frequency. This starter archives each market event in R2 and updates only the latest-per-symbol row in D1. For production, aggregate ticks into candles before storing analytics in D1.
- Queue `warroom-trade-commands` is provisioned but has no consumer or order sender in Phase 1. Later, Windows can use an HTTP pull consumer for commands, with a separate restricted Cloudflare API token. The Windows bridge must validate account, environment, expiry, idempotency key, symbol, risk approval, and kill-switch before forwarding any command to MT5.
- Durable Object pause/resume/kill endpoints in Phase 1 control system state only. They do not close broker positions or enable execution.
- Cron schedules use UTC.
- Use Cloudflare Access or another strong authentication layer for the dashboard before exposing it publicly. The static dashboard is a starter UI; its admin buttons prompt for the API key and should be replaced with a proper Access-protected session flow before production.
