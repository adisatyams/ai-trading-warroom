import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RISK_CONFIG,
  evaluateRisk,
  type RiskCandidate,
  type RiskContext
} from "../src/risk_checker.ts";
import { STRATEGY, STRATEGY_VERSION, type Observation } from "../src/scanner.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const ISO_NOW = new Date(NOW).toISOString();

function observations(mids: number[]): Observation[] {
  return mids.map((mid, index) => {
    const received = new Date(NOW - (mids.length - index - 1) * 60_000).toISOString();
    return {
      symbol: "EURUSD",
      bid: mid - 0.00001,
      ask: mid + 0.00001,
      received_at: received,
      tick_time: received
    };
  });
}

function candidate(
  overrides: Partial<RiskCandidate> = {}
): RiskCandidate {
  return {
    signal_id: `${STRATEGY}:EURUSD:${ISO_NOW}`,
    symbol: "EURUSD",
    strategy: STRATEGY,
    strategy_version: STRATEGY_VERSION,
    state: "BUY",
    as_of: ISO_NOW,
    features: { spread_bps: 1 },
    ...overrides
  };
}

function context(overrides: Partial<RiskContext> = {}): RiskContext {
  const series = observations(Array(21).fill(1.1));
  return {
    nowMs: NOW,
    paperMode: true,
    tradingEnabled: false,
    bridge: {
      connected: true,
      demo: true,
      received_at: new Date(NOW - 30_000).toISOString()
    },
    observations: series,
    calendar: {
      available: true,
      received_at: new Date(NOW - 30_000).toISOString()
    },
    calendarEvents: [],
    positions: {
      captured_at: new Date(NOW - 30_000).toISOString(),
      items: []
    },
    dailyEquity: {
      start_equity: 10_000,
      start_at: "2026-11-20T00:00:30.000Z",
      current_equity: 10_000,
      current_at: new Date(NOW - 30_000).toISOString(),
      peak_equity: 10_000
    },
    ...overrides
  };
}

test("eligible output is limited to paper review and requires all fresh inputs", () => {
  const result = evaluateRisk(candidate(), context());
  assert.equal(result.decision, "ELIGIBLE_FOR_PAPER_REVIEW");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.execution_enabled, false);
  assert.ok(Object.values(result.checks).every(Boolean));
});

test("rejects a spread above the symbol limit", () => {
  const result = evaluateRisk(
    candidate({ features: { spread_bps: 4.1 } }),
    context()
  );
  assert.equal(result.decision, "REJECTED");
  assert.equal(result.checks.spread, false);
});

test("uses a prefix spread limit for broker-suffixed symbols", () => {
  const result = evaluateRisk(
    candidate({
      symbol: "XAUUSDm",
      features: { spread_bps: 7 }
    }),
    context({
      observations: observations(Array(21).fill(2_000)).map(row => ({
        ...row,
        symbol: "XAUUSDm"
      }))
    })
  );
  assert.equal(result.metrics.max_spread_bps, 8);
});

test("rejects an abnormal latest move above three times the historical median", () => {
  const mids = Array.from({ length: 20 }, (_, index) =>
    1.1 + (index % 2 === 0 ? 0 : 0.0001)
  );
  mids.push(mids[19] + 0.001);
  const result = evaluateRisk(
    candidate(),
    context({ observations: observations(mids) })
  );
  assert.equal(result.checks.volatility, false);
  assert.ok(result.metrics.latest_move_bps! > result.metrics.historical_median_move_bps! * 3);
});

test("rejects a high-impact event inside the 15-minute blackout", () => {
  const result = evaluateRisk(
    candidate(),
    context({
      calendarEvents: [{
        event_id: "event-1",
        name: "Employment report",
        currency: "USD",
        importance: "HIGH",
        scheduled_at: ISO_NOW
      }]
    })
  );
  assert.equal(result.checks.news, false);
});

test("fails closed when the calendar or positions snapshot is unavailable", () => {
  const result = evaluateRisk(
    candidate(),
    context({ calendar: null, positions: null })
  );
  assert.equal(result.decision, "REJECTED");
  assert.equal(result.checks.news, false);
  assert.equal(result.checks.positions, false);
});

test("rejects duplicate-symbol and maximum-position cases", () => {
  const duplicate = evaluateRisk(
    candidate(),
    context({
      positions: {
        captured_at: new Date(NOW - 30_000).toISOString(),
        items: [{ symbol: "EURUSDm", direction: "BUY", volume: 0.1 }]
      }
    })
  );
  assert.equal(duplicate.checks.positions, false);
  assert.match(duplicate.reasons.join(" "), /open position already exists/i);

  const atLimit = evaluateRisk(
    candidate(),
    context({
      positions: {
        captured_at: new Date(NOW - 30_000).toISOString(),
        items: [
          { symbol: "GBPUSD", direction: "BUY", volume: 0.1 },
          { symbol: "USDJPY", direction: "SELL", volume: 0.1 },
          { symbol: "XAUUSD", direction: "BUY", volume: 0.1 }
        ]
      }
    })
  );
  assert.equal(atLimit.checks.positions, false);
  assert.match(atLimit.reasons.join(" "), /maximum 3/);
});

test("enforces daily loss and drawdown independently", () => {
  const result = evaluateRisk(
    candidate(),
    context({
      dailyEquity: {
        start_equity: 10_000,
        start_at: "2026-11-20T00:00:30.000Z",
        current_equity: 9_700,
        current_at: new Date(NOW - 30_000).toISOString(),
        peak_equity: 10_000
      }
    })
  );
  assert.equal(result.checks.daily_loss, false);
  assert.equal(result.checks.daily_drawdown, false);
  assert.equal(result.metrics.daily_loss_pct, 3);
  assert.equal(result.metrics.daily_drawdown_pct, 3);
});

test("rejects stale inputs, unapproved strategy, and unsafe execution mode", () => {
  const stale = context({
    calendar: {
      available: true,
      received_at: new Date(NOW - 200_000).toISOString()
    }
  });
  const result = evaluateRisk(
    candidate({
      strategy: "UNAPPROVED",
      state: "WATCH"
    }),
    { ...stale, paperMode: false, tradingEnabled: true }
  );
  assert.equal(result.decision, "REJECTED");
  assert.equal(result.checks.strategy, false);
  assert.equal(result.checks.safety, false);
  assert.equal(result.checks.news, false);
});

test("uses the configured daily loss and drawdown thresholds", () => {
  assert.equal(DEFAULT_RISK_CONFIG.maxDailyLossPct, 2);
  assert.equal(DEFAULT_RISK_CONFIG.maxDailyDrawdownPct, 3);
});
