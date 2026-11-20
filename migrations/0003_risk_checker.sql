-- Risk Checker inputs and audit trail. No order or trade-intent tables are used.

CREATE TABLE IF NOT EXISTS news_calendar_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  available INTEGER NOT NULL,
  source_generated_at TEXT,
  received_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS news_calendar_events (
  event_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  name TEXT NOT NULL,
  importance TEXT NOT NULL CHECK (importance = 'HIGH'),
  scheduled_at TEXT NOT NULL,
  PRIMARY KEY (event_id, currency, scheduled_at)
);

CREATE INDEX IF NOT EXISTS idx_news_calendar_time_currency
  ON news_calendar_events(scheduled_at, currency);

CREATE TABLE IF NOT EXISTS risk_position_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  position_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_risk_position_snapshots_received
  ON risk_position_snapshots(received_at DESC);

CREATE TABLE IF NOT EXISTS risk_open_positions (
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
  volume REAL NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_risk_open_positions_snapshot_symbol
  ON risk_open_positions(snapshot_id, symbol);

CREATE TABLE IF NOT EXISTS risk_check_results (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  scanner_state TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN ('ELIGIBLE_FOR_PAPER_REVIEW', 'REJECTED')
  ),
  reasons_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  as_of TEXT,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_risk_results_symbol_checked
  ON risk_check_results(symbol, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_results_decision_checked
  ON risk_check_results(decision, checked_at DESC);
