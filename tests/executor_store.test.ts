import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgeTradeIntent,
  claimTradeIntents,
  enqueueEligibleTrades,
  resolveUncertainIntent,
  validResolveRequest
} from "../src/executor.ts";
import type { Database } from "../src/postgres.ts";

let DatabaseSync: any = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // node:sqlite is unavailable on older Node versions.
}

function sqliteDatabase(db: any): Database {
  const statement = (sql: string) => {
    let values: unknown[] = [];
    const self: any = {
      bind(...bound: unknown[]) {
        values = bound;
        return self;
      },
      async first<T>() {
        return (db.prepare(sql).get(...values) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...values) as T[] };
      },
      async run() {
        const result = db.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      }
    };
    return self;
  };
  return {
    prepare: statement,
    async batch(statements: any[]) {
      const results: unknown[] = [];
      db.exec("BEGIN");
      try {
        for (const item of statements) results.push(await item.run());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return results;
    }
  };
}

function setup() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE trade_intents (
      intent_id TEXT PRIMARY KEY,
      signal_id TEXT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'LOCKED',
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dispatched_at TEXT
    );
    CREATE UNIQUE INDEX idx_one_active_symbol ON trade_intents(symbol)
      WHERE status IN ('PENDING','DISPATCHED','EXECUTED','PARTIAL','UNCERTAIN');
    CREATE TABLE trade_history (
      trade_id TEXT PRIMARY KEY,
      broker_ticket TEXT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      volume REAL,
      entry_price REAL,
      exit_price REAL,
      pnl REAL,
      status TEXT NOT NULL,
      opened_at TEXT,
      closed_at TEXT
    );
    CREATE TABLE scanner_results (
      signal_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      strategy TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      state TEXT NOT NULL,
      score REAL,
      as_of TEXT,
      features_json TEXT NOT NULL
    );
    CREATE TABLE risk_check_results (
      signal_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      metrics_json TEXT NOT NULL
    );
    CREATE TABLE position_sizing_results (
      signal_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE TABLE bridge_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connected INTEGER NOT NULL,
      trade_mode INTEGER NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const env: any = {
    DB: sqliteDatabase(raw),
    BRIDGE_STALE_SECONDS: "150",
    TRADING_ENABLED: "false",
    PAPER_MODE: "true"
  };
  const addIntent = (
    id: string,
    status: string,
    opts: { createdAt?: string; dispatchedAt?: string | null; symbol?: string } = {}
  ) =>
    raw.prepare(`
      INSERT INTO trade_intents
        (intent_id, signal_id, symbol, direction, status, idempotency_key,
         payload_json, created_at, dispatched_at)
      VALUES (?, ?, ?, 'BUY', ?, ?, '{}', ?, ?)
    `).run(
      id,
      `sig-${id}`,
      opts.symbol ?? "EURUSDm",
      status,
      `sig-${id}`,
      opts.createdAt ?? new Date().toISOString(),
      opts.dispatchedAt ?? null
    );
  const intentStatus = (id: string) =>
    (raw.prepare("SELECT status FROM trade_intents WHERE intent_id = ?").get(id) as any)?.status;
  const history = (id: string) =>
    raw.prepare("SELECT * FROM trade_history WHERE trade_id = ?").get(id) as any;
  return { raw, env, addIntent, intentStatus, history };
}

const executedAck = (id: string) => ({
  intent_id: id,
  status: "EXECUTED" as const,
  broker_ticket: "555",
  volume: 0.1,
  entry_price: 1.1001,
  retcode: 10009,
  opened_at: "2026-11-23T01:00:00.000Z"
});

const skip = { skip: DatabaseSync ? false : "node:sqlite unavailable" };

test("DISPATCHED expiry is measured from dispatched_at, not created_at", skip, async () => {
  const { env, addIntent, intentStatus } = setup();
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const recent = new Date(Date.now() - 5_000).toISOString();
  const stale = new Date(Date.now() - 600_000).toISOString();
  addIntent("fresh-claim", "DISPATCHED", {
    createdAt: old, dispatchedAt: recent, symbol: "EURUSDm"
  });
  addIntent("stale-claim", "DISPATCHED", {
    createdAt: old, dispatchedAt: stale, symbol: "GBPUSDm"
  });
  addIntent("legacy-claim", "DISPATCHED", {
    createdAt: old, dispatchedAt: null, symbol: "XAUUSDm"
  });

  // The Worker gate is closed, but claim still runs the expiry sweep first.
  const result = await claimTradeIntents(env);
  assert.equal(result.locked, true);
  assert.equal(intentStatus("fresh-claim"), "DISPATCHED");
  assert.equal(intentStatus("stale-claim"), "UNCERTAIN");
  assert.equal(intentStatus("legacy-claim"), "UNCERTAIN");
});

test("a late EXECUTED ack is accepted for an intent already marked UNCERTAIN", skip, async () => {
  const { env, addIntent, intentStatus, history } = setup();
  addIntent("late-1", "UNCERTAIN");

  const result = await acknowledgeTradeIntent(env, executedAck("late-1"));
  assert.deepEqual(result, { accepted: true, duplicate: false });
  assert.equal(intentStatus("late-1"), "EXECUTED");
  const row = history("late-1");
  assert.equal(row.status, "EXECUTED");
  assert.equal(row.broker_ticket, "555");
  assert.equal(row.volume, 0.1);
});

test("UNCERTAIN acks are idempotent and can later be upgraded by the real outcome", skip, async () => {
  const { env, addIntent, intentStatus, history } = setup();
  addIntent("up-1", "DISPATCHED");

  const uncertain = { intent_id: "up-1", status: "UNCERTAIN" as const, message: "no result" };
  assert.deepEqual(await acknowledgeTradeIntent(env, uncertain), {
    accepted: true, duplicate: false
  });
  assert.equal(history("up-1").status, "UNCERTAIN");
  assert.deepEqual(await acknowledgeTradeIntent(env, uncertain), {
    accepted: true, duplicate: true
  });

  assert.deepEqual(await acknowledgeTradeIntent(env, executedAck("up-1")), {
    accepted: true, duplicate: false
  });
  assert.equal(intentStatus("up-1"), "EXECUTED");
  assert.equal(history("up-1").status, "EXECUTED");
  assert.equal(history("up-1").broker_ticket, "555");

  // A repeat of the same definitive ack stays a harmless duplicate.
  assert.deepEqual(await acknowledgeTradeIntent(env, executedAck("up-1")), {
    accepted: true, duplicate: true
  });
});

test("a conflicting ack for a settled intent is still rejected", skip, async () => {
  const { env, addIntent } = setup();
  addIntent("done-1", "DISPATCHED");
  await acknowledgeTradeIntent(env, executedAck("done-1"));
  const result = await acknowledgeTradeIntent(env, {
    intent_id: "done-1", status: "REJECTED", message: "contradiction"
  });
  assert.equal(result.accepted, false);
});

test("resolving NO_FILL releases the symbol lock", skip, async () => {
  const { raw, env, addIntent, intentStatus, history } = setup();
  addIntent("res-1", "UNCERTAIN");
  raw.prepare(`
    INSERT INTO trade_history (trade_id, symbol, direction, status)
    VALUES ('res-1', 'EURUSDm', 'BUY', 'UNCERTAIN')
  `).run();

  // The unique active-symbol index blocks a new intent while UNCERTAIN.
  assert.throws(() => addIntent("blocked", "PENDING"));

  const result = await resolveUncertainIntent(env, {
    intent_id: "res-1", resolution: "NO_FILL", note: "checked MT5"
  });
  assert.deepEqual(result, { resolved: true, status: "REJECTED" });
  assert.equal(intentStatus("res-1"), "REJECTED");
  assert.equal(history("res-1").status, "REJECTED");
  addIntent("unblocked", "PENDING");

  const again = await resolveUncertainIntent(env, {
    intent_id: "res-1", resolution: "NO_FILL"
  });
  assert.equal(again.resolved, false);
  assert.equal(again.code, "NOT_UNCERTAIN");

  const event = raw.prepare(
    "SELECT level, event_type, payload_json FROM system_events WHERE event_type = 'TRADE_INTENT_RESOLVED'"
  ).get() as any;
  assert.equal(event.level, "WARN");
  assert.equal(JSON.parse(event.payload_json).resolution, "NO_FILL");
});

test("resolving FILLED records the order and keeps the symbol locked", skip, async () => {
  const { env, addIntent, intentStatus, history } = setup();
  addIntent("res-2", "UNCERTAIN");

  const result = await resolveUncertainIntent(env, {
    intent_id: "res-2",
    resolution: "FILLED",
    broker_ticket: "777",
    volume: 0.2,
    entry_price: 1.2
  });
  assert.deepEqual(result, { resolved: true, status: "EXECUTED" });
  assert.equal(intentStatus("res-2"), "EXECUTED");
  assert.equal(history("res-2").broker_ticket, "777");
  assert.equal(history("res-2").status, "EXECUTED");
  assert.ok(history("res-2").opened_at);

  const missing = await resolveUncertainIntent(env, {
    intent_id: "does-not-exist", resolution: "NO_FILL"
  });
  assert.equal(missing.code, "NOT_FOUND");
});

test("resolve requests are validated", () => {
  assert.equal(validResolveRequest({ intent_id: "a", resolution: "NO_FILL" }), true);
  assert.equal(validResolveRequest({
    intent_id: "a", resolution: "FILLED",
    broker_ticket: 1, volume: 0.1, entry_price: 1.1
  }), true);
  // FILLED requires ticket, volume and entry price.
  assert.equal(validResolveRequest({ intent_id: "a", resolution: "FILLED" }), false);
  assert.equal(validResolveRequest({
    intent_id: "a", resolution: "FILLED",
    broker_ticket: "1", volume: -1, entry_price: 1.1
  }), false);
  assert.equal(validResolveRequest({ intent_id: "a", resolution: "MAYBE" }), false);
  assert.equal(validResolveRequest({ intent_id: "", resolution: "NO_FILL" }), false);
  assert.equal(validResolveRequest({
    intent_id: "a", resolution: "NO_FILL", note: "x".repeat(501)
  }), false);
});

// --- M5 execution with H1/H4 EMA trend filter -------------------------------

const UP = { ema20: 3, ema50: 2, ema200: 1 };
const DOWN = { ema20: 1, ema50: 2, ema200: 3 };
const FLAT = { ema20: 2, ema50: 1, ema200: 3 };

function coordinatorStub() {
  return {
    idFromName: () => "id",
    get: () => ({
      fetch: async () =>
        new Response(JSON.stringify({ paused: false, kill_switch: false }))
    })
  };
}

function seedSignal(
  raw: any,
  symbol: string,
  timeframe: string,
  state: string,
  features: object,
  opts: { score?: number; asOf?: string; eligible?: boolean } = {}
) {
  const id = `${symbol}:${timeframe}:${opts.asOf ?? "t1"}`;
  const now = new Date().toISOString();
  raw.prepare(`
    INSERT INTO scanner_results
      (signal_id, symbol, timeframe, strategy, strategy_version, state, score, as_of, features_json)
    VALUES (?, ?, ?, 'MULTI_TIMEFRAME_INDICATORS_V1', '1', ?, ?, ?, ?)
  `).run(id, symbol, timeframe, state, opts.score ?? 80, opts.asOf ?? "t1", JSON.stringify(features));
  if (opts.eligible) {
    raw.prepare(
      "INSERT INTO risk_check_results VALUES (?, 'ELIGIBLE_FOR_DEMO_EXECUTION', ?, ?)"
    ).run(id, now, JSON.stringify({ max_spread_bps: 4 }));
    const sell = state === "SELL";
    raw.prepare(
      "INSERT INTO position_sizing_results VALUES (?, 'SIZED_FOR_DEMO_EXECUTION', ?, ?)"
    ).run(id, now, JSON.stringify({
      direction: state,
      metrics: {
        entry_price: 100,
        stop_loss_price: sell ? 102 : 98,
        take_profit_price: sell ? 96 : 104,
        volume: 0.1,
        risk_budget: 25,
        risk_pct_limit: 0.25
      }
    }));
  }
}

test("only M5 signals whose H1 and H4 EMA trends agree become trade intents", skip, async () => {
  const { raw, env } = setup();
  env.ACCOUNT_COORDINATOR = coordinatorStub();
  env.TRADING_ENABLED = "true";
  raw.prepare(
    "INSERT INTO bridge_heartbeats (connected, trade_mode, received_at) VALUES (1, 0, ?)"
  ).run(new Date().toISOString());

  // Aligned BUY: M5 BUY, H1 and H4 uptrend -> trade.
  seedSignal(raw, "EURUSDm", "M5", "BUY", {}, { eligible: true });
  seedSignal(raw, "EURUSDm", "H1", "WATCH", UP);
  seedSignal(raw, "EURUSDm", "H4", "WATCH", UP);
  // Aligned SELL: M5 SELL, H1 and H4 downtrend -> trade.
  seedSignal(raw, "XAUUSDm", "M5", "SELL", {}, { eligible: true });
  seedSignal(raw, "XAUUSDm", "H1", "WATCH", DOWN);
  seedSignal(raw, "XAUUSDm", "H4", "WATCH", DOWN);
  // M5 BUY against a downtrending H4 -> blocked.
  seedSignal(raw, "GBPUSDm", "M5", "BUY", {}, { eligible: true });
  seedSignal(raw, "GBPUSDm", "H1", "WATCH", UP);
  seedSignal(raw, "GBPUSDm", "H4", "WATCH", DOWN);
  // M5 BUY with a mixed (no-trend) H1 -> blocked.
  seedSignal(raw, "USDJPYm", "M5", "BUY", {}, { eligible: true });
  seedSignal(raw, "USDJPYm", "H1", "WATCH", FLAT);
  seedSignal(raw, "USDJPYm", "H4", "WATCH", UP);
  // Missing H4 data (e.g. stale candles) -> blocked.
  seedSignal(raw, "AUDUSDm", "M5", "BUY", {}, { eligible: true });
  seedSignal(raw, "AUDUSDm", "H1", "WATCH", UP);
  // A perfectly aligned M15 signal is never executed.
  seedSignal(raw, "USDCADm", "M15", "BUY", {}, { eligible: true });
  seedSignal(raw, "USDCADm", "H1", "WATCH", UP);
  seedSignal(raw, "USDCADm", "H4", "WATCH", UP);

  const symbols = ["EURUSDm", "XAUUSDm", "GBPUSDm", "USDJPYm", "AUDUSDm", "USDCADm"];
  const result = await enqueueEligibleTrades(env, symbols);
  assert.equal(result.enqueued, 2);
  assert.equal(result.trend_blocked, 3);

  const intents = raw
    .prepare("SELECT symbol, direction FROM trade_intents ORDER BY symbol")
    .all() as Array<{ symbol: string; direction: string }>;
  assert.deepEqual(
    intents.map(row => `${row.symbol}:${row.direction}`),
    ["EURUSDm:BUY", "XAUUSDm:SELL"]
  );
});
