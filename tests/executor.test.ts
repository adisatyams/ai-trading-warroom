import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseTopSignalPerSymbol,
  validExecutorAck
} from "../src/executor.ts";

test("chooses one highest-score timeframe per symbol with a stable tie break", () => {
  const selected = chooseTopSignalPerSymbol([
    { symbol: "EURUSDm", timeframe: "M5" as const, score: 88 },
    { symbol: "EURUSDm", timeframe: "H1" as const, score: 91 },
    { symbol: "EURUSDm", timeframe: "H4" as const, score: 91 },
    { symbol: "XAUUSDm", timeframe: "M15" as const, score: 82 }
  ]);
  assert.deepEqual(selected.map(row => [row.symbol, row.timeframe]), [
    ["EURUSDm", "H4"],
    ["XAUUSDm", "M15"]
  ]);
});

test("accepts terminal order outcomes with bounded acknowledgement fields", () => {
  assert.equal(validExecutorAck({
    intent_id: "intent-1",
    status: "EXECUTED",
    broker_ticket: "12345",
    volume: 0.1,
    entry_price: 1.25,
    retcode: 10009,
    message: "Done",
    opened_at: "2026-11-20T12:00:00.000Z"
  }), true);
  assert.equal(validExecutorAck({
    intent_id: "intent-2",
    status: "UNCERTAIN",
    message: "No broker result"
  }), true);
});

test("rejects malformed or oversized executor acknowledgements", () => {
  assert.equal(validExecutorAck({ intent_id: "x", status: "PENDING" }), false);
  assert.equal(validExecutorAck({
    intent_id: "x",
    status: "EXECUTED",
    volume: -1
  }), false);
  assert.equal(validExecutorAck({
    intent_id: "x",
    status: "REJECTED",
    message: "x".repeat(501)
  }), false);
});
