ALTER TABLE risk_check_results
  DROP CONSTRAINT IF EXISTS risk_check_results_decision_check;
ALTER TABLE risk_check_results
  ADD CONSTRAINT risk_check_results_decision_check CHECK (
    decision IN (
      'ELIGIBLE_FOR_PAPER_REVIEW',
      'ELIGIBLE_FOR_DEMO_EXECUTION',
      'REJECTED'
    )
  );

ALTER TABLE position_sizing_results
  DROP CONSTRAINT IF EXISTS position_sizing_results_decision_check;
ALTER TABLE position_sizing_results
  ADD CONSTRAINT position_sizing_results_decision_check CHECK (
    decision IN (
      'SIZED_FOR_PAPER_REVIEW',
      'SIZED_FOR_DEMO_EXECUTION',
      'REJECTED'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_intents_one_active_symbol
  ON trade_intents(symbol)
  WHERE status IN (
    'PENDING',
    'DISPATCHED',
    'EXECUTED',
    'PARTIAL',
    'UNCERTAIN'
  );

INSERT INTO agent_status (
  agent_name,
  status,
  last_seen_at,
  detail
)
VALUES (
  'EXECUTOR',
  'LOCKED',
  TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'DEMO_ONLY MT5 market execution; Worker and bridge gates required'
)
ON CONFLICT (agent_name) DO UPDATE
SET
  status = EXCLUDED.status,
  last_seen_at = EXCLUDED.last_seen_at,
  detail = EXCLUDED.detail;
