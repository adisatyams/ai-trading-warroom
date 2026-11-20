# AI Trading WarRoom — Cloudflare Edition

This is the Cloudflare-first Phase 1 starter. See `DEPLOYMENT.md` for deployment steps.

Cloudflare components:
- Worker + Static Assets dashboard/API
- D1 operational database
- Queues for market ingestion and agent task processing
- R2 for raw market event archive
- Durable Object for account control state
- Cron Trigger for heartbeat watchdog

Windows VPS:
- Exness MT5 Demo
- Python telemetry bridge

Deterministic scanner (`SNAPSHOT_MOMENTUM_V1`): rule-based candidate generation after market ingestion, results stored for audit and exposed at `/api/v1/scanner/*` (API key required). Research only.

Development: `npm run typecheck` and `npm test`.

Trading execution is intentionally disabled. This package does not send broker orders.
