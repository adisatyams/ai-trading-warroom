CREATE TABLE IF NOT EXISTS agent_status (
  agent_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'READY',
  last_seen_at TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS bridge_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_name TEXT NOT NULL,
  account_server TEXT,
  account_login TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  balance REAL,
  equity REAL,
  currency TEXT,
  trade_mode INTEGER,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_bridge_heartbeat_time
  ON bridge_heartbeats(received_at DESC);

CREATE TABLE IF NOT EXISTS market_latest (
  symbol TEXT PRIMARY KEY,
  bid REAL,
  ask REAL,
  last REAL,
  tick_time TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trading_signals (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  direction TEXT NOT NULL,
  timeframe TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'OBSERVED',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  event_id TEXT PRIMARY KEY,
  signal_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk_pct REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_intents (
  intent_id TEXT PRIMARY KEY,
  signal_id TEXT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'LOCKED',
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_history (
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

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  balance REAL,
  equity REAL,
  floating_pnl REAL,
  currency TEXT,
  captured_at TEXT NOT NULL
);

INSERT OR IGNORE INTO agent_status(agent_name,status,detail) VALUES
('SCANNER','READY','Phase 1 telemetry; strategy engine not enabled'),
('RISK_CHECK','READY','Policy scaffold; fail-closed'),
('SIZER','LOCKED','Awaiting verified broker symbol contract metadata'),
('EXECUTOR','LOCKED','No order execution in Phase 1'),
('LOGGER','READY','System and market event logging'),
('EQUITY','READY','Account telemetry monitoring');
