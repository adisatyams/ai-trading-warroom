-- Executor hardening:
--  * dispatched_at records when an intent was claimed by the bridge, so a
--    DISPATCHED intent is only marked UNCERTAIN relative to its claim time
--    (not its creation time).
ALTER TABLE trade_intents
  ADD COLUMN IF NOT EXISTS dispatched_at TEXT;
