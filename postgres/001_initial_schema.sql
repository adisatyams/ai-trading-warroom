CREATE TABLE IF NOT EXISTS agent_status (
  agent_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'READY',
  last_seen_at TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS bridge_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  terminal_name TEXT NOT NULL,
  account_server TEXT,
  account_login TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  balance DOUBLE PRECISION,
  equity DOUBLE PRECISION,
  currency TEXT,
  trade_mode INTEGER,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_heartbeat_time
  ON bridge_heartbeats(received_at DESC);

CREATE TABLE IF NOT EXISTS market_latest (
  symbol TEXT PRIMARY KEY,
  bid DOUBLE PRECISION,
  ask DOUBLE PRECISION,
  last DOUBLE PRECISION,
  tick_time TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trading_signals (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  direction TEXT NOT NULL,
  timeframe TEXT,
  score DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'OBSERVED',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  event_id TEXT PRIMARY KEY,
  signal_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk_pct DOUBLE PRECISION,
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
  volume DOUBLE PRECISION,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  pnl DOUBLE PRECISION,
  status TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS system_events (
  id BIGSERIAL PRIMARY KEY,
  level TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id BIGSERIAL PRIMARY KEY,
  balance DOUBLE PRECISION,
  equity DOUBLE PRECISION,
  floating_pnl DOUBLE PRECISION,
  currency TEXT,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_observations (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  bid DOUBLE PRECISION NOT NULL,
  ask DOUBLE PRECISION NOT NULL,
  tick_time TEXT,
  received_at TEXT NOT NULL,
  UNIQUE (symbol, received_at, bid, ask)
);
CREATE INDEX IF NOT EXISTS idx_market_observations_symbol_time
  ON market_observations(symbol, received_at DESC);

CREATE TABLE IF NOT EXISTS market_observation_latest (
  symbol TEXT PRIMARY KEY,
  bid DOUBLE PRECISION NOT NULL,
  ask DOUBLE PRECISION NOT NULL,
  tick_time TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scanner_results (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'M1',
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  state TEXT NOT NULL,
  reject_reason TEXT,
  score DOUBLE PRECISION,
  entry DOUBLE PRECISION,
  stop_loss DOUBLE PRECISION,
  take_profit DOUBLE PRECISION,
  as_of TEXT,
  features_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT
    (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_scanner_results_symbol_asof
  ON scanner_results(symbol, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_results_state_asof
  ON scanner_results(state, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_results_pair_asof
  ON scanner_results(symbol, timeframe, as_of DESC);

CREATE TABLE IF NOT EXISTS scanner_candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('M5', 'M15', 'H1', 'H4')),
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  available INTEGER NOT NULL,
  error TEXT,
  candles_json TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
CREATE INDEX IF NOT EXISTS idx_scanner_candles_received
  ON scanner_candles(received_at DESC);

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
  volume DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_risk_open_positions_snapshot_symbol
  ON risk_open_positions(snapshot_id, symbol);

CREATE TABLE IF NOT EXISTS risk_check_results (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'M1',
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
CREATE INDEX IF NOT EXISTS idx_risk_results_pair_checked
  ON risk_check_results(symbol, timeframe, checked_at DESC);

CREATE TABLE IF NOT EXISTS position_sizing_inputs (
  symbol TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  available INTEGER NOT NULL,
  error TEXT,
  input_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_position_sizing_inputs_received
  ON position_sizing_inputs(received_at DESC);

CREATE TABLE IF NOT EXISTS position_sizing_results (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'M1',
  decision TEXT NOT NULL CHECK (
    decision IN ('SIZED_FOR_PAPER_REVIEW', 'REJECTED')
  ),
  checked_at TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_position_sizing_results_symbol_checked
  ON position_sizing_results(symbol, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_sizing_results_pair_checked
  ON position_sizing_results(symbol, timeframe, checked_at DESC);
