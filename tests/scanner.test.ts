import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  rejectInvalidTick,
  signalId,
  evaluateTimeframe,
  DEFAULT_CONFIG,
  LEGACY_STRATEGY,
  STRATEGY,
  type Candle,
  type Observation
} from "../src/scanner.ts";

const T0 = Date.parse("2026-11-20T02:00:00.000Z");
const STEP = 60_000;

/** Build observations at 60s intervals from a list of mid prices (oldest first). */
function series(
  mids: number[],
  opts: { halfSpread?: number; startMs?: number; stepMs?: number } = {}
): Observation[] {
  const half = opts.halfSpread ?? 0.00001;
  const start = opts.startMs ?? T0;
  const step = opts.stepMs ?? STEP;
  return mids.map((m, i) => {
    const t = new Date(start + i * step).toISOString();
    return {
      symbol: "EURUSD",
      bid: m - half,
      ask: m + half,
      received_at: t,
      tick_time: t
    };
  });
}

const flat = (n: number, v = 1.1) => Array.from({ length: n }, () => v);
const ramp = (n: number, from: number, step: number) =>
  Array.from({ length: n }, (_, i) => from + i * step);

const nowAfter = (obs: Observation[], s = 10) =>
  Date.parse(obs[obs.length - 1].received_at) + s * 1000;

test("WARMING_UP when fewer than 20 observations", () => {
  const obs = series(ramp(19, 1.1, 0.0001));
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "WARMING_UP");
  assert.equal(r.score, null);
  assert.equal(r.features.contiguous_observations, 19);
});

test("WARMING_UP with no observations", () => {
  const r = evaluate("EURUSD", [], T0);
  assert.equal(r.state, "WARMING_UP");
  assert.equal(r.as_of, null);
});

test("BUY on aligned uptrend", () => {
  const obs = series(ramp(25, 1.1, 0.00005));
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "BUY");
  assert.ok(r.score !== null && r.score > 0 && r.score <= 100);
  assert.ok(r.features.trend_bps! > 0);
  assert.ok(r.features.momentum_bps! > 0);
  assert.ok(r.reasons.length >= 3);
  assert.equal(r.strategy, LEGACY_STRATEGY);
});

test("SELL on aligned downtrend", () => {
  const obs = series(ramp(25, 1.1, -0.00005));
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "SELL");
  assert.ok(r.features.trend_bps! < 0);
  assert.ok(r.features.momentum_bps! < 0);
});

test("WATCH on flat market", () => {
  const obs = series(flat(25));
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "WATCH");
  assert.equal(r.score, null);
});

test("WATCH when trend is up but recent momentum has reversed", () => {
  // Rise to a peak, then a mild pullback: SMA5 still above SMA20 (trend > 0)
  // but price is below where it was 5 observations ago (momentum < 0).
  const mids = [...ramp(20, 1.1, 0.0001), 1.1018, 1.1017, 1.1016, 1.1015, 1.1014];
  const obs = series(mids);
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.ok(r.features.trend_bps! > 0, "trend should still be positive");
  assert.ok(r.features.momentum_bps! < 0, "momentum should be negative");
  assert.equal(r.state, "WATCH");
});

test("WATCH when trend is smaller than the spread (cost awareness)", () => {
  // Tiny drift (~0.1 bps trend) with a wide-ish spread.
  const obs = series(ramp(25, 1.1, 0.000001), { halfSpread: 0.00015 });
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "WATCH");
});

test("REJECTED INVALID_PRICE for non-finite / crossed quotes", () => {
  const obs = series(ramp(25, 1.1, 0.00005));
  obs[10] = { ...obs[10], bid: 1.2, ask: 1.1 }; // ask < bid
  let r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "REJECTED");
  assert.equal(r.reject_reason, "INVALID_PRICE");

  const obs2 = series(ramp(25, 1.1, 0.00005));
  obs2[24] = { ...obs2[24], bid: Number.NaN };
  r = evaluate("EURUSD", obs2, nowAfter(obs2));
  assert.equal(r.reject_reason, "INVALID_PRICE");

  const obs3 = series(ramp(25, 1.1, 0.00005));
  obs3[3] = { ...obs3[3], bid: 0, ask: 0 };
  r = evaluate("EURUSD", obs3, nowAfter(obs3));
  assert.equal(r.reject_reason, "INVALID_PRICE");
});

test("rejectInvalidTick produces a REJECTED/INVALID_PRICE result", () => {
  const r = rejectInvalidTick("EURUSD", "2026-11-20T02:00:00.000Z", "ask < bid");
  assert.equal(r.state, "REJECTED");
  assert.equal(r.reject_reason, "INVALID_PRICE");
  assert.equal(
    r.signal_id,
    signalId("EURUSD", "2026-11-20T02:00:00.000Z", "M1", LEGACY_STRATEGY)
  );
});

test("REJECTED STALE_DATA when newest observation is too old", () => {
  const obs = series(ramp(25, 1.1, 0.00005));
  const r = evaluate("EURUSD", obs, nowAfter(obs, 600));
  assert.equal(r.state, "REJECTED");
  assert.equal(r.reject_reason, "STALE_DATA");
});

test("REJECTED STALE_DATA when tick time is frozen (market closed)", () => {
  const obs = series(ramp(25, 1.1, 0.00005));
  // Bridge keeps delivering, but MT5 tick time stopped 1 hour ago.
  const frozen = new Date(T0 - 3_600_000).toISOString();
  for (const o of obs) o.tick_time = frozen;
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.reject_reason, "STALE_DATA");
});

test("REJECTED SPREAD_TOO_WIDE uses per-symbol limit", () => {
  const wide = series(ramp(25, 1.1, 0.00005), { halfSpread: 0.0005 }); // ~9 bps
  let r = evaluate("EURUSD", wide, nowAfter(wide));
  assert.equal(r.state, "REJECTED");
  assert.equal(r.reject_reason, "SPREAD_TOO_WIDE");

  // Broker-suffixed XAUUSDm keeps the configured 8 bps ceiling.
  const gold = Array.from({ length: 25 }, (_, i) => {
    const mid = 2600 + i * 0.5;
    const t = new Date(T0 + i * STEP).toISOString();
    return {
      symbol: "XAUUSDm",
      bid: mid - 0.065,
      ask: mid + 0.065,
      received_at: t,
      tick_time: t
    };
  });
  r = evaluate("XAUUSDm", gold, nowAfter(gold));
  assert.notEqual(r.reject_reason, "SPREAD_TOO_WIDE");
  assert.equal(r.features.max_spread_bps, 8);
});

test("REJECTED OUT_OF_ORDER for non-monotonic received_at", () => {
  const obs = series(ramp(25, 1.1, 0.00005));
  const tmp = obs[12];
  obs[12] = obs[13];
  obs[13] = tmp;
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "REJECTED");
  assert.equal(r.reject_reason, "OUT_OF_ORDER");
});

test("REJECTED OUT_OF_ORDER when tick time goes backwards", () => {
  const obs = series(ramp(25, 1.1, 0.00005));
  obs[15] = { ...obs[15], tick_time: new Date(T0).toISOString() };
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.reject_reason, "OUT_OF_ORDER");
});

test("a data gap restarts warm-up (old prices do not leak into SMAs)", () => {
  // 20 old observations, then a 2h gap, then only 5 new ones.
  const old = series(ramp(20, 1.1, 0.00005));
  const resumeMs = T0 + 20 * STEP + 2 * 3_600_000;
  const fresh = series(ramp(5, 1.2, 0.00005), { startMs: resumeMs });
  const obs = [...old, ...fresh];
  const r = evaluate("EURUSD", obs, nowAfter(obs));
  assert.equal(r.state, "WARMING_UP");
  assert.equal(r.features.contiguous_observations, 5);
});

test("deterministic: same input gives identical output and signal_id", () => {
  const obs = series(ramp(25, 1.1, 0.00005));
  const a = evaluate("EURUSD", obs, nowAfter(obs));
  const b = evaluate("EURUSD", obs, nowAfter(obs));
  assert.deepEqual(a, b);
  assert.equal(
    a.signal_id,
    signalId("EURUSD", obs[24].received_at, "M1", LEGACY_STRATEGY)
  );
});

test("default config matches the agreed design (SMA 5/20)", () => {
  assert.equal(DEFAULT_CONFIG.shortWindow, 5);
  assert.equal(DEFAULT_CONFIG.longWindow, 20);
});

function indicatorCandles(
  direction: 1 | -1,
  breakout = true,
  timeframeSeconds = 300
): Candle[] {
  const count = 220;
  return Array.from({ length: count }, (_, index) => {
    const trend = 100 + direction * index * 0.01;
    const close =
      breakout && index === count - 1
        ? trend + direction * 1
        : trend;
    const time = new Date(
      T0 + index * timeframeSeconds * 1000
    ).toISOString();
    return {
      time,
      open: close - direction * 0.005,
      high: close + 0.02,
      low: close - 0.02,
      close
    };
  });
}

test("multi-timeframe scanner scores an aligned breakout; M5 levels use the M5 ATR (2x stop, 2R target)", () => {
  const candles = indicatorCandles(1);
  const nowMs = Date.parse(candles[candles.length - 1].time) + 60_000;
  const result = evaluateTimeframe(
    "EURUSDm",
    "M5",
    candles,
    {
      bid: candles[candles.length - 1].close,
      ask: candles[candles.length - 1].close + 0.0001,
      received_at: new Date(nowMs - 5_000).toISOString()
    },
    nowMs,
    0.1
  );
  assert.equal(result.state, "BUY");
  assert.equal(result.timeframe, "M5");
  assert.equal(result.score, 70);
  assert.equal(result.features.buy_score, 70);
  assert.equal(result.features.sell_score, 0);
  assert.ok(result.features.ema20! > result.features.ema50!);
  assert.ok(result.features.ema50! > result.features.ema200!);
  const stopDistance = result.features.atr14! * 2;
  assert.ok(Math.abs(result.stop_loss! - (result.entry! - stopDistance)) < 1e-6);
  assert.ok(Math.abs(result.take_profit! - (result.entry! + stopDistance * 2)) < 1e-6);
  assert.match(result.signal_id, /:M5:/);
});

test("non-M5 timeframes keep the M1 ATR stop basis", () => {
  const candles = indicatorCandles(1);
  const nowMs = Date.parse(candles[candles.length - 1].time) + 60_000;
  const result = evaluateTimeframe(
    "EURUSDm",
    "H1",
    candles,
    {
      bid: candles[candles.length - 1].close,
      ask: candles[candles.length - 1].close + 0.0001,
      received_at: new Date(nowMs - 5_000).toISOString()
    },
    nowMs,
    0.1
  );
  assert.equal(result.state, "BUY");
  assert.ok(Math.abs(result.stop_loss! - (result.entry! - 0.2)) < 1e-8);
  assert.ok(Math.abs(result.take_profit! - (result.entry! + 0.4)) < 1e-8);
});

test("multi-timeframe scanner keeps sub-threshold momentum as WATCH", () => {
  const candles = indicatorCandles(1, false);
  const nowMs = Date.parse(candles[candles.length - 1].time) + 60_000;
  const result = evaluateTimeframe(
    "EURUSD",
    "M15",
    candles,
    {
      bid: candles[candles.length - 1].close,
      ask: candles[candles.length - 1].close + 0.0001,
      received_at: new Date(nowMs - 5_000).toISOString()
    },
    nowMs,
    0.1
  );
  assert.equal(result.state, "WATCH");
  assert.ok(result.score !== null && result.score < DEFAULT_CONFIG.minSignalScore);
  assert.equal(result.entry, null);
});

test("scanner produces separate SELL candidates for H1 and H4", () => {
  const outputs = (["H1", "H4"] as const).map(timeframe => {
    const seconds = timeframe === "H1" ? 3_600 : 14_400;
    const candles = indicatorCandles(-1, true, seconds);
    const nowMs = Date.parse(candles[candles.length - 1].time) + 60_000;
    const quote = {
      bid: candles[candles.length - 1].close - 0.0001,
      ask: candles[candles.length - 1].close,
      received_at: new Date(nowMs - 5_000).toISOString()
    };
    return evaluateTimeframe(
      "EURUSDm",
      timeframe,
      candles,
      quote,
      nowMs,
      0.1
    );
  });
  assert.deepEqual(outputs.map(result => result.state), ["SELL", "SELL"]);
  assert.notEqual(outputs[0].signal_id, outputs[1].signal_id);
  assert.ok(outputs.every(result => result.score! >= DEFAULT_CONFIG.minSignalScore));
});

test("multi-timeframe scanner fails closed on stale candle and malformed chronology", () => {
  const stale = indicatorCandles(1);
  const staleNow = Date.parse(stale[stale.length - 1].time) + 900_000;
  const quote = {
    bid: 102,
    ask: 102.0001,
    received_at: new Date(staleNow - 1_000).toISOString()
  };
  assert.equal(
    evaluateTimeframe("EURUSD", "M5", stale, quote, staleNow, 0.1).reject_reason,
    "STALE_CANDLES"
  );

  const unordered = indicatorCandles(-1);
  unordered[100] = { ...unordered[100], time: unordered[99].time };
  const nowMs = Date.parse(unordered[unordered.length - 1].time) + 60_000;
  assert.equal(
    evaluateTimeframe(
      "EURUSD",
      "H1",
      unordered,
      { ...quote, received_at: new Date(nowMs - 1_000).toISOString() },
      nowMs,
      0.1
    ).reject_reason,
    "INVALID_CANDLES"
  );
});
