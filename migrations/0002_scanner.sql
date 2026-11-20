-- Deterministic scanner (SNAPSHOT_MOMENTUM_V1): observation history + audit trail.
-- Additive only: does not alter any table from 0001_init.sql.

-- One row per accepted market observation (mid-price series source).
-- UNIQUE makes a retried queue message idempotent (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS market_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  bid REAL NOT NULL,
  ask REAL NOT NULL,
  tick_time TEXT,
  received_at TEXT NOT NULL,
  UNIQUE (symbol, received_at, bid, ask)
);

CREATE INDEX IF NOT EXISTS idx_market_observations_symbol_time
  ON market_observations(symbol, received_at DESC);

-- One row per scanner evaluation, including WATCH / WARMING_UP / REJECTED,
-- so every decision can be audited. signal_id is deterministic
-- (strategy:symbol:as_of) which makes re-evaluation idempotent.
CREATE TABLE IF NOT EXISTS scanner_results (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  state TEXT NOT NULL,
  reject_reason TEXT,
  score REAL,
  as_of TEXT,
  features_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_scanner_results_symbol_asof
  ON scanner_results(symbol, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_scanner_results_state_asof
  ON scanner_results(state, as_of DESC);
