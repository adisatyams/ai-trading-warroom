ALTER TABLE scanner_results
  ADD COLUMN IF NOT EXISTS timeframe TEXT NOT NULL DEFAULT 'M1';
ALTER TABLE scanner_results
  ADD COLUMN IF NOT EXISTS entry DOUBLE PRECISION;
ALTER TABLE scanner_results
  ADD COLUMN IF NOT EXISTS stop_loss DOUBLE PRECISION;
ALTER TABLE scanner_results
  ADD COLUMN IF NOT EXISTS take_profit DOUBLE PRECISION;
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

ALTER TABLE risk_check_results
  ADD COLUMN IF NOT EXISTS timeframe TEXT NOT NULL DEFAULT 'M1';
CREATE INDEX IF NOT EXISTS idx_risk_results_pair_checked
  ON risk_check_results(symbol, timeframe, checked_at DESC);

ALTER TABLE position_sizing_results
  ADD COLUMN IF NOT EXISTS timeframe TEXT NOT NULL DEFAULT 'M1';
CREATE INDEX IF NOT EXISTS idx_position_sizing_results_pair_checked
  ON position_sizing_results(symbol, timeframe, checked_at DESC);
