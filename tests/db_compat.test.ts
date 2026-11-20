import test from "node:test";
import assert from "node:assert/strict";
import {
  agentStatusSelect,
  agentStatusUpdate,
  marketLatestSelect,
  marketLatestUpsert,
  scannerAgentStatusUpdate,
  systemEventInsert
} from "../src/db_compat.ts";

let DatabaseSync: any = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // node:sqlite is unavailable on older Node versions.
}

function columns(db: any, table: string): Set<string> {
  return new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => row.name)
  );
}

test(
  "agent registry queries support current and legacy D1 schemas",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agent_status (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        error_message TEXT,
        strategy_name TEXT
      );
      INSERT INTO agent_status(agent_id, status, last_heartbeat, metadata)
      VALUES ('SCANNER', 'running', '2026-11-20T03:00:00Z', 'legacy details');
    `);
    const legacyQuery = agentStatusSelect(columns(db, "agent_status"));
    assert.ok(legacyQuery);
    assert.deepEqual(db.prepare(legacyQuery).all().map((row: any) => ({ ...row })), [{
      name: "SCANNER",
      status: "running",
      detail: "legacy details",
      last_seen_at: "2026-11-20T03:00:00Z"
    }]);

    db.exec("DROP TABLE agent_status");
    db.exec(`
      CREATE TABLE agent_status (
        agent_name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_seen_at TEXT,
        detail TEXT
      );
      INSERT INTO agent_status(agent_name, status, last_seen_at, detail)
      VALUES ('SCANNER', 'READY', '2026-11-20T03:00:00Z', 'scanner active');
    `);
    const currentQuery = agentStatusSelect(columns(db, "agent_status"));
    assert.ok(currentQuery);
    assert.deepEqual(db.prepare(currentQuery).all().map((row: any) => ({ ...row })), [{
      name: "SCANNER",
      status: "READY",
      detail: "scanner active",
      last_seen_at: "2026-11-20T03:00:00Z"
    }]);
  }
);

test(
  "market latest reads and upserts support current and legacy D1 schemas",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE market_latest (
        symbol TEXT PRIMARY KEY,
        bid REAL NOT NULL,
        ask REAL NOT NULL,
        last_price REAL NOT NULL,
        updated_at TEXT NOT NULL,
        last REAL
      );
    `);
    const legacyColumns = columns(db, "market_latest");
    const legacyUpsert = marketLatestUpsert(legacyColumns);
    const legacySelect = marketLatestSelect(legacyColumns);
    assert.ok(legacyUpsert?.legacy);
    assert.ok(legacySelect);
    db.prepare(legacyUpsert.sql).run(
      "EURUSD", 1.1, 1.1002, 1.1001, 1.1001, "2026-11-20T03:00:00Z"
    );
    assert.deepEqual(db.prepare(legacySelect).all().map((row: any) => ({ ...row })), [{
      symbol: "EURUSD",
      bid: 1.1,
      ask: 1.1002,
      last: 1.1001,
      tick_time: null,
      received_at: "2026-11-20T03:00:00Z"
    }]);

    db.exec("DROP TABLE market_latest");
    db.exec(`
      CREATE TABLE market_latest (
        symbol TEXT PRIMARY KEY,
        bid REAL,
        ask REAL,
        last REAL,
        tick_time TEXT,
        received_at TEXT NOT NULL
      );
    `);
    const currentColumns = columns(db, "market_latest");
    const currentUpsert = marketLatestUpsert(currentColumns);
    const currentSelect = marketLatestSelect(currentColumns);
    assert.ok(currentUpsert && !currentUpsert.legacy);
    assert.ok(currentSelect);
    db.prepare(currentUpsert.sql).run(
      "EURUSD", 1.1, 1.1002, 1.1001, "2026-11-20T03:00:00Z",
      "2026-11-20T03:00:00Z"
    );
    assert.equal(db.prepare(currentSelect).get().received_at, "2026-11-20T03:00:00Z");
  }
);

test(
  "system event inserts satisfy legacy and current required columns",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  () => {
    const event = {
      level: "ERROR",
      event_type: "SCANNER_FAILURE",
      message: "Scanner failed",
      payload: "{\"reason\":\"test\"}",
      created_at: "2026-11-20T03:00:00Z"
    };
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE system_events (
        component TEXT NOT NULL,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const legacy = systemEventInsert(columns(db, "system_events"), event);
    db.prepare(legacy.sql).run(...legacy.values);
    assert.equal(db.prepare("SELECT component FROM system_events").get().component, "worker");

    db.exec("DROP TABLE system_events");
    db.exec(`
      CREATE TABLE system_events (
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const current = systemEventInsert(columns(db, "system_events"), event);
    db.prepare(current.sql).run(...current.values);
    assert.equal(
      db.prepare("SELECT payload_json FROM system_events").get().payload_json,
      event.payload
    );
  }
);

test(
  "scanner processing marks the matching legacy or current agent row active",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agent_status (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        last_heartbeat TEXT,
        strategy_name TEXT,
        metadata TEXT,
        error_message TEXT
      );
      INSERT INTO agent_status(agent_id) VALUES ('SCANNER');
    `);
    const legacy = scannerAgentStatusUpdate(
      columns(db, "agent_status"),
      "2026-11-20T03:00:00Z",
      "SNAPSHOT_MOMENTUM_V1",
      "research candidates only"
    );
    assert.ok(legacy);
    db.prepare(legacy.sql).run(...legacy.values);
    const legacyRow = db.prepare(
      "SELECT status, last_heartbeat, strategy_name, metadata FROM agent_status"
    ).get();
    assert.equal(legacyRow.status, "running");
    assert.equal(legacyRow.last_heartbeat, "2026-11-20T03:00:00Z");
    assert.equal(legacyRow.strategy_name, "SNAPSHOT_MOMENTUM_V1");
    assert.equal(JSON.parse(legacyRow.metadata).execution_enabled, false);

    db.exec("DROP TABLE agent_status");
    db.exec(`
      CREATE TABLE agent_status (
        agent_name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_seen_at TEXT,
        detail TEXT
      );
      INSERT INTO agent_status(agent_name, status) VALUES ('SCANNER', 'IDLE');
    `);
    const current = scannerAgentStatusUpdate(
      columns(db, "agent_status"),
      "2026-11-20T03:01:00Z",
      "SNAPSHOT_MOMENTUM_V1",
      "research candidates only"
    );
    assert.ok(current);
    db.prepare(current.sql).run(...current.values);
    const currentRow = db.prepare(
      "SELECT status, last_seen_at, detail FROM agent_status"
    ).get();
    assert.equal(currentRow.status, "READY");
    assert.equal(currentRow.last_seen_at, "2026-11-20T03:01:00Z");
    assert.equal(currentRow.detail, "research candidates only");
    db.close();
  }
);

test(
  "risk-check status creates a registry row in either schema",
  { skip: DatabaseSync ? false : "node:sqlite unavailable" },
  () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agent_status (
        agent_name TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'IDLE',
        last_seen_at TEXT,
        detail TEXT
      );
    `);
    const current = agentStatusUpdate(
      columns(db, "agent_status"),
      "RISK_CHECK",
      "2026-11-20T03:02:00Z",
      "SNAPSHOT_MOMENTUM_V1",
      "fail-closed screening only"
    );
    assert.ok(current);
    db.prepare(current.sql).run(...current.values);
    const currentRow = db.prepare(
      "SELECT agent_name, status, detail FROM agent_status"
    ).get();
    assert.equal(currentRow.agent_name, "RISK_CHECK");
    assert.equal(currentRow.status, "READY");
    assert.equal(currentRow.detail, "fail-closed screening only");

    db.exec("DROP TABLE agent_status");
    db.exec(`
      CREATE TABLE agent_status (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        last_heartbeat TEXT,
        strategy_name TEXT,
        metadata TEXT,
        error_message TEXT
      );
    `);
    const legacy = agentStatusUpdate(
      columns(db, "agent_status"),
      "RISK_CHECK",
      "2026-11-20T03:03:00Z",
      "SNAPSHOT_MOMENTUM_V1",
      "fail-closed screening only"
    );
    assert.ok(legacy);
    db.prepare(legacy.sql).run(...legacy.values);
    const legacyRow = db.prepare(
      "SELECT agent_id, status, strategy_name, metadata FROM agent_status"
    ).get();
    assert.equal(legacyRow.agent_id, "RISK_CHECK");
    assert.equal(legacyRow.status, "running");
    assert.equal(legacyRow.strategy_name, "SNAPSHOT_MOMENTUM_V1");
    assert.equal(JSON.parse(legacyRow.metadata).execution_enabled, false);
    db.close();
  }
);
