import {
  STRATEGY,
  STRATEGY_VERSION,
  type ScannerTimeframe,
  type Observation
} from "./scanner.ts";

export type RiskDecision =
  | "ELIGIBLE_FOR_PAPER_REVIEW"
  | "ELIGIBLE_FOR_DEMO_EXECUTION"
  | "REJECTED";

export interface RiskCandidate {
  signal_id: string;
  symbol: string;
  timeframe: ScannerTimeframe | "M1";
  strategy: string;
  strategy_version: string;
  state: string;
  as_of: string | null;
  features: {
    spread_bps?: number | null;
  };
}

export interface CalendarEvent {
  event_id: string;
  name: string;
  currency: string;
  importance: string;
  scheduled_at: string;
}

export interface OpenPosition {
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
}

export interface RiskContext {
  nowMs: number;
  paperMode: boolean;
  tradingEnabled: boolean;
  bridge: {
    connected: boolean;
    demo: boolean;
    received_at: string;
  } | null;
  observations: Observation[];
  calendar: {
    available: boolean;
    received_at: string;
  } | null;
  calendarEvents: CalendarEvent[];
  positions: {
    captured_at: string;
    items: OpenPosition[];
  } | null;
  dailyEquity: {
    start_equity: number;
    start_at: string;
    current_equity: number;
    current_at: string;
    peak_equity: number;
  } | null;
}

export interface RiskConfig {
  staleSeconds: number;
  maxGapSeconds: number;
  maxDailyLossPct: number;
  maxDailyDrawdownPct: number;
  maxOpenPositions: number;
  newsBlackoutMinutes: number;
  volatilitySpikeMultiple: number;
  defaultMaxSpreadBps: number;
  maxSpreadBpsBySymbol: Record<string, number>;
}

export interface RiskResult {
  signal_id: string;
  symbol: string;
  timeframe: ScannerTimeframe | "M1";
  strategy: string;
  strategy_version: string;
  scanner_state: string;
  decision: RiskDecision;
  reasons: string[];
  checks: Record<string, boolean>;
  metrics: {
    signal_age_seconds: number | null;
    spread_bps: number | null;
    max_spread_bps: number;
    latest_move_bps: number | null;
    historical_median_move_bps: number | null;
    open_positions: number | null;
    daily_loss_pct: number | null;
    daily_drawdown_pct: number | null;
  };
  as_of: string | null;
  checked_at: string;
  execution_enabled: false;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  staleSeconds: 150,
  maxGapSeconds: 300,
  maxDailyLossPct: 2,
  maxDailyDrawdownPct: 3,
  maxOpenPositions: 3,
  newsBlackoutMinutes: 15,
  volatilitySpikeMultiple: 3,
  defaultMaxSpreadBps: 4,
  maxSpreadBpsBySymbol: {
    XAUUSD: 8,
    BTCUSD: 20,
    ETHUSD: 25
  }
};

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD"];
const KNOWN_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "XAUUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "BTCUSD",
  "ETHUSD"
];
const MIN_VOLATILITY_OBSERVATIONS = 21;
const MAX_DAILY_BASELINE_DELAY_SECONDS = 120;
const TIMEFRAME_SECONDS: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  H1: 3_600,
  H4: 14_400
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function currenciesForSymbol(symbol: string): Set<string> {
  const normalized = symbol.toUpperCase();
  return new Set(CURRENCIES.filter(currency => normalized.includes(currency)));
}

function normalizedSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase();
  return KNOWN_SYMBOLS.find(base => normalized.startsWith(base)) ?? normalized;
}

function ageSeconds(timestamp: string, nowMs: number): number {
  return (nowMs - Date.parse(timestamp)) / 1000;
}

function assessVolatility(
  observations: Observation[],
  nowMs: number,
  config: RiskConfig
): {
  ok: boolean;
  latestMoveBps: number | null;
  medianMoveBps: number | null;
  reason?: string;
} {
  if (observations.length < MIN_VOLATILITY_OBSERVATIONS) {
    return {
      ok: false,
      latestMoveBps: null,
      medianMoveBps: null,
      reason: `Need ${MIN_VOLATILITY_OBSERVATIONS} contiguous observations for volatility check`
    };
  }

  const series = observations.slice(-MIN_VOLATILITY_OBSERVATIONS);
  const latestAge = ageSeconds(
    series[series.length - 1].received_at,
    nowMs
  );
  if (!Number.isFinite(latestAge) || latestAge < 0 || latestAge > config.staleSeconds) {
    return {
      ok: false,
      latestMoveBps: null,
      medianMoveBps: null,
      reason: "Latest volatility observation is stale or has an invalid timestamp"
    };
  }

  for (let i = 1; i < series.length; i++) {
    const previous = series[i - 1];
    const current = series[i];
    const gap = (Date.parse(current.received_at) - Date.parse(previous.received_at)) / 1000;
    const previousMid = (previous.bid + previous.ask) / 2;
    const currentMid = (current.bid + current.ask) / 2;
    if (
      !Number.isFinite(gap) ||
      gap <= 0 ||
      gap > config.maxGapSeconds ||
      !Number.isFinite(previousMid) ||
      !Number.isFinite(currentMid) ||
      previousMid <= 0 ||
      currentMid <= 0
    ) {
      return {
        ok: false,
        latestMoveBps: null,
        medianMoveBps: null,
        reason: "Volatility observations are invalid or not contiguous"
      };
    }
  }

  const moves = series.slice(1).map((current, index) => {
    const previous = series[index];
    const previousMid = (previous.bid + previous.ask) / 2;
    const currentMid = (current.bid + current.ask) / 2;
    return Math.abs(((currentMid - previousMid) / previousMid) * 10_000);
  });
  const latestMoveBps = moves[moves.length - 1];
  const medianMoveBps = median(moves.slice(0, -1));
  const ok = latestMoveBps <= medianMoveBps * config.volatilitySpikeMultiple;

  return {
    ok,
    latestMoveBps,
    medianMoveBps,
    reason: ok
      ? undefined
      : `Latest move ${latestMoveBps.toFixed(3)} bps exceeds ${config.volatilitySpikeMultiple}x median ${medianMoveBps.toFixed(3)} bps`
  };
}

export function evaluateRisk(
  candidate: RiskCandidate,
  context: RiskContext,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): RiskResult {
  const reasons: string[] = [];
  const checks: Record<string, boolean> = {};
  const spread = candidate.features.spread_bps;
  const configuredSymbol = Object.keys(config.maxSpreadBpsBySymbol).find(
    symbol => candidate.symbol.toUpperCase().startsWith(symbol.toUpperCase())
  );
  const maxSpread =
    (configuredSymbol
      ? config.maxSpreadBpsBySymbol[configuredSymbol]
      : undefined) ??
    config.defaultMaxSpreadBps;
  let latestMoveBps: number | null = null;
  let medianMoveBps: number | null = null;
  let openPositionCount: number | null = null;
  let dailyLossPct: number | null = null;
  let dailyDrawdownPct: number | null = null;
  const timeframeSeconds = TIMEFRAME_SECONDS[candidate.timeframe];
  const signalAge =
    candidate.as_of === null
      ? null
      : ageSeconds(candidate.as_of, context.nowMs);

  const reject = (check: string, reason: string) => {
    checks[check] = false;
    reasons.push(reason);
  };
  const pass = (check: string) => {
    checks[check] = true;
  };

  if (candidate.state !== "BUY" && candidate.state !== "SELL") {
    reject("strategy", `Scanner state ${candidate.state} is not actionable`);
  } else if (
    candidate.strategy !== STRATEGY ||
    candidate.strategy_version !== STRATEGY_VERSION
  ) {
    reject("strategy", "Scanner strategy or version is not approved");
  } else {
    pass("strategy");
  }

  const signalFreshnessLimit = Math.max(
    config.staleSeconds,
    (timeframeSeconds ?? 60) * 2
  );
  if (
    signalAge === null ||
    !Number.isFinite(signalAge) ||
    signalAge < 0 ||
    signalAge > signalFreshnessLimit
  ) {
    reject(
      "signal_freshness",
      `Scanner signal is missing or stale (limit ${signalFreshnessLimit}s for ${candidate.timeframe})`
    );
  } else {
    pass("signal_freshness");
  }

  if (!context.paperMode) {
    reject("safety", "PAPER_MODE=true is required for demo execution");
  } else {
    pass("safety");
  }

  if (
    !context.bridge ||
    !context.bridge.connected ||
    !context.bridge.demo ||
    ageSeconds(context.bridge.received_at, context.nowMs) < 0 ||
    ageSeconds(context.bridge.received_at, context.nowMs) > config.staleSeconds
  ) {
    reject("bridge", "Fresh connected MT5 demo heartbeat is required");
  } else {
    pass("bridge");
  }

  if (
    typeof spread !== "number" ||
    !Number.isFinite(spread) ||
    spread > maxSpread
  ) {
    reject(
      "spread",
      `Spread ${typeof spread === "number" ? spread.toFixed(3) : "unknown"} bps exceeds limit ${maxSpread} bps`
    );
  } else {
    pass("spread");
  }

  const volatility = assessVolatility(
    context.observations,
    context.nowMs,
    config
  );
  latestMoveBps = volatility.latestMoveBps;
  medianMoveBps = volatility.medianMoveBps;
  if (!volatility.ok) {
    reject("volatility", volatility.reason ?? "Volatility check failed");
  } else {
    pass("volatility");
  }

  if (
    !context.calendar ||
    !context.calendar.available ||
    ageSeconds(context.calendar.received_at, context.nowMs) < 0 ||
    ageSeconds(context.calendar.received_at, context.nowMs) > config.staleSeconds
  ) {
    reject("news", "MT5 economic calendar data is missing, unavailable, or stale");
  } else {
    const currencies = currenciesForSymbol(candidate.symbol);
    const blackoutMs = config.newsBlackoutMinutes * 60_000;
    const activeEvent = context.calendarEvents.find(event => {
      const eventTime = Date.parse(event.scheduled_at);
      return (
        event.importance === "HIGH" &&
        currencies.has(event.currency.toUpperCase()) &&
        Number.isFinite(eventTime) &&
        Math.abs(eventTime - context.nowMs) <= blackoutMs
      );
    });
    if (activeEvent) {
      reject(
        "news",
        `High-impact ${activeEvent.currency} event "${activeEvent.name}" is within the ${config.newsBlackoutMinutes}-minute blackout`
      );
    } else {
      pass("news");
    }
  }

  if (
    !context.positions ||
    ageSeconds(context.positions.captured_at, context.nowMs) < 0 ||
    ageSeconds(context.positions.captured_at, context.nowMs) > config.staleSeconds
  ) {
    reject("positions", "Fresh MT5 open-position snapshot is required");
  } else {
    openPositionCount = context.positions.items.length;
    if (
      context.positions.items.some(position =>
        normalizedSymbol(position.symbol) === normalizedSymbol(candidate.symbol)
      )
    ) {
      reject("positions", `An open position already exists for ${candidate.symbol}`);
    } else if (openPositionCount >= config.maxOpenPositions) {
      reject(
        "positions",
        `${openPositionCount} positions are already open (maximum ${config.maxOpenPositions})`
      );
    } else {
      pass("positions");
    }
  }

  const daily = context.dailyEquity;
  if (!daily) {
    reject("daily_loss", "UTC-day equity history is unavailable");
    reject("daily_drawdown", "UTC-day equity history is unavailable");
  } else {
    const dayStartMs = Date.UTC(
      new Date(context.nowMs).getUTCFullYear(),
      new Date(context.nowMs).getUTCMonth(),
      new Date(context.nowMs).getUTCDate()
    );
    const baselineDelay = (Date.parse(daily.start_at) - dayStartMs) / 1000;
    const currentAge = ageSeconds(daily.current_at, context.nowMs);
    if (
      !Number.isFinite(daily.start_equity) ||
      !Number.isFinite(daily.current_equity) ||
      !Number.isFinite(daily.peak_equity) ||
      daily.start_equity <= 0 ||
      daily.current_equity <= 0 ||
      daily.peak_equity <= 0 ||
      !Number.isFinite(baselineDelay) ||
      baselineDelay < 0 ||
      baselineDelay > MAX_DAILY_BASELINE_DELAY_SECONDS ||
      !Number.isFinite(currentAge) ||
      currentAge < 0 ||
      currentAge > config.staleSeconds
    ) {
      reject("daily_loss", "Fresh UTC-day equity baseline and current equity are required");
      reject("daily_drawdown", "Fresh UTC-day equity baseline and current equity are required");
    } else {
      dailyLossPct =
        ((daily.start_equity - daily.current_equity) / daily.start_equity) * 100;
      dailyDrawdownPct =
        ((daily.peak_equity - daily.current_equity) / daily.peak_equity) * 100;

      if (dailyLossPct >= config.maxDailyLossPct) {
        reject(
          "daily_loss",
          `Daily loss ${dailyLossPct.toFixed(3)}% reached the ${config.maxDailyLossPct}% limit`
        );
      } else {
        pass("daily_loss");
      }

      if (dailyDrawdownPct >= config.maxDailyDrawdownPct) {
        reject(
          "daily_drawdown",
          `Daily drawdown ${dailyDrawdownPct.toFixed(3)}% reached the ${config.maxDailyDrawdownPct}% limit`
        );
      } else {
        pass("daily_drawdown");
      }
    }
  }

  return {
    signal_id: candidate.signal_id,
    symbol: candidate.symbol,
    timeframe: candidate.timeframe,
    strategy: candidate.strategy,
    strategy_version: candidate.strategy_version,
    scanner_state: candidate.state,
    decision: reasons.length
      ? "REJECTED"
      : context.tradingEnabled
        ? "ELIGIBLE_FOR_DEMO_EXECUTION"
        : "ELIGIBLE_FOR_PAPER_REVIEW",
    reasons,
    checks,
    metrics: {
      signal_age_seconds:
        signalAge !== null && Number.isFinite(signalAge)
          ? signalAge
          : null,
      spread_bps:
        typeof spread === "number" && Number.isFinite(spread) ? spread : null,
      max_spread_bps: maxSpread,
      latest_move_bps: latestMoveBps,
      historical_median_move_bps: medianMoveBps,
      open_positions: openPositionCount,
      daily_loss_pct: dailyLossPct,
      daily_drawdown_pct: dailyDrawdownPct
    },
    as_of: candidate.as_of,
    checked_at: new Date(context.nowMs).toISOString(),
    execution_enabled: false
  };
}
