import {
  STRATEGY,
  STRATEGY_VERSION,
  type ScannerTimeframe
} from "./scanner.ts";

export type SizingDecision =
  | "SIZED_FOR_PAPER_REVIEW"
  | "SIZED_FOR_DEMO_EXECUTION"
  | "REJECTED";

export interface M1Candle {
  time: string;
  high: number;
  low: number;
  close: number;
}

export interface SizingSymbolSpec {
  tick_size: number;
  tick_value_loss: number;
  contract_size: number;
  volume_min: number;
  volume_max: number;
  volume_step: number;
}

export interface SizingCandidate {
  signal_id: string;
  symbol: string;
  timeframe: ScannerTimeframe | "M1";
  strategy: string;
  strategy_version: string;
  state: string;
  as_of: string | null;
}

export interface PositionSizerInput {
  nowMs: number;
  staleSeconds: number;
  maxCandleGapSeconds: number;
  riskPct: number;
  /**
   * ATR(14) of the signal's own timeframe (from the scanner). Used for the
   * stop distance when the signal is an M5 execution signal.
   */
  signalAtr?: number | null;
  paperMode: boolean;
  tradingEnabled: boolean;
  risk: {
    eligible: boolean;
    checked_at: string;
  };
  bridge: {
    connected: boolean;
    demo: boolean;
    received_at: string;
    equity: number | null;
  } | null;
  quote: {
    bid: number;
    ask: number;
    received_at: string;
  } | null;
  snapshot: {
    available: boolean;
    captured_at: string;
    received_at: string;
    candles: M1Candle[];
    spec: SizingSymbolSpec | null;
  } | null;
}

export interface PositionSizerResult {
  signal_id: string;
  symbol: string;
  timeframe: ScannerTimeframe | "M1";
  strategy: string;
  strategy_version: string;
  direction: "BUY" | "SELL";
  decision: SizingDecision;
  reasons: string[];
  metrics: {
    atr14_m1: number | null;
    atr14_signal: number | null;
    atr_source: "M5" | "M1" | null;
    entry_price: number | null;
    stop_loss_price: number | null;
    take_profit_price: number | null;
    risk_pct_limit: number;
    equity: number | null;
    risk_budget: number | null;
    risk_per_lot: number | null;
    contract_size: number | null;
    raw_volume: number | null;
    volume: number | null;
    estimated_loss: number | null;
    estimated_risk_pct: number | null;
  };
  as_of: string | null;
  checked_at: string;
  execution_enabled: false;
}

export const DEFAULT_POSITION_SIZER_CONFIG = {
  atrPeriod: 14,
  stopAtrMultiple: 2,
  staleSeconds: 150,
  maxCandleGapSeconds: 120
} as const;

export const MAX_ALLOWED_RISK_PCT = 0.25;
export const TAKE_PROFIT_R_MULTIPLE = 2;
const REQUIRED_CANDLES = DEFAULT_POSITION_SIZER_CONFIG.atrPeriod * 2 + 1;

function isFresh(timestamp: string, nowMs: number, staleSeconds: number): boolean {
  const ageSeconds = (nowMs - Date.parse(timestamp)) / 1000;
  return Number.isFinite(ageSeconds) && ageSeconds >= 0 && ageSeconds <= staleSeconds;
}

export function calculateAtr14M1(
  candles: M1Candle[],
  nowMs: number,
  staleSeconds: number = DEFAULT_POSITION_SIZER_CONFIG.staleSeconds,
  maxGapSeconds: number = DEFAULT_POSITION_SIZER_CONFIG.maxCandleGapSeconds
): { atr: number | null; reason?: string } {
  if (candles.length < REQUIRED_CANDLES) {
    return {
      atr: null,
      reason: `Need ${REQUIRED_CANDLES} completed M1 candles for ATR(14)`
    };
  }

  const series = candles.slice(-REQUIRED_CANDLES);
  if (!isFresh(series[series.length - 1].time, nowMs, staleSeconds)) {
    return { atr: null, reason: "Latest completed M1 candle is stale or invalid" };
  }

  for (let index = 0; index < series.length; index++) {
    const candle = series[index];
    if (
      !Number.isFinite(Date.parse(candle.time)) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.low <= 0 ||
      candle.high < candle.low ||
      candle.close < candle.low ||
      candle.close > candle.high
    ) {
      return { atr: null, reason: "M1 candle contains invalid OHLC values" };
    }

    if (index > 0) {
      const gapSeconds =
        (Date.parse(candle.time) - Date.parse(series[index - 1].time)) / 1000;
      if (
        !Number.isFinite(gapSeconds) ||
        gapSeconds <= 0 ||
        gapSeconds > maxGapSeconds
      ) {
        return { atr: null, reason: "M1 candles are not contiguous" };
      }
    }
  }

  const trueRanges = series.slice(1).map((candle, index) => {
    const previousClose = series[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });

  let atr =
    trueRanges
      .slice(0, DEFAULT_POSITION_SIZER_CONFIG.atrPeriod)
      .reduce((sum, range) => sum + range, 0) /
    DEFAULT_POSITION_SIZER_CONFIG.atrPeriod;
  for (
    let index = DEFAULT_POSITION_SIZER_CONFIG.atrPeriod;
    index < trueRanges.length;
    index++
  ) {
    atr =
      (atr * (DEFAULT_POSITION_SIZER_CONFIG.atrPeriod - 1) +
        trueRanges[index]) /
      DEFAULT_POSITION_SIZER_CONFIG.atrPeriod;
  }

  return Number.isFinite(atr) && atr > 0
    ? { atr }
    : { atr: null, reason: "ATR(14) is zero or invalid" };
}

function precisionForStep(step: number): number {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) {
    return Number(text.split("e-")[1]);
  }
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

export function sizePosition(
  candidate: SizingCandidate,
  input: PositionSizerInput
): PositionSizerResult {
  const reasons: string[] = [];
  const metrics: PositionSizerResult["metrics"] = {
    atr14_m1: null,
    atr14_signal: null,
    atr_source: null,
    entry_price: null,
    stop_loss_price: null,
    take_profit_price: null,
    risk_pct_limit: input.riskPct,
    equity: null,
    risk_budget: null,
    risk_per_lot: null,
    contract_size: null,
    raw_volume: null,
    volume: null,
    estimated_loss: null,
    estimated_risk_pct: null
  };
  const reject = (reason: string) => reasons.push(reason);
  const direction = candidate.state === "BUY" || candidate.state === "SELL"
    ? candidate.state
    : "BUY";
  const validRiskPct =
    Number.isFinite(input.riskPct) &&
    input.riskPct > 0 &&
    input.riskPct <= MAX_ALLOWED_RISK_PCT;

  if (!input.risk.eligible || !isFresh(input.risk.checked_at, input.nowMs, input.staleSeconds)) {
    reject("A fresh eligible Risk Checker result is required");
  }
  if (
    candidate.strategy !== STRATEGY ||
    candidate.strategy_version !== STRATEGY_VERSION ||
    (candidate.state !== "BUY" && candidate.state !== "SELL")
  ) {
    reject("Candidate is not an actionable signal from the approved strategy");
  }
  if (!validRiskPct) {
    reject(`Per-trade risk must be greater than 0 and no more than ${MAX_ALLOWED_RISK_PCT}%`);
  }
  if (!input.paperMode) {
    reject("PAPER_MODE=true is required for demo sizing");
  }
  if (
    !input.bridge ||
    !input.bridge.connected ||
    !input.bridge.demo ||
    !isFresh(input.bridge.received_at, input.nowMs, input.staleSeconds)
  ) {
    reject("A fresh connected MT5 demo heartbeat is required");
  } else if (
    typeof input.bridge.equity !== "number" ||
    !Number.isFinite(input.bridge.equity) ||
    input.bridge.equity <= 0
  ) {
    reject("A positive MT5 account equity value is required");
  } else {
    metrics.equity = input.bridge.equity;
    if (validRiskPct) {
      metrics.risk_budget = input.bridge.equity * (input.riskPct / 100);
    }
  }

  if (
    !input.quote ||
    !isFresh(input.quote.received_at, input.nowMs, input.staleSeconds) ||
    !Number.isFinite(input.quote.bid) ||
    !Number.isFinite(input.quote.ask) ||
    input.quote.bid <= 0 ||
    input.quote.ask < input.quote.bid
  ) {
    reject("A fresh valid market quote is required");
  } else {
    metrics.entry_price = direction === "BUY" ? input.quote.ask : input.quote.bid;
  }

  const snapshot = input.snapshot;
  if (
    !snapshot ||
    !snapshot.available ||
    !isFresh(snapshot.captured_at, input.nowMs, input.staleSeconds) ||
    !isFresh(snapshot.received_at, input.nowMs, input.staleSeconds) ||
    !snapshot.spec
  ) {
    reject("Fresh ATR and MT5 symbol contract data are required");
  } else {
    const m1 = calculateAtr14M1(
      snapshot.candles,
      input.nowMs,
      input.staleSeconds,
      input.maxCandleGapSeconds
    );
    metrics.atr14_m1 = m1.atr;
    // M5 execution signals size their stop from the M5 ATR; every other
    // timeframe keeps the original M1 ATR basis.
    const usesSignalAtr = candidate.timeframe === "M5";
    let stopAtr: number | null;
    if (usesSignalAtr) {
      const signalAtr = input.signalAtr;
      stopAtr =
        typeof signalAtr === "number" && Number.isFinite(signalAtr) && signalAtr > 0
          ? signalAtr
          : null;
      metrics.atr14_signal = stopAtr;
      if (stopAtr === null) {
        reject("M5 ATR(14) from the scanner is unavailable");
      } else {
        metrics.atr_source = "M5";
      }
    } else {
      stopAtr = m1.atr;
      if (stopAtr === null) {
        reject(m1.reason ?? "Unable to calculate ATR(14)");
      } else {
        metrics.atr_source = "M1";
      }
    }
    if (stopAtr !== null && metrics.entry_price !== null) {
      const stopDistance =
        stopAtr * DEFAULT_POSITION_SIZER_CONFIG.stopAtrMultiple;
      metrics.stop_loss_price =
        direction === "BUY"
          ? metrics.entry_price - stopDistance
          : metrics.entry_price + stopDistance;
      metrics.take_profit_price =
        direction === "BUY"
          ? metrics.entry_price + stopDistance * TAKE_PROFIT_R_MULTIPLE
          : metrics.entry_price - stopDistance * TAKE_PROFIT_R_MULTIPLE;
    }

    const spec = snapshot.spec;
    metrics.contract_size = Number.isFinite(spec.contract_size)
      ? spec.contract_size
      : null;
    if (
      !Number.isFinite(spec.tick_size) ||
      spec.tick_size <= 0 ||
      !Number.isFinite(spec.tick_value_loss) ||
      spec.tick_value_loss <= 0 ||
      !Number.isFinite(spec.contract_size) ||
      spec.contract_size <= 0 ||
      !Number.isFinite(spec.volume_min) ||
      spec.volume_min <= 0 ||
      !Number.isFinite(spec.volume_max) ||
      spec.volume_max < spec.volume_min ||
      !Number.isFinite(spec.volume_step) ||
      spec.volume_step <= 0
    ) {
      reject("MT5 tick-value or volume constraints are invalid");
    } else if (
      metrics.entry_price !== null &&
      metrics.stop_loss_price !== null &&
      metrics.risk_budget !== null
    ) {
      if (metrics.stop_loss_price <= 0) {
        reject("Calculated stop-loss price is invalid");
      } else if (
        metrics.take_profit_price === null ||
        metrics.take_profit_price <= 0
      ) {
        reject("Calculated take-profit price is invalid");
      } else {
        const priceDistance = Math.abs(
          metrics.entry_price - metrics.stop_loss_price
        );
        metrics.risk_per_lot =
          (priceDistance / spec.tick_size) * spec.tick_value_loss;
        if (
          !Number.isFinite(metrics.risk_per_lot) ||
          metrics.risk_per_lot <= 0
        ) {
          reject("Calculated monetary risk per lot is invalid");
        } else {
          metrics.raw_volume = metrics.risk_budget / metrics.risk_per_lot;
          const cappedVolume = Math.min(metrics.raw_volume, spec.volume_max);
          const steps = Math.floor(
            (cappedVolume + spec.volume_step * 1e-10) / spec.volume_step
          );
          const precision = precisionForStep(spec.volume_step);
          let volume = Number((steps * spec.volume_step).toFixed(precision));
          while (
            volume >= spec.volume_min &&
            (
              volume > spec.volume_max ||
              metrics.risk_per_lot * volume > metrics.risk_budget
            )
          ) {
            volume = Number((volume - spec.volume_step).toFixed(precision));
          }

          if (volume < spec.volume_min) {
            reject("Risk budget is below the broker's minimum volume");
          } else {
            metrics.volume = volume;
            metrics.estimated_loss = metrics.risk_per_lot * volume;
            if (metrics.equity !== null) {
              metrics.estimated_risk_pct =
                (metrics.estimated_loss / metrics.equity) * 100;
            }
          }
        }
      }
    }
  }

  if (reasons.length) {
    metrics.volume = null;
    metrics.estimated_loss = null;
    metrics.estimated_risk_pct = null;
  }

  return {
    signal_id: candidate.signal_id,
    symbol: candidate.symbol,
    timeframe: candidate.timeframe,
    strategy: candidate.strategy,
    strategy_version: candidate.strategy_version,
    direction,
    decision: reasons.length
      ? "REJECTED"
      : input.tradingEnabled
        ? "SIZED_FOR_DEMO_EXECUTION"
        : "SIZED_FOR_PAPER_REVIEW",
    reasons,
    metrics,
    as_of: candidate.as_of,
    checked_at: new Date(input.nowMs).toISOString(),
    execution_enabled: false
  };
}
