import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POSITION_SIZER_CONFIG,
  calculateAtr14M1,
  sizePosition,
  type M1Candle,
  type PositionSizerInput,
  type SizingCandidate
} from "../src/position_sizer.ts";
import { STRATEGY, STRATEGY_VERSION } from "../src/scanner.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const ISO_NOW = new Date(NOW).toISOString();
const FRESH = new Date(NOW - 30_000).toISOString();

function candles(
  count = 29,
  range = 1,
  lastTime = NOW - 60_000
): M1Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(lastTime - (count - index - 1) * 60_000).toISOString();
    return {
      time,
      high: 100 + range / 2,
      low: 100 - range / 2,
      close: 100
    };
  });
}

function candidate(
  overrides: Partial<SizingCandidate> = {}
): SizingCandidate {
  return {
    signal_id: `${STRATEGY}:EURUSD:M15:${ISO_NOW}`,
    symbol: "EURUSD",
    timeframe: "M15",
    strategy: STRATEGY,
    strategy_version: STRATEGY_VERSION,
    state: "BUY",
    as_of: ISO_NOW,
    ...overrides
  };
}

function input(
  overrides: Partial<PositionSizerInput> = {}
): PositionSizerInput {
  return {
    nowMs: NOW,
    staleSeconds: 150,
    maxCandleGapSeconds: 120,
    riskPct: 0.25,
    paperMode: true,
    tradingEnabled: false,
    risk: { eligible: true, checked_at: FRESH },
    bridge: {
      connected: true,
      demo: true,
      received_at: FRESH,
      equity: 10_000
    },
    quote: { bid: 100, ask: 100.1, received_at: FRESH },
    snapshot: {
      available: true,
      captured_at: FRESH,
      received_at: FRESH,
      candles: candles(),
      spec: {
        tick_size: 0.1,
        tick_value_loss: 1,
        contract_size: 100_000,
        volume_min: 0.1,
        volume_max: 100,
        volume_step: 0.1
      }
    },
    ...overrides
  };
}

test("calculates ATR(14) using Wilder smoothing over contiguous completed M1 bars", () => {
  const result = calculateAtr14M1(candles(), NOW);
  assert.equal(result.atr, 1);

  const changingRanges = Array.from({ length: 29 }, (_, index) => {
    const range = index <= 14 ? 1 : 2;
    return {
      time: new Date(NOW - (29 - index) * 60_000).toISOString(),
      high: 100 + range / 2,
      low: 100 - range / 2,
      close: 100
    };
  });
  const smoothed = calculateAtr14M1(changingRanges, NOW);
  const expected = 2 - (13 / 14) ** 14;
  assert.ok(Math.abs(smoothed.atr! - expected) < 1e-12);
});

test("sizes a BUY from a 2x ATR stop within the 0.25% equity risk budget", () => {
  const result = sizePosition(candidate(), input());
  assert.equal(result.decision, "SIZED_FOR_PAPER_REVIEW");
  assert.equal(result.direction, "BUY");
  assert.equal(result.timeframe, "M15");
  assert.equal(result.metrics.atr14_m1, 1);
  assert.equal(result.metrics.entry_price, 100.1);
  assert.ok(Math.abs(result.metrics.stop_loss_price! - 98.1) < 1e-10);
  assert.ok(Math.abs(result.metrics.take_profit_price! - 104.1) < 1e-10);
  assert.equal(result.metrics.risk_budget, 25);
  assert.equal(result.metrics.contract_size, 100_000);
  assert.equal(result.metrics.volume, 1.2);
  assert.equal(result.metrics.estimated_loss, 24);
  assert.ok(result.metrics.estimated_risk_pct! <= 0.25);
  assert.equal(result.execution_enabled, false);
});

test("uses bid and an upward stop for SELL signals", () => {
  const result = sizePosition(
    candidate({ state: "SELL" }),
    input()
  );
  assert.equal(result.decision, "SIZED_FOR_PAPER_REVIEW");
  assert.equal(result.direction, "SELL");
  assert.equal(result.metrics.entry_price, 100);
  assert.equal(result.metrics.stop_loss_price, 102);
  assert.equal(result.metrics.take_profit_price, 96);
});

test("rejects stale inputs, non-eligible risk results, and unsafe execution mode", () => {
  const staleSnapshot = input({
    snapshot: {
      available: true,
      captured_at: new Date(NOW - 200_000).toISOString(),
      received_at: FRESH,
      candles: candles(),
      spec: {
        tick_size: 0.1,
        tick_value_loss: 1,
        contract_size: 100_000,
        volume_min: 0.1,
        volume_max: 100,
        volume_step: 0.1
      }
    }
  });
  assert.equal(sizePosition(candidate(), staleSnapshot).decision, "REJECTED");
  assert.equal(
    sizePosition(candidate(), input({ risk: { eligible: false, checked_at: FRESH } }))
      .decision,
    "REJECTED"
  );
  assert.equal(
    sizePosition(candidate(), input({ paperMode: false, tradingEnabled: true }))
      .decision,
    "REJECTED"
  );
});

test("never permits a configured per-trade risk above 0.25%", () => {
  const result = sizePosition(candidate(), input({ riskPct: 0.251 }));
  assert.equal(result.decision, "REJECTED");
  assert.equal(result.metrics.volume, null);
  assert.match(result.reasons.join(" "), /no more than 0.25%/);
});

test("rejects missing or gapped M1 history and invalid contract data", () => {
  assert.equal(calculateAtr14M1(candles(28), NOW).atr, null);
  const gapped = candles();
  gapped[10] = {
    ...gapped[10],
    time: new Date(Date.parse(gapped[9].time) + 180_000).toISOString()
  };
  assert.match(calculateAtr14M1(gapped, NOW).reason ?? "", /not contiguous/);

  const invalidSpec = input({
    snapshot: {
      available: true,
      captured_at: FRESH,
      received_at: FRESH,
      candles: candles(),
      spec: {
        tick_size: 0,
        tick_value_loss: 1,
        contract_size: 100_000,
        volume_min: 0.1,
        volume_max: 100,
        volume_step: 0.1
      }
    }
  });
  assert.equal(sizePosition(candidate(), invalidSpec).decision, "REJECTED");
});

test("rejects risk below broker minimum and never rounds volume up", () => {
  const tooSmall = input({
    bridge: {
      connected: true,
      demo: true,
      received_at: FRESH,
      equity: 1
    }
  });
  const rejected = sizePosition(candidate(), tooSmall);
  assert.equal(rejected.decision, "REJECTED");
  assert.match(rejected.reasons.join(" "), /minimum volume/);

  const capped = sizePosition(
    candidate(),
    input({
      snapshot: {
        available: true,
        captured_at: FRESH,
        received_at: FRESH,
        candles: candles(29, 0.01),
        spec: {
          tick_size: 0.1,
          tick_value_loss: 1,
          contract_size: 100_000,
          volume_min: 0.1,
          volume_max: 0.7,
          volume_step: 0.1
        }
      }
    })
  );
  assert.equal(capped.decision, "SIZED_FOR_PAPER_REVIEW");
  assert.equal(capped.metrics.volume, 0.7);
  assert.ok(capped.metrics.estimated_risk_pct! <= 0.25);
});

test("exposes the approved ATR and stop settings", () => {
  assert.equal(DEFAULT_POSITION_SIZER_CONFIG.atrPeriod, 14);
  assert.equal(DEFAULT_POSITION_SIZER_CONFIG.stopAtrMultiple, 2);
});
