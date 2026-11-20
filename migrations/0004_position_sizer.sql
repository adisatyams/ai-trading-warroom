-- Position Sizer input cache and research-only sizing audit.

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
  decision TEXT NOT NULL CHECK (
    decision IN ('SIZED_FOR_PAPER_REVIEW', 'REJECTED')
  ),
  checked_at TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_position_sizing_results_symbol_checked
  ON position_sizing_results(symbol, checked_at DESC);
