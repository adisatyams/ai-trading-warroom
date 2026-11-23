DROP INDEX IF EXISTS idx_risk_results_symbol_checked;
DROP INDEX IF EXISTS idx_risk_results_decision_checked;
DROP INDEX IF EXISTS idx_risk_results_pair_checked;
ALTER TABLE risk_check_results RENAME TO risk_check_results_old;
CREATE TABLE risk_check_results (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'M1',
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  scanner_state TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN (
      'ELIGIBLE_FOR_PAPER_REVIEW',
      'ELIGIBLE_FOR_DEMO_EXECUTION',
      'REJECTED'
    )
  ),
  reasons_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  as_of TEXT,
  checked_at TEXT NOT NULL
);
INSERT INTO risk_check_results (
  signal_id,
  symbol,
  timeframe,
  strategy,
  strategy_version,
  scanner_state,
  decision,
  reasons_json,
  checks_json,
  metrics_json,
  as_of,
  checked_at
)
SELECT
  signal_id,
  symbol,
  timeframe,
  strategy,
  strategy_version,
  scanner_state,
  decision,
  reasons_json,
  checks_json,
  metrics_json,
  as_of,
  checked_at
FROM risk_check_results_old;
DROP TABLE risk_check_results_old;
CREATE INDEX idx_risk_results_symbol_checked
  ON risk_check_results(symbol, checked_at DESC);
CREATE INDEX idx_risk_results_decision_checked
  ON risk_check_results(decision, checked_at DESC);
CREATE INDEX idx_risk_results_pair_checked
  ON risk_check_results(symbol, timeframe, checked_at DESC);

DROP INDEX IF EXISTS idx_position_sizing_results_symbol_checked;
DROP INDEX IF EXISTS idx_position_sizing_results_pair_checked;
ALTER TABLE position_sizing_results RENAME TO position_sizing_results_old;
CREATE TABLE position_sizing_results (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'M1',
  decision TEXT NOT NULL CHECK (
    decision IN (
      'SIZED_FOR_PAPER_REVIEW',
      'SIZED_FOR_DEMO_EXECUTION',
      'REJECTED'
    )
  ),
  checked_at TEXT NOT NULL,
  result_json TEXT NOT NULL
);
INSERT INTO position_sizing_results (
  signal_id,
  symbol,
  timeframe,
  decision,
  checked_at,
  result_json
)
SELECT
  signal_id,
  symbol,
  timeframe,
  decision,
  checked_at,
  result_json
FROM position_sizing_results_old;
DROP TABLE position_sizing_results_old;
CREATE INDEX idx_position_sizing_results_symbol_checked
  ON position_sizing_results(symbol, checked_at DESC);
CREATE INDEX idx_position_sizing_results_pair_checked
  ON position_sizing_results(symbol, timeframe, checked_at DESC);

CREATE UNIQUE INDEX idx_trade_intents_one_active_symbol
  ON trade_intents(symbol)
  WHERE status IN (
    'PENDING',
    'DISPATCHED',
    'EXECUTED',
    'PARTIAL',
    'UNCERTAIN'
  );
