import test from "node:test";
import assert from "node:assert/strict";
import { equityStatus } from "../src/equity.ts";
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
  "equity monitor computes daily performance, drawdown, win rate, and profit factor",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      CREATE TABLE equity_snapshots (
        id INTEGER PRIMARY KEY,
        balance REAL,
        equity REAL,
        floating_pnl REAL,
        currency TEXT,
        captured_at TEXT
      );
      CREATE TABLE trade_history (
        status TEXT,
        pnl REAL,
        closed_at TEXT
      );
      INSERT INTO equity_snapshots VALUES
        (1, 1000, 1000, 0, 'USD', '2026-11-21T23:59:00Z'),
        (2, 995, 990, -5, 'USD', '2026-11-22T00:01:00Z'),
        (3, 1010, 1005, -5, 'USD', '2026-11-22T10:00:00Z');
      INSERT INTO trade_history VALUES
        ('CLOSED', 10, '2026-11-22T01:00:00Z'),
        ('CLOSED', -5, '2026-11-22T02:00:00Z'),
        ('CLOSED', 0, '2026-11-22T03:00:00Z'),
        ('CLOSED', 2, '2026-11-21T12:00:00Z'),
        ('EXECUTED', 50, NULL);
    `);

    const result = await equityStatus(
      sqliteDatabase(raw),
      new Date("2026-11-22T10:00:30Z")
    );
    assert.equal(result.balance, 1010);
    assert.equal(result.equity, 1005);
    assert.equal(result.floating_pl, -5);
    assert.equal(result.daily_pl, 15);
    assert.equal(result.daily_realized_pl, 5);
    assert.equal(result.realized_pl, 7);
    assert.equal(result.max_drawdown_pct, 1);
    assert.ok(Math.abs((result.win_rate_pct ?? 0) - 200 / 3) < 1e-10);
    assert.ok(Math.abs((result.profit_factor ?? 0) - 2.4) < 1e-10);
    assert.equal(result.closed_trades_with_pnl, 4);
    assert.deepEqual(result.equity_curve.map(point => point.equity), [
      1000, 990, 1005
    ]);
    assert.equal(result.execution_enabled, false);
    raw.close();
  }
);

test(
  "equity monitor reports missing snapshots without inventing account values",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      CREATE TABLE equity_snapshots (
        id INTEGER PRIMARY KEY, balance REAL, equity REAL, floating_pnl REAL,
        currency TEXT, captured_at TEXT
      );
      CREATE TABLE trade_history (status TEXT, pnl REAL, closed_at TEXT);
    `);
    const result = await equityStatus(
      sqliteDatabase(raw),
      new Date("2026-11-22T10:00:00Z")
    );
    assert.equal(result.data_available, false);
    assert.equal(result.balance, null);
    assert.equal(result.daily_pl, null);
    assert.equal(result.win_rate_pct, null);
    assert.equal(result.equity_curve.length, 0);
    raw.close();
  }
);
