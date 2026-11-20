
import type {
  Env,
  Heartbeat,
  MarketBatch,
  NewsCalendarPayload,
  PositionSnapshotPayload,
  SizingInputsPayload,
  Tick
} from "./types";
import { authorized, json } from "./security";
import { AccountCoordinator } from "./coordinator";
import {
  agentStatusSelect,
  insertSystemEvent,
  marketLatestSelect,
  marketLatestUpsert,
  tableColumns
} from "./db_compat";
import {
  SCANNER_STATES,
  latestResults,
  pruneScanner,
  recordAndScan,
  scannerStatus
} from "./scanner_store";
import {
  checkLatestSignals,
  latestRiskResults,
  pruneRiskData,
  riskStatus,
  saveNewsCalendar,
  savePositionSnapshot
} from "./risk_store";
import {
  latestPositionSizes,
  positionSizerStatus,
  prunePositionSizingData,
  saveSizingInputs,
  sizeEligibleSignals
} from "./position_sizer_store";

export { AccountCoordinator };

const AGENTS = [
  "SCANNER",
  "RISK_CHECK",
  "SIZER",
  "EXECUTOR",
  "LOGGER",
  "EQUITY"
];

const now = () => new Date().toISOString();

async function coordinator(env: Env) {
  const id = env.ACCOUNT_COORDINATOR.idFromName("exness-demo-primary");
  return env.ACCOUNT_COORDINATOR.get(id);
}

async function requireAuth(request: Request, env: Env) {
  return authorized(request, env)
    ? null
    : json({ error: "Unauthorized" }, 401);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {

    const url = new URL(request.url);

    // HEALTH CHECK
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "AI Trading WarRoom Cloudflare",
        time: now(),
        execution_enabled: false
      });
    }

    if (url.pathname.startsWith("/api/")) {

      // AUTHENTICATION FOR POST REQUESTS
      if (request.method === "POST") {
        const denied = await requireAuth(request, env);
        if (denied) return denied;
      }

      // =====================================================
      // DETERMINISTIC SCANNER (research candidates only)
      // Unlike other GET routes these require x-api-key: they expose
      // internal analysis and must not be public.
      // =====================================================
      if (
        url.pathname === "/api/v1/scanner/status" &&
        request.method === "GET"
      ) {
        const denied = await requireAuth(request, env);
        if (denied) return denied;

        return json(await scannerStatus(env));
      }

      if (
        url.pathname === "/api/v1/scanner/latest" &&
        request.method === "GET"
      ) {
        const denied = await requireAuth(request, env);
        if (denied) return denied;

        const symbol = url.searchParams.get("symbol") || undefined;
        if (symbol && !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) {
          return json({ error: "Invalid symbol" }, 422);
        }

        const stateParam = url.searchParams.get("state");
        const states = stateParam
          ? stateParam.toUpperCase().split(",").map(s => s.trim())
          : undefined;
        if (
          states &&
          !states.every(s => (SCANNER_STATES as readonly string[]).includes(s))
        ) {
          return json({
            error: `state must be one of ${SCANNER_STATES.join(",")}`
          }, 422);
        }

        const items = await latestResults(env, { symbol, states });
        return json({
          items,
          count: items.length,
          advisory_only: true,
          execution_enabled: false
        });
      }

      // =====================================================
      // DETERMINISTIC RISK CHECKER (paper-review gate only)
      // =====================================================
      if (
        url.pathname === "/api/v1/risk/status" &&
        request.method === "GET"
      ) {
        const denied = await requireAuth(request, env);
        if (denied) return denied;
        return json(await riskStatus(env));
      }

      if (
        url.pathname === "/api/v1/risk/latest" &&
        request.method === "GET"
      ) {
        const denied = await requireAuth(request, env);
        if (denied) return denied;
        const symbol = url.searchParams.get("symbol") || undefined;
        if (symbol && !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) {
          return json({ error: "Invalid symbol" }, 422);
        }
        const decision = url.searchParams.get("decision") || undefined;
        if (
          decision &&
          !["ELIGIBLE_FOR_PAPER_REVIEW", "REJECTED"].includes(decision)
        ) {
          return json({
            error: "decision must be ELIGIBLE_FOR_PAPER_REVIEW or REJECTED"
          }, 422);
        }
        const items = await latestRiskResults(env, { symbol, decision });
        return json({
          items,
          count: items.length,
          advisory_only: true,
          execution_enabled: false
        });
      }

      // =====================================================
      // POSITION SIZER (paper-review calculation only)
      // =====================================================
      if (
        url.pathname === "/api/v1/sizer/status" &&
        request.method === "GET"
      ) {
        const denied = await requireAuth(request, env);
        if (denied) return denied;
        return json(await positionSizerStatus(env));
      }

      if (
        url.pathname === "/api/v1/sizer/latest" &&
        request.method === "GET"
      ) {
        const denied = await requireAuth(request, env);
        if (denied) return denied;
        const symbol = url.searchParams.get("symbol") || undefined;
        if (symbol && !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) {
          return json({ error: "Invalid symbol" }, 422);
        }
        const decision = url.searchParams.get("decision") || undefined;
        if (
          decision &&
          !["SIZED_FOR_PAPER_REVIEW", "REJECTED"].includes(decision)
        ) {
          return json({
            error: "decision must be SIZED_FOR_PAPER_REVIEW or REJECTED"
          }, 422);
        }
        const items = await latestPositionSizes(env, { symbol, decision });
        return json({
          items,
          count: items.length,
          advisory_only: true,
          execution_enabled: false
        });
      }

      // =====================================================
      // AGENTS API
      // =====================================================
      if (
        url.pathname === "/api/v1/agents" &&
        request.method === "GET"
      ) {
        const query = agentStatusSelect(
          await tableColumns(env.DB, "agent_status")
        );
        if (!query) {
          return json({ error: "Unsupported agent_status schema" }, 503);
        }
        const result = await env.DB.prepare(query).all();

        return json({
          agents: result.results,
          count: result.results.length,
          execution_enabled: false
        });
      }

      // =====================================================
      // MT5 BRIDGE HEARTBEAT
      // =====================================================
      if (
        url.pathname === "/api/v1/bridge/heartbeat" &&
        request.method === "POST"
      ) {
        let body: Heartbeat;

        try {
          body = await request.json<Heartbeat>();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        if (body.trade_mode !== 0) {
          return json({
            error: "Only MT5 DEMO accounts are accepted by Phase 1 bridge policy"
          }, 403);
        }

        // The bridge intentionally does not transmit the MT5 account login,
        // and equity_snapshots has no account column, so account_login is
        // optional (stored in bridge_heartbeats only if a bridge sends it).
        for (const field of ["balance", "equity"] as const) {
          const v = body[field];
          if (v !== undefined && !Number.isFinite(v)) {
            return json({ error: `Invalid ${field}` }, 422);
          }
        }

        await env.DB.prepare(`
          INSERT INTO bridge_heartbeats
          (
            terminal_name,
            account_server,
            account_login,
            connected,
            balance,
            equity,
            currency,
            trade_mode,
            received_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          body.terminal_name || "Windows MT5",
          body.account_server || null,
          body.account_login || null,
          body.connected ? 1 : 0,
          body.balance ?? null,
          body.equity ?? null,
          body.currency ?? null,
          body.trade_mode ?? null,
          now()
        ).run();

        if (
          body.balance !== undefined ||
          body.equity !== undefined
        ) {
          const equityColumns = await tableColumns(env.DB, "equity_snapshots");
          // Legacy databases require an account_id, which the telemetry-only
          // bridge deliberately does not send. The values remain available in
          // bridge_heartbeats until the account schema is reconciled.
          if (!equityColumns.has("account_id")) {
            await env.DB.prepare(`
              INSERT INTO equity_snapshots
              (
                balance,
                equity,
                floating_pnl,
                currency,
                captured_at
              )
              VALUES (?, ?, ?, ?, ?)
            `).bind(
              body.balance ?? null,
              body.equity ?? null,
              body.equity !== undefined &&
              body.balance !== undefined
                ? body.equity - body.balance
                : null,
              body.currency ?? null,
              now()
            ).run();
          }
        }

        return json({
          accepted: true,
          execution_enabled: false
        });
      }

      // =====================================================
      // MT5 ECONOMIC CALENDAR SNAPSHOT
      // =====================================================
      if (
        url.pathname === "/api/v1/bridge/news-calendar" &&
        request.method === "POST"
      ) {
        const contentLength = Number(
          request.headers.get("content-length") || 0
        );
        if (contentLength > 128 * 1024) {
          return json({ error: "Payload too large" }, 413);
        }

        let body: NewsCalendarPayload;
        try {
          body = await request.json<NewsCalendarPayload>();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        if (
          !body ||
          typeof body !== "object" ||
          (body.error !== undefined &&
            body.error !== null &&
            typeof body.error !== "string") ||
          (typeof body.error === "string" && body.error.length > 250) ||
          typeof body.available !== "boolean" ||
          typeof body.generated_at !== "string" ||
          !Number.isFinite(Date.parse(body.generated_at)) ||
          !Array.isArray(body.events) ||
          body.events.length > 500
        ) {
          return json({ error: "Invalid calendar snapshot" }, 422);
        }
        if (!body.available && body.events.length) {
          return json({
            error: "Unavailable calendar snapshots must not include events"
          }, 422);
        }

        for (const event of body.events) {
          if (
            !event ||
            typeof event !== "object" ||
            typeof event.event_id !== "string" ||
            !event.event_id ||
            event.event_id.length > 64 ||
            typeof event.name !== "string" ||
            !event.name ||
            event.name.length > 200 ||
            typeof event.currency !== "string" ||
            !/^[A-Z]{3}$/.test(event.currency) ||
            event.importance !== "HIGH" ||
            typeof event.scheduled_at !== "string" ||
            !Number.isFinite(Date.parse(event.scheduled_at))
          ) {
            return json({ error: "Invalid high-impact calendar event" }, 422);
          }
        }

        const result = await saveNewsCalendar(env, body);
        return json({
          accepted: true,
          ...result,
          execution_enabled: false
        });
      }

      // =====================================================
      // MT5 OPEN POSITION SNAPSHOT (read-only telemetry)
      // =====================================================
      if (
        url.pathname === "/api/v1/bridge/positions" &&
        request.method === "POST"
      ) {
        const contentLength = Number(
          request.headers.get("content-length") || 0
        );
        if (contentLength > 64 * 1024) {
          return json({ error: "Payload too large" }, 413);
        }
        let body: PositionSnapshotPayload;
        try {
          body = await request.json<PositionSnapshotPayload>();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.captured_at !== "string" ||
          !Number.isFinite(Date.parse(body.captured_at)) ||
          !Array.isArray(body.positions) ||
          body.positions.length > 100
        ) {
          return json({ error: "Invalid position snapshot" }, 422);
        }
        for (const position of body.positions) {
          if (
            !position ||
            typeof position !== "object" ||
            typeof position.symbol !== "string" ||
            !position.symbol ||
            position.symbol.length > 32 ||
            typeof position.direction !== "string" ||
            !["BUY", "SELL"].includes(position.direction) ||
            !Number.isFinite(position.volume) ||
            position.volume <= 0
          ) {
            return json({ error: "Invalid open position" }, 422);
          }
        }
        const result = await savePositionSnapshot(env, body);
        return json({
          accepted: true,
          ...result,
          execution_enabled: false
        });
      }

      // =====================================================
      // MT5 M1 ATR AND CONTRACT-SPEC SNAPSHOT
      // =====================================================
      if (
        url.pathname === "/api/v1/bridge/sizing-inputs" &&
        request.method === "POST"
      ) {
        const contentLength = Number(
          request.headers.get("content-length") || 0
        );
        if (contentLength > 256 * 1024) {
          return json({ error: "Payload too large" }, 413);
        }
        let body: SizingInputsPayload;
        try {
          body = await request.json<SizingInputsPayload>();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.captured_at !== "string" ||
          !Number.isFinite(Date.parse(body.captured_at)) ||
          !Array.isArray(body.symbols) ||
          body.symbols.length < 1 ||
          body.symbols.length > 10
        ) {
          return json({ error: "Invalid position-sizing snapshot" }, 422);
        }

        const seenSymbols = new Set<string>();
        for (const item of body.symbols) {
          if (
            !item ||
            typeof item !== "object" ||
            typeof item.symbol !== "string" ||
            !/^[A-Za-z0-9._-]{1,32}$/.test(item.symbol) ||
            seenSymbols.has(item.symbol.toUpperCase()) ||
            typeof item.available !== "boolean"
          ) {
            return json({ error: "Invalid sizing symbol entry" }, 422);
          }
          seenSymbols.add(item.symbol.toUpperCase());
          if (item.error != null && (
            typeof item.error !== "string" ||
            item.error.length > 200
          )) {
            return json({ error: "Invalid sizing-input error detail" }, 422);
          }
          if (!Array.isArray(item.candles)) {
            return json({ error: "Sizing candles must be an array" }, 422);
          }
          if (!item.available) {
            if (
              item.candles.length !== 0 ||
              item.spec !== null
            ) {
              return json({
                error: "Unavailable symbols must not include sizing data"
              }, 422);
            }
            continue;
          }
          if (
            !Array.isArray(item.candles) ||
            item.candles.length !== 29 ||
            !item.spec ||
            typeof item.spec !== "object"
          ) {
            return json({
              error: "Available symbols require 29 M1 candles and a symbol spec"
            }, 422);
          }
          for (const candle of item.candles) {
            if (
              !candle ||
              typeof candle.time !== "string" ||
              !Number.isFinite(Date.parse(candle.time)) ||
              !Number.isFinite(candle.high) ||
              !Number.isFinite(candle.low) ||
              !Number.isFinite(candle.close) ||
              candle.low <= 0 ||
              candle.high < candle.low ||
              candle.close < candle.low ||
              candle.close > candle.high
            ) {
              return json({ error: "Invalid M1 candle" }, 422);
            }
          }
          const specValues = [
            item.spec.tick_size,
            item.spec.tick_value_loss,
            item.spec.volume_min,
            item.spec.volume_max,
            item.spec.volume_step
          ];
          if (
            !specValues.every(value => Number.isFinite(value) && value > 0) ||
            item.spec.volume_max < item.spec.volume_min
          ) {
            return json({ error: "Invalid MT5 symbol contract spec" }, 422);
          }
        }

        const result = await saveSizingInputs(env, body);
        return json({
          accepted: true,
          ...result,
          execution_enabled: false
        });
      }

      // =====================================================
      // MT5 MARKET BATCH
      // =====================================================
      if (
        url.pathname === "/api/v1/bridge/market-batch" &&
        request.method === "POST"
      ) {
        const contentLength = Number(
          request.headers.get("content-length") || 0
        );

        if (contentLength > 64 * 1024) {
          return json({ error: "Payload too large" }, 413);
        }

        let body: MarketBatch;

        try {
          body = await request.json<MarketBatch>();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        if (
          !Array.isArray(body.ticks) ||
          body.ticks.length < 1 ||
          body.ticks.length > 10
        ) {
          return json({
            error: "ticks must contain 1 to 10 items"
          }, 422);
        }

        for (const tick of body.ticks) {
          if (
            !tick.symbol ||
            typeof tick.symbol !== "string" ||
            tick.symbol.length > 32
          ) {
            return json({ error: "Invalid symbol" }, 422);
          }

          if (
            !Number.isFinite(tick.bid) ||
            !Number.isFinite(tick.ask) ||
            tick.bid! <= 0 ||
            tick.ask! < tick.bid!
          ) {
            return json({
              error: `Invalid bid/ask for ${tick.symbol}`
            }, 422);
          }

          if (
            tick.last !== undefined &&
            !Number.isFinite(tick.last)
          ) {
            return json({
              error: `Invalid last price for ${tick.symbol}`
            }, 422);
          }
        }

        const receivedAt = now();

        await env.MARKET_INGEST.send({
          batch_id: body.batch_id || crypto.randomUUID(),
          received_at: receivedAt,
          ticks: body.ticks
        });

        return json({
          accepted: true,
          queued: true,
          tick_count: body.ticks.length,
          execution_enabled: false
        }, 202);
      }

      // =====================================================
      // BACKWARD-COMPATIBLE SINGLE MARKET SNAPSHOT
      // =====================================================
      if (
        url.pathname === "/api/v1/bridge/market-snapshot" &&
        request.method === "POST"
      ) {
        const body = await request.json<Tick>();

        if (!body.symbol || body.symbol.length > 32) {
          return json({ error: "Invalid symbol" }, 422);
        }

        if (
          body.bid !== undefined &&
          body.ask !== undefined &&
          body.ask < body.bid
        ) {
          return json({
            error: "Ask cannot be lower than bid"
          }, 422);
        }

        await env.MARKET_INGEST.send({
          ...body,
          received_at: now()
        });

        return json({
          accepted: true,
          queued: true,
          execution_enabled: false
        }, 202);
      }

      // =====================================================
      // MT5 BRIDGE STATUS
      // =====================================================
      if (
        url.pathname === "/api/v1/bridge/status" &&
        request.method === "GET"
      ) {
        // This route is unauthenticated (the dashboard polls it), so it
        // returns liveness only. Account login, server, balance and equity
        // stay in D1 and are intentionally not exposed here.
        const row = await env.DB.prepare(`
          SELECT terminal_name, connected, trade_mode, received_at
          FROM bridge_heartbeats
          ORDER BY id DESC
          LIMIT 1
        `).first<any>();

        if (!row) {
          return json({
            connected: false,
            fresh: false
          });
        }

        const age =
          (Date.now() - Date.parse(row.received_at)) / 1000;

        return json({
          terminal_name: row.terminal_name,
          connected: !!row.connected,
          demo: Number(row.trade_mode) === 0,
          received_at: row.received_at,
          age_seconds: Math.round(age),
          fresh: age <= Number(env.BRIDGE_STALE_SECONDS || 45)
        });
      }

      // =====================================================
      // MARKET LATEST
      // =====================================================
      if (
        url.pathname === "/api/v1/market/latest" &&
        request.method === "GET"
      ) {
        const query = marketLatestSelect(
          await tableColumns(env.DB, "market_latest")
        );
        if (!query) {
          return json({ error: "Unsupported market_latest schema" }, 503);
        }
        const rows = await env.DB.prepare(query).all<{
          symbol: string;
          bid: number | null;
          ask: number | null;
          last: number | null;
          tick_time: string | null;
          received_at: string | null;
        }>();
        const latestBySymbol = new Map(
          rows.results.map(row => [row.symbol, row])
        );
        const observations = await env.DB.prepare(`
          SELECT o.symbol, o.bid, o.ask, o.tick_time, o.received_at
          FROM market_observations o
          WHERE o.id = (
            SELECT MAX(newest.id)
            FROM market_observations newest
            WHERE newest.symbol = o.symbol
          )
          ORDER BY o.symbol
        `).all<{
          symbol: string;
          bid: number;
          ask: number;
          tick_time: string | null;
          received_at: string;
        }>();
        for (const observation of observations.results) {
          const current = latestBySymbol.get(observation.symbol);
          if (
            !current ||
            !current.received_at ||
            observation.received_at >= current.received_at
          ) {
            latestBySymbol.set(observation.symbol, {
              ...observation,
              last: null
            });
          }
        }

        return json({
          items: [...latestBySymbol.values()].sort((a, b) =>
            a.symbol.localeCompare(b.symbol)
          )
        });
      }

      // =====================================================
      // SYSTEM CONFIG
      // =====================================================
      if (
        url.pathname === "/api/v1/system/config" &&
        request.method === "GET"
      ) {
        return json({
          app_env: env.APP_ENV,
          paper_mode: env.PAPER_MODE === "true",
          trading_enabled: env.TRADING_ENABLED === "true",
          execution_enabled: false,

          risk: {
            max_risk_per_trade_pct:
              Number(env.MAX_RISK_PER_TRADE_PCT || 0.25),

            max_daily_loss_pct:
              Number(env.MAX_DAILY_LOSS_PCT || 2),

            max_drawdown_pct:
              Number(env.MAX_DRAWDOWN_PCT || 5)
          }
        });
      }

      // =====================================================
      // ACCOUNT CONTROL
      // =====================================================
      if (
        url.pathname.startsWith("/api/v1/control/") &&
        request.method === "POST"
      ) {
        const action = url.pathname.split("/").pop();

        if (
          !["pause", "resume", "kill"].includes(action || "")
        ) {
          return json({ error: "Unknown action" }, 404);
        }

        const stub = await coordinator(env);

        return await stub.fetch(
          "https://coordinator/" + action,
          { method: "POST" }
        );
      }

      // =====================================================
      // TRADING EXECUTION LOCK
      // =====================================================
      if (
        url.pathname === "/api/v1/trading/execute" &&
        request.method === "POST"
      ) {
        return json({
          error: "Execution locked in Phase 1"
        }, 423);
      }

      // =====================================================
      // TELEGRAM TEST
      // =====================================================
      if (
        url.pathname === "/api/v1/telegram/test" &&
        request.method === "POST"
      ) {
        if (
          !env.TELEGRAM_BOT_TOKEN ||
          !env.TELEGRAM_CHAT_ID
        ) {
          return json({
            sent: false,
            reason: "Telegram secrets not configured"
          }, 400);
        }

        const resp = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: "AI Trading WarRoom Cloudflare: test notification. Phase 1 telemetry only."
            })
          }
        );

        return json({
          sent: resp.ok
        }, resp.ok ? 200 : 502);
      }

      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  // =======================================================
  // QUEUE CONSUMER
  // =======================================================
  async queue(
    batch: MessageBatch<any>,
    env: Env
  ): Promise<void> {

    // -------------------------------------------------------
    // MARKET INGEST QUEUE
    // -------------------------------------------------------
    if (batch.queue === "warroom-market-ingest") {

      const items: (Tick & {
        received_at?: string
      })[] = [];

      for (const message of batch.messages) {
        const payload = message.body as
          | (Tick & { received_at?: string })
          | MarketBatch;

        if (
          "ticks" in payload &&
          Array.isArray(payload.ticks)
        ) {
          for (const tick of payload.ticks) {
            items.push({
              ...tick,
              received_at: payload.received_at
            });
          }
        } else {
          items.push(
            payload as Tick & { received_at?: string }
          );
        }
      }

      try {
        const received = now();
        const day = received.slice(0, 10);

        const firstId =
          batch.messages[0]?.id || crypto.randomUUID();

        const key =
          `market-batches/${day}/${firstId}.jsonl`;

        const body =
          items.map(item => JSON.stringify(item)).join("\n") + "\n";

        await env.MARKET_ARCHIVE.put(key, body, {
          httpMetadata: {
            contentType: "application/x-ndjson"
          }
        });

        const marketColumns = await tableColumns(env.DB, "market_latest");
        const marketUpsert = marketLatestUpsert(marketColumns);
        if (!marketUpsert) {
          throw new Error("Unsupported market_latest schema");
        }
        const instrumentColumns = marketUpsert.legacy
          ? await tableColumns(env.DB, "instruments")
          : new Set<string>();
        const knownSymbols = new Set<string>();
        if (marketUpsert.legacy && instrumentColumns.has("symbol")) {
          const known = await env.DB.prepare(
            "SELECT symbol FROM instruments"
          ).all<{ symbol: string }>();
          for (const row of known.results) knownSymbols.add(row.symbol);
        }

        const statements = items.flatMap(item => {
          const itemReceived =
            item.received_at || received;

          if (
            marketUpsert.legacy &&
            (!knownSymbols.has(item.symbol) ||
              !Number.isFinite(item.bid) ||
              !Number.isFinite(item.ask) ||
              item.bid! <= 0 ||
              item.ask! < item.bid!)
          ) {
            return [];
          }

          if (marketUpsert.legacy) {
            const last = item.last ?? (item.bid! + item.ask!) / 2;
            return [env.DB.prepare(marketUpsert.sql).bind(
              item.symbol,
              item.bid,
              item.ask,
              last,
              last,
              itemReceived
            )];
          }
          return [env.DB.prepare(marketUpsert.sql).bind(
            item.symbol,
            item.bid ?? null,
            item.ask ?? null,
            item.last ?? null,
            item.time ?? null,
            itemReceived
          )];
        });

        if (statements.length) {
          await env.DB.batch(statements);
        }

        for (const message of batch.messages) {
          message.ack();
        }

        // Scanner runs AFTER ingestion is committed and acked. It is derived
        // data, so a scanner failure must never cause market ingestion to be
        // retried; it is logged and recomputed from the next batch.
        try {
          const scan = await recordAndScan(env, items, received);
          console.log(JSON.stringify({
            event: "scanner_run",
            ...scan
          }));
          try {
            const risk = await checkLatestSignals(env, scan.symbols);
            console.log(JSON.stringify({
              event: "risk_checker_run",
              ...risk
            }));
            try {
              const sizing = await sizeEligibleSignals(env, scan.symbols);
              console.log(JSON.stringify({
                event: "position_sizer_run",
                ...sizing
              }));
            } catch (sizerErr) {
              console.error(
                "POSITION_SIZER_FAILURE",
                sizerErr instanceof Error ? sizerErr.message : String(sizerErr)
              );
            }
          } catch (riskErr) {
            console.error(
              "RISK_CHECKER_FAILURE",
              riskErr instanceof Error ? riskErr.message : String(riskErr)
            );
          }
        } catch (scanErr) {
          const message =
            scanErr instanceof Error ? scanErr.message : String(scanErr);
          console.error("SCANNER_FAILURE", message);
          try {
            await insertSystemEvent(env.DB, {
              level: "ERROR",
              event_type: "SCANNER_FAILURE",
              message: "Deterministic scanner failed",
              payload: JSON.stringify({ error: message }),
              created_at: now()
            });
          } catch {
            // logging must never throw out of the queue handler
          }
        }

      } catch (err) {
        // IMPROVED D1 ERROR LOGGING
        const errorDetails = err instanceof Error
          ? {
              name: err.name,
              message: err.message,
              stack: err.stack
            }
          : {
              name: "UnknownError",
              message: String(err)
            };

        console.error(
          "MARKET_QUEUE_D1_FAILURE",
          JSON.stringify({
            ...errorDetails,
            batchSize: batch.messages.length,
            itemCount: items.length,
            symbols: items.map(item => item.symbol)
          })
        );

        // Retry failed messages
        for (const message of batch.messages) {
          message.retry();
        }
      }

      return;
    }

    // -------------------------------------------------------
    // AGENT TASK QUEUE
    // -------------------------------------------------------
    if (batch.queue === "warroom-agent-tasks") {

      for (const message of batch.messages) {
        try {
          const task = message.body as {
            agent?: string;
            task_id?: string;
            type?: string;
          };

          console.log(JSON.stringify({
            event: "agent_task_received",
            task
          }));

          // Phase 1: validate and log tasks.
          // Autonomous strategy reasoning comes in Phase 2.

          await insertSystemEvent(env.DB, {
            level: "INFO",
            event_type: "AGENT_TASK",
            message: "Agent task received",
            payload: JSON.stringify(task),
            created_at: now()
          });

          message.ack();

        } catch (err) {
          console.error("agent task failed", err);
          message.retry();
        }
      }
    }
  },

  // =======================================================
  // SCHEDULED TASK / CRON
  // =======================================================
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {

    ctx.waitUntil((async () => {

      const row = await env.DB.prepare(`
        SELECT received_at
        FROM bridge_heartbeats
        ORDER BY id DESC
        LIMIT 1
      `).first<any>();

      const age = row
        ? (Date.now() - Date.parse(row.received_at)) / 1000
        : Infinity;

      if (
        age > Number(env.BRIDGE_STALE_SECONDS || 45)
      ) {
        await insertSystemEvent(env.DB, {
          level: "WARN",
          event_type: "BRIDGE_STALE",
          message: "Windows MT5 bridge heartbeat is stale",
          created_at: now()
        });
      }

      // Retention for scanner history (observations 48h, results 14d).
      try {
        await pruneScanner(env);
      } catch (err) {
        console.error(
          "SCANNER_PRUNE_FAILURE",
          err instanceof Error ? err.message : String(err)
        );
      }
      try {
        await pruneRiskData(env);
      } catch (err) {
        console.error(
          "RISK_RETENTION_FAILURE",
          err instanceof Error ? err.message : String(err)
        );
      }
      try {
        await prunePositionSizingData(env);
      } catch (err) {
        console.error(
          "POSITION_SIZER_RETENTION_FAILURE",
          err instanceof Error ? err.message : String(err)
        );
      }

      console.log(JSON.stringify({
        event: "warroom_cron",
        cron: controller.cron,
        bridge_age_seconds: age
      }));

    })());
  }
};
