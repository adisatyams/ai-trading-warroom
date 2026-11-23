# AI Trading WarRoom — Cloudflare Edition

This is the Cloudflare-first Phase 1 starter. See `DEPLOYMENT.md` for deployment steps.

Cloudflare components:
- Worker + Static Assets dashboard/API
- Aiven PostgreSQL operational database through Cloudflare Hyperdrive
- Queues for market ingestion and agent task processing
- R2 for raw market event archive
- Durable Object for account control state
- Cron Trigger for heartbeat watchdog

Windows VPS:
- Exness MT5 Demo
- Python telemetry bridge

Deterministic multi-timeframe scanner (`MULTI_TIMEFRAME_INDICATORS_V1`): evaluates completed M5/M15/H1/H4 candles with EMA, MACD, RSI, ATR, and Bollinger/breakout scoring. Results are per symbol/timeframe and exposed at `/api/v1/scanner/*` (API key required). Research only; scores are heuristics, not probabilities.

Development: `npm run typecheck` and `npm test`.

Trading execution is intentionally disabled. This package does not send broker orders.
