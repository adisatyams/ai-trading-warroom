import type { Env, Heartbeat, MarketBatch, Tick } from "./types";
import { authorized, json } from "./security";
import { AccountCoordinator } from "./coordinator";
export { AccountCoordinator };

const AGENTS = ["SCANNER","RISK_CHECK","SIZER","EXECUTOR","LOGGER","EQUITY"];
const now = () => new Date().toISOString();

async function coordinator(env: Env) {
  const id = env.ACCOUNT_COORDINATOR.idFromName("exness-demo-primary");
  return env.ACCOUNT_COORDINATOR.get(id);
}
async function requireAuth(request: Request, env: Env) {
  return authorized(request, env) ? null : json({ error: "Unauthorized" }, 401);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "AI Trading WarRoom Cloudflare", time: now(),
        execution_enabled: false });
    }

    if (url.pathname.startsWith("/api/")) {
      if (["POST"].includes(request.method)) {
        const denied = await requireAuth(request, env);
        if (denied) return denied;
      }

      if (url.pathname === "/api/v1/agents" && request.method === "GET") {
        const result = await env.DB.prepare(
          "SELECT agent_name AS name,status,detail,last_seen_at FROM agent_status ORDER BY agent_name"
        ).all();
        return json({ agents: result.results, count: result.results.length, execution_enabled: false });
      }

      if (url.pathname === "/api/v1/bridge/heartbeat" && request.method === "POST") {
        const body = await request.json<Heartbeat>();
        if (body.trade_mode !== 0) return json({ error: "Only MT5 DEMO accounts are accepted by Phase 1 bridge policy" }, 403);
        await env.DB.prepare(`INSERT INTO bridge_heartbeats
          (terminal_name,account_server,account_login,connected,balance,equity,currency,trade_mode,received_at)
          VALUES(?,?,?,?,?,?,?,?,?)`)
          .bind(body.terminal_name || "Windows MT5", body.account_server || null,
            body.account_login || null, body.connected ? 1 : 0, body.balance ?? null,
            body.equity ?? null, body.currency ?? null, body.trade_mode ?? null, now()).run();
        if (body.balance !== undefined || body.equity !== undefined) {
          await env.DB.prepare(`INSERT INTO equity_snapshots(balance,equity,floating_pnl,currency,captured_at)
            VALUES(?,?,?,?,?)`).bind(body.balance ?? null, body.equity ?? null,
            body.equity !== undefined && body.balance !== undefined ? body.equity-body.balance : null,
            body.currency ?? null, now()).run();
        }
        return json({ accepted: true, execution_enabled: false });
      }

      if (url.pathname === "/api/v1/bridge/market-batch" && request.method === "POST") {
        const contentLength = Number(request.headers.get("content-length") || 0);
        if (contentLength > 64 * 1024) return json({ error: "Payload too large" }, 413);
        let body: MarketBatch;
        try { body = await request.json<MarketBatch>(); }
        catch { return json({ error: "Invalid JSON" }, 400); }
        if (!Array.isArray(body.ticks) || body.ticks.length < 1 || body.ticks.length > 10)
          return json({ error: "ticks must contain 1 to 10 items" }, 422);
        for (const tick of body.ticks) {
          if (!tick.symbol || typeof tick.symbol !== "string" || tick.symbol.length > 32)
            return json({ error: "Invalid symbol" }, 422);
          if (!Number.isFinite(tick.bid) || !Number.isFinite(tick.ask) || tick.bid! <= 0 || tick.ask! < tick.bid!)
            return json({ error: `Invalid bid/ask for ${tick.symbol}` }, 422);
          if (tick.last !== undefined && !Number.isFinite(tick.last))
            return json({ error: `Invalid last price for ${tick.symbol}` }, 422);
        }
        const receivedAt = now();
        await env.MARKET_INGEST.send({
          batch_id: body.batch_id || crypto.randomUUID(),
          received_at: receivedAt,
          ticks: body.ticks
        });
        return json({ accepted: true, queued: true, tick_count: body.ticks.length,
          execution_enabled: false }, 202);
      }

      // Backward-compatible single-tick endpoint; the bridge uses market-batch to conserve Queue operations.
      if (url.pathname === "/api/v1/bridge/market-snapshot" && request.method === "POST") {
        const body = await request.json<Tick>();
        if (!body.symbol || body.symbol.length > 32) return json({ error: "Invalid symbol" }, 422);
        if (body.bid !== undefined && body.ask !== undefined && body.ask < body.bid)
          return json({ error: "Ask cannot be lower than bid" }, 422);
        await env.MARKET_INGEST.send({ ...body, received_at: now() });
        return json({ accepted: true, queued: true, execution_enabled: false }, 202);
      }

      if (url.pathname === "/api/v1/bridge/status" && request.method === "GET") {
        const row = await env.DB.prepare(`SELECT * FROM bridge_heartbeats ORDER BY id DESC LIMIT 1`).first<any>();
        if (!row) return json({ connected: false, fresh: false });
        const age = (Date.now() - Date.parse(row.received_at)) / 1000;
        return json({ ...row, connected: !!row.connected, age_seconds: Math.round(age),
          fresh: age <= Number(env.BRIDGE_STALE_SECONDS || 45) });
      }

      if (url.pathname === "/api/v1/market/latest" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT * FROM market_latest ORDER BY symbol").all();
        return json({ items: rows.results });
      }

      if (url.pathname === "/api/v1/system/config" && request.method === "GET") {
        return json({
          app_env: env.APP_ENV, paper_mode: env.PAPER_MODE === "true",
          trading_enabled: env.TRADING_ENABLED === "true", execution_enabled: false,
          risk: { max_risk_per_trade_pct: Number(env.MAX_RISK_PER_TRADE_PCT || 0.25),
            max_daily_loss_pct: Number(env.MAX_DAILY_LOSS_PCT || 2),
            max_drawdown_pct: Number(env.MAX_DRAWDOWN_PCT || 5) }
        });
      }

      if (url.pathname.startsWith("/api/v1/control/") && request.method === "POST") {
        const action = url.pathname.split("/").pop();
        if (!["pause","resume","kill"].includes(action || "")) return json({ error: "Unknown action" }, 404);
        const stub = await coordinator(env);
        return await stub.fetch("https://coordinator/" + action, { method: "POST" });
      }

      if (url.pathname === "/api/v1/trading/execute" && request.method === "POST") {
        return json({ error: "Execution locked in Phase 1" }, 423);
      }

      if (url.pathname === "/api/v1/telegram/test" && request.method === "POST") {
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
          return json({ sent: false, reason: "Telegram secrets not configured" }, 400);
        const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: "AI Trading WarRoom Cloudflare: test notification. Phase 1 telemetry only." })
        });
        return json({ sent: resp.ok }, resp.ok ? 200 : 502);
      }

      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    if (batch.queue === "warroom-market-ingest") {
      // Archive one batch as one JSONL object instead of creating one R2 object per tick.
      const items: (Tick & { received_at?: string })[] = [];
      for (const message of batch.messages) {
        const payload = message.body as (Tick & { received_at?: string }) | MarketBatch;
        if ("ticks" in payload && Array.isArray(payload.ticks)) {
          for (const tick of payload.ticks) items.push({ ...tick, received_at: payload.received_at });
        } else {
          items.push(payload as Tick & { received_at?: string });
        }
      }
      try {
        const received = now();
        const day = received.slice(0, 10);
        const firstId = batch.messages[0]?.id || crypto.randomUUID();
        const key = `market-batches/${day}/${firstId}.jsonl`;
        const body = items.map(item => JSON.stringify(item)).join("\n") + "\n";
        await env.MARKET_ARCHIVE.put(key, body, {
          httpMetadata: { contentType: "application/x-ndjson" }
        });

        const statements = items.map(item => {
          const itemReceived = item.received_at || received;
          return env.DB.prepare(`INSERT INTO market_latest(symbol,bid,ask,last,tick_time,received_at)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(symbol) DO UPDATE SET bid=excluded.bid,ask=excluded.ask,
            last=excluded.last,tick_time=excluded.tick_time,received_at=excluded.received_at
            WHERE excluded.received_at >= market_latest.received_at`)
            .bind(item.symbol, item.bid ?? null, item.ask ?? null, item.last ?? null,
              item.time ?? null, itemReceived);
        });
        if (statements.length) await env.DB.batch(statements);
        for (const message of batch.messages) message.ack();
      } catch (err) {
        console.error("market queue batch processing failed", err);
        for (const message of batch.messages) message.retry();
      }
      return;
    }

    if (batch.queue === "warroom-agent-tasks") {
      for (const message of batch.messages) {
        try {
          const task = message.body as { agent?: string; task_id?: string; type?: string };
          console.log(JSON.stringify({ event: "agent_task_received", task }));
          // Phase 1: validate and log tasks. Autonomous strategy reasoning comes in Phase 2.
          await env.DB.prepare(`INSERT INTO system_events(level,event_type,message,payload_json,created_at)
            VALUES(?,?,?,?,?)`).bind("INFO", "AGENT_TASK", "Agent task received",
              JSON.stringify(task), now()).run();
          message.ack();
        } catch (err) {
          console.error("agent task failed", err);
          message.retry();
        }
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const row = await env.DB.prepare("SELECT received_at FROM bridge_heartbeats ORDER BY id DESC LIMIT 1").first<any>();
      const age = row ? (Date.now() - Date.parse(row.received_at)) / 1000 : Infinity;
      if (age > Number(env.BRIDGE_STALE_SECONDS || 45)) {
        await env.DB.prepare(`INSERT INTO system_events(level,event_type,message,created_at)
          VALUES(?,?,?,?)`).bind("WARN","BRIDGE_STALE","Windows MT5 bridge heartbeat is stale",now()).run();
      }
      console.log(JSON.stringify({ event: "warroom_cron", cron: controller.cron, bridge_age_seconds: age }));
    })());
  }
};
