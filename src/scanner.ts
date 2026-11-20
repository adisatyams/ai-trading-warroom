// Deterministic scanner SNAPSHOT_MOMENTUM_V1.
//
// Pure module: no Cloudflare bindings, no I/O, no clock access. All inputs are
// passed in, so every result can be reproduced and unit-tested.
//
// The scanner produces RESEARCH CANDIDATES only. It never sends orders and its
// score is a rule score, not a probability of profit.

export const STRATEGY = "SNAPSHOT_MOMENTUM_V1";
export const STRATEGY_VERSION = "1.0.0";

export type ScannerState =
  | "BUY"
  | "SELL"
  | "WATCH"
  | "WARMING_UP"
  | "REJECTED";

export type RejectReason =
  | "STALE_DATA"
  | "INVALID_PRICE"
  | "SPREAD_TOO_WIDE"
  | "OUT_OF_ORDER";

export interface Observation {
  symbol: string;
  bid: number;
  ask: number;
  /** Receive time (ISO 8601) set by the Worker; defines observation order. */
  received_at: string;
  /** Exchange/MT5 tick time (ISO 8601), if known. */
  tick_time?: string | null;
}

export interface ScannerConfig {
  shortWindow: number;
  longWindow: number;
  momentumLookback: number;
  /** Observations further apart than this start a new contiguous series. */
  maxGapSeconds: number;
  /** Latest observation (or tick) older than this is stale. */
  staleSeconds: number;
  /** Trend (SMA short vs long) must exceed this many bps... */
  minTrendBps: number;
  /** ...and momentum must exceed this many bps... */
  minMomentumBps: number;
  /** ...and trend must also exceed spread * this multiple (cost awareness). */
  spreadMultiple: number;
  /** Default spread ceiling in bps when a symbol has no specific limit. */
  defaultMaxSpreadBps: number;
  maxSpreadBpsBySymbol: Record<string, number>;
}

// NOTE: starting values chosen for explainability, NOT tuned or backtested.
// Spread ceilings are assumptions for Exness demo symbols; review them against
// real spreads observed in market_observations before trusting any signal.
export const DEFAULT_CONFIG: ScannerConfig = {
  shortWindow: 5,
  longWindow: 20,
  momentumLookback: 5,
  maxGapSeconds: 300,
  staleSeconds: 150,
  minTrendBps: 0.3,
  minMomentumBps: 0.3,
  spreadMultiple: 1.0,
  defaultMaxSpreadBps: 4,
  maxSpreadBpsBySymbol: {
    XAUUSD: 8,
    BTCUSD: 20,
    ETHUSD: 25
  }
};

export interface ScannerFeatures {
  observations_used: number;
  contiguous_observations: number;
  mid: number | null;
  sma_short: number | null;
  sma_long: number | null;
  trend_bps: number | null;
  momentum_bps: number | null;
  spread_bps: number | null;
  max_spread_bps: number | null;
  age_seconds: number | null;
  window_seconds: number | null;
}

export interface ScannerResult {
  signal_id: string;
  symbol: string;
  strategy: string;
  strategy_version: string;
  state: ScannerState;
  reject_reason: RejectReason | null;
  /** 0-100 rule score for BUY/SELL only; null otherwise. Not a probability. */
  score: number | null;
  /** Timestamp of the newest observation this result is based on. */
  as_of: string | null;
  features: ScannerFeatures;
  reasons: string[];
}

const BPS = 10_000;

export function isValidQuote(bid: unknown, ask: unknown): boolean {
  return (
    typeof bid === "number" &&
    typeof ask === "number" &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0 &&
    ask >= bid
  );
}

export function midPrice(o: Pick<Observation, "bid" | "ask">): number {
  return (o.bid + o.ask) / 2;
}

export function spreadBps(o: Pick<Observation, "bid" | "ask">): number {
  return ((o.ask - o.bid) / midPrice(o)) * BPS;
}

function sma(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function round(n: number | null, digits = 4): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Deterministic id: the same symbol + newest observation always yields the same id. */
export function signalId(symbol: string, asOf: string | null): string {
  return `${STRATEGY}:${symbol}:${asOf ?? "none"}`;
}

function emptyFeatures(): ScannerFeatures {
  return {
    observations_used: 0,
    contiguous_observations: 0,
    mid: null,
    sma_short: null,
    sma_long: null,
    trend_bps: null,
    momentum_bps: null,
    spread_bps: null,
    max_spread_bps: null,
    age_seconds: null,
    window_seconds: null
  };
}

function result(
  symbol: string,
  asOf: string | null,
  state: ScannerState,
  features: ScannerFeatures,
  reasons: string[],
  extra: { reject_reason?: RejectReason; score?: number } = {}
): ScannerResult {
  return {
    signal_id: signalId(symbol, asOf),
    symbol,
    strategy: STRATEGY,
    strategy_version: STRATEGY_VERSION,
    state,
    reject_reason: extra.reject_reason ?? null,
    score: extra.score ?? null,
    as_of: asOf,
    features,
    reasons
  };
}

/** Reject result for a tick that failed validation before becoming an observation. */
export function rejectInvalidTick(
  symbol: string,
  receivedAt: string,
  detail: string
): ScannerResult {
  return result(
    symbol,
    receivedAt,
    "REJECTED",
    emptyFeatures(),
    [`Invalid price data: ${detail}`],
    { reject_reason: "INVALID_PRICE" }
  );
}

/**
 * Evaluate one symbol.
 *
 * @param symbol        instrument name
 * @param observations  chronological order, OLDEST FIRST
 * @param nowMs         current time in epoch ms (injected for determinism)
 */
export function evaluate(
  symbol: string,
  observations: Observation[],
  nowMs: number,
  config: ScannerConfig = DEFAULT_CONFIG
): ScannerResult {
  const features = emptyFeatures();

  if (observations.length === 0) {
    return result(symbol, null, "WARMING_UP", features, [
      "No observations yet"
    ]);
  }

  const latest = observations[observations.length - 1];
  const asOf = latest.received_at;
  features.observations_used = observations.length;

  // 1. Every observation must be a valid quote.
  for (const o of observations) {
    if (!isValidQuote(o.bid, o.ask)) {
      return result(
        symbol,
        asOf,
        "REJECTED",
        features,
        [`Invalid quote in series (bid=${o.bid}, ask=${o.ask})`],
        { reject_reason: "INVALID_PRICE" }
      );
    }
  }

  // 2. Strict chronological order (received_at, and tick_time when present).
  for (let i = 1; i < observations.length; i++) {
    const prev = observations[i - 1];
    const cur = observations[i];
    const pr = Date.parse(prev.received_at);
    const cr = Date.parse(cur.received_at);
    if (!Number.isFinite(pr) || !Number.isFinite(cr) || cr <= pr) {
      return result(
        symbol,
        asOf,
        "REJECTED",
        features,
        [`Observations out of order at index ${i}`],
        { reject_reason: "OUT_OF_ORDER" }
      );
    }
    if (prev.tick_time && cur.tick_time) {
      const pt = Date.parse(prev.tick_time);
      const ct = Date.parse(cur.tick_time);
      if (Number.isFinite(pt) && Number.isFinite(ct) && ct < pt) {
        return result(
          symbol,
          asOf,
          "REJECTED",
          features,
          [`Tick time moved backwards at index ${i}`],
          { reject_reason: "OUT_OF_ORDER" }
        );
      }
    }
  }

  // 3. Freshness of the newest observation. A frozen tick time (e.g. market
  //    closed while the bridge keeps polling) is also treated as stale.
  const ageSeconds = (nowMs - Date.parse(latest.received_at)) / 1000;
  features.age_seconds = round(ageSeconds, 1);

  let tickAgeSeconds: number | null = null;
  if (latest.tick_time) {
    const t = Date.parse(latest.tick_time);
    if (Number.isFinite(t)) tickAgeSeconds = (nowMs - t) / 1000;
  }

  if (!Number.isFinite(ageSeconds) || ageSeconds > config.staleSeconds) {
    return result(
      symbol,
      asOf,
      "REJECTED",
      features,
      [`Latest observation is ${Math.round(ageSeconds)}s old (limit ${config.staleSeconds}s)`],
      { reject_reason: "STALE_DATA" }
    );
  }
  if (tickAgeSeconds !== null && tickAgeSeconds > config.staleSeconds) {
    return result(
      symbol,
      asOf,
      "REJECTED",
      features,
      [`Latest tick time is ${Math.round(tickAgeSeconds)}s old; market may be closed or feed frozen`],
      { reject_reason: "STALE_DATA" }
    );
  }

  // 4. Spread guard on the newest quote.
  const mid = midPrice(latest);
  const spread = spreadBps(latest);
  const maxSpread =
    config.maxSpreadBpsBySymbol[symbol] ?? config.defaultMaxSpreadBps;
  features.mid = round(mid, 8);
  features.spread_bps = round(spread, 3);
  features.max_spread_bps = maxSpread;

  if (spread > maxSpread) {
    return result(
      symbol,
      asOf,
      "REJECTED",
      features,
      [`Spread ${spread.toFixed(2)} bps exceeds limit ${maxSpread} bps`],
      { reject_reason: "SPREAD_TOO_WIDE" }
    );
  }

  // 5. Use only the contiguous tail: a gap larger than maxGapSeconds (outage,
  //    weekend, restart) starts a new series so old prices never leak into SMAs.
  let start = observations.length - 1;
  while (start > 0) {
    const gap =
      (Date.parse(observations[start].received_at) -
        Date.parse(observations[start - 1].received_at)) /
      1000;
    if (gap > config.maxGapSeconds) break;
    start--;
  }
  const series = observations.slice(start);
  features.contiguous_observations = series.length;

  const needed = Math.max(config.longWindow, config.momentumLookback + 1);
  if (series.length < needed) {
    return result(symbol, asOf, "WARMING_UP", features, [
      `Need ${needed} contiguous observations, have ${series.length}`
    ]);
  }

  // 6. Features.
  const mids = series.map(midPrice);
  const smaShort = sma(mids.slice(-config.shortWindow));
  const smaLong = sma(mids.slice(-config.longWindow));
  const past = mids[mids.length - 1 - config.momentumLookback];
  const trendBps = ((smaShort - smaLong) / smaLong) * BPS;
  const momentumBps = ((mid - past) / past) * BPS;

  features.sma_short = round(smaShort, 8);
  features.sma_long = round(smaLong, 8);
  features.trend_bps = round(trendBps, 3);
  features.momentum_bps = round(momentumBps, 3);
  features.window_seconds = round(
    (Date.parse(latest.received_at) -
      Date.parse(series[series.length - config.longWindow].received_at)) /
      1000,
    1
  );

  // 7. Rules. Trend, momentum and price position must all agree, and the trend
  //    must be bigger than the cost of crossing the spread.
  const trendThreshold = Math.max(
    config.minTrendBps,
    spread * config.spreadMultiple
  );

  const up =
    trendBps >= trendThreshold &&
    momentumBps >= config.minMomentumBps &&
    mid > smaShort;
  const down =
    trendBps <= -trendThreshold &&
    momentumBps <= -config.minMomentumBps &&
    mid < smaShort;

  if (!up && !down) {
    return result(symbol, asOf, "WATCH", features, [
      `Signals not aligned: trend ${trendBps.toFixed(2)} bps (need ±${trendThreshold.toFixed(2)}), ` +
        `momentum ${momentumBps.toFixed(2)} bps (need ±${config.minMomentumBps}), ` +
        `price ${mid > smaShort ? "above" : mid < smaShort ? "below" : "at"} SMA${config.shortWindow}`
    ]);
  }

  // 8. Rule score 0-100 (NOT a probability): trend strength, momentum strength
  //    and spread quality.
  const trendStrength = clamp01(Math.abs(trendBps) / (3 * trendThreshold));
  const momentumStrength = clamp01(
    Math.abs(momentumBps) / (3 * config.minMomentumBps)
  );
  const spreadQuality = clamp01(1 - spread / maxSpread);
  const score = Math.round(
    40 * trendStrength + 40 * momentumStrength + 20 * spreadQuality
  );

  const dir = up ? "BUY" : "SELL";
  return result(
    symbol,
    asOf,
    dir,
    features,
    [
      `${up ? "Uptrend" : "Downtrend"}: SMA${config.shortWindow} ${up ? ">" : "<"} SMA${config.longWindow} by ${Math.abs(trendBps).toFixed(2)} bps`,
      `Momentum ${momentumBps.toFixed(2)} bps over ${config.momentumLookback} observations`,
      `Price ${up ? "above" : "below"} SMA${config.shortWindow}; spread ${spread.toFixed(2)} bps`
    ],
    { score }
  );
}
