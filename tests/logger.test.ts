import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGGER_EVENTS_SQL,
  recordClosedTrade,
  validClosedTradeReport
} from "../src/logger.ts";
import type { Database } from "../src/postgres.ts";

let DatabaseSync: any = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // node:sqlite is unavailable on older Node versions.
}

function sqliteDatabase(db: any): Database {
  return {
    prepare(sql) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
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
    },
    async batch() {
      return [];
    }
  };
}

test(
  "logger timeline combines signals, risk rejections, trades, and system events",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE scanner_results (
        signal_id TEXT, symbol TEXT, timeframe TEXT, state TEXT,
        score REAL, entry REAL, stop_loss REAL, take_profit REAL,
        reject_reason TEXT, reasons_json TEXT, as_of TEXT, created_at TEXT
      );
      CREATE TABLE risk_check_results (
        signal_id TEXT, symbol TEXT, timeframe TEXT, decision TEXT,
        reasons_json TEXT, metrics_json TEXT, checked_at TEXT
      );
      CREATE TABLE trade_history (
        trade_id TEXT, broker_ticket TEXT, symbol TEXT, direction TEXT,
        volume REAL, entry_price REAL, exit_price REAL, pnl REAL,
        status TEXT, opened_at TEXT, closed_at TEXT
      );
      CREATE TABLE system_events (
        level TEXT, event_type TEXT, message TEXT, payload_json TEXT,
        created_at TEXT
      );
      INSERT INTO scanner_results VALUES
        ('s1', 'EURUSDm', 'M15', 'BUY', 87, 1.08, 1.07, 1.10,
         NULL, '[]', '2026-11-22T10:00:00Z', '2026-11-22T10:00:00Z');
      INSERT INTO risk_check_results VALUES
        ('s2', 'XAUUSDm', 'M5', 'REJECTED', '["spread too high"]', '{}',
         '2026-11-22T10:01:00Z');
      INSERT INTO trade_history VALUES
        ('t1', '123', 'EURUSDm', 'BUY', 0.1, 1.08, 1.09, 10,
         'CLOSED', '2026-11-22T10:02:00Z', '2026-11-22T10:03:00Z');
      INSERT INTO system_events VALUES
        ('ERROR', 'BRIDGE_STALE', 'Bridge heartbeat is stale', '{}',
         '2026-11-22T10:04:00Z');
    `);

    const rows = db.prepare(LOGGER_EVENTS_SQL).all(10).map((row: any) => ({
      source: row.source,
      event_type: row.event_type,
      message: row.message,
      details: row.details
    }));
    assert.deepEqual(rows.map(row => row.source), [
      "WORKER",
      "EXECUTOR",
      "RISK_CHECK",
      "SCANNER"
    ]);
    assert.equal(rows[2].event_type, "SIGNAL_REJECTED");
    assert.match(rows[2].details, /spread too high/);
    assert.match(rows[1].details, /pnl=10/);
    db.close();
  }
);

test("closed-trade reports require bounded, finite broker data", () => {
  assert.equal(validClosedTradeReport({
    intent_prefix: "0123456789abcdef01234567",
    exit_price: 1.102,
    pnl: -2.5,
    closed_at: "2026-11-22T10:03:00Z",
    close_ticket: "98765"
  }), true);
  assert.equal(validClosedTradeReport({
    intent_prefix: "0123456789abcdef01234567",
    exit_price: Number.NaN,
    pnl: 1,
    closed_at: "2026-11-22T10:03:00Z",
    close_ticket: "98765"
  }), false);
});

test(
  "closed-trade reports update realized P/L idempotently",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      CREATE TABLE trade_intents (intent_id TEXT PRIMARY KEY);
      CREATE TABLE trade_history (
        trade_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, status TEXT NOT NULL,
        exit_price REAL, pnl REAL, closed_at TEXT
      );
      INSERT INTO trade_intents VALUES ('0123456789abcdef01234567-rest');
      INSERT INTO trade_history (trade_id, symbol, status)
      VALUES ('0123456789abcdef01234567-rest', 'EURUSDm', 'EXECUTED');
    `);
    const db = sqliteDatabase(raw);
    const report = {
      intent_prefix: "0123456789abcdef01234567",
      exit_price: 1.102,
      pnl: 18,
      closed_at: "2026-11-22T10:03:00Z",
      close_ticket: "98765"
    };

    assert.deepEqual(await recordClosedTrade(db, report), {
      accepted: true,
      duplicate: false
    });
    assert.deepEqual(await recordClosedTrade(db, report), {
      accepted: true,
      duplicate: true
    });
    const stored = raw.prepare(
      "SELECT exit_price, pnl, status FROM trade_history"
    ).get();
    assert.deepEqual({ ...stored }, {
      exit_price: 1.102,
      pnl: 18,
      status: "CLOSED"
    });
    raw.close();
  }
);
