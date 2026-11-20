ALTER TABLE scanner_results
  ADD COLUMN timeframe TEXT NOT NULL DEFAULT 'M1';
ALTER TABLE scanner_results ADD COLUMN entry REAL;
ALTER TABLE scanner_results ADD COLUMN stop_loss REAL;
ALTER TABLE scanner_results ADD COLUMN take_profit REAL;
CREATE INDEX idx_scanner_results_pair_asof
  ON scanner_results(symbol, timeframe, as_of DESC);

CREATE TABLE scanner_candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('M5', 'M15', 'H1', 'H4')),
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  available INTEGER NOT NULL,
  error TEXT,
  candles_json TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
CREATE INDEX idx_scanner_candles_received
  ON scanner_candles(received_at DESC);

ALTER TABLE risk_check_results
  ADD COLUMN timeframe TEXT NOT NULL DEFAULT 'M1';
CREATE INDEX idx_risk_results_pair_checked
  ON risk_check_results(symbol, timeframe, checked_at DESC);

ALTER TABLE position_sizing_results
  ADD COLUMN timeframe TEXT NOT NULL DEFAULT 'M1';
CREATE INDEX idx_position_sizing_results_pair_checked
  ON position_sizing_results(symbol, timeframe, checked_at DESC);
