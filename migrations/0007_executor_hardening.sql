-- Legacy D1/SQLite mirror of postgres/004_executor_hardening.sql.
-- Kept so tests/sql_schema.test.ts compiles the executor SQL against it.
ALTER TABLE trade_intents ADD COLUMN dispatched_at TEXT;
