import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_TIMEFRAME,
  TREND_TIMEFRAMES,
  chooseTopSignalPerSymbol,
  emaTrend,
  trendAligned,
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

test("executes on M5 and checks the H1 and H4 trend", () => {
  assert.equal(EXECUTION_TIMEFRAME, "M5");
  assert.deepEqual(TREND_TIMEFRAMES, ["H1", "H4"]);
});

test("classifies EMA20/50/200 ordering as a trend", () => {
  assert.equal(emaTrend({ ema20: 3, ema50: 2, ema200: 1 }), "UP");
  assert.equal(emaTrend({ ema20: 1, ema50: 2, ema200: 3 }), "DOWN");
  assert.equal(emaTrend({ ema20: 2, ema50: 3, ema200: 1 }), "NONE");
  assert.equal(emaTrend({ ema20: 3, ema50: 3, ema200: 1 }), "NONE");
  assert.equal(emaTrend({ ema20: null, ema50: 2, ema200: 1 }), "NONE");
  assert.equal(emaTrend({}), "NONE");
  assert.equal(emaTrend(null), "NONE");
  assert.equal(emaTrend(undefined), "NONE");
});

test("trade direction must match both the H1 and the H4 trend", () => {
  const up = { ema20: 3, ema50: 2, ema200: 1 };
  const down = { ema20: 1, ema50: 2, ema200: 3 };
  assert.equal(trendAligned("BUY", { H1: up, H4: up }), true);
  assert.equal(trendAligned("SELL", { H1: down, H4: down }), true);
  assert.equal(trendAligned("BUY", { H1: up, H4: down }), false);
  assert.equal(trendAligned("SELL", { H1: up, H4: up }), false);
  assert.equal(trendAligned("BUY", { H1: up }), false);
  assert.equal(trendAligned("BUY", {}), false);
});
