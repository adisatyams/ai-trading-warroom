// Deterministic multi-timeframe scanner.
//
// Pure module: no Cloudflare bindings, no I/O, no clock access. All inputs are
// passed in, so every result can be reproduced and unit-tested.
//
// The scanner produces RESEARCH CANDIDATES only. It never sends orders and its
// score is a rule score, not a probability of profit.

export const STRATEGY = "MULTI_TIMEFRAME_INDICATORS_V1";
export const STRATEGY_VERSION = "1.0.0";
export const LEGACY_STRATEGY = "SNAPSHOT_MOMENTUM_V1";

export const SCANNER_TIMEFRAMES = ["M5", "M15", "H1", "H4"] as const;
export type ScannerTimeframe = typeof SCANNER_TIMEFRAMES[number];

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
  | "OUT_OF_ORDER"
  | "INVALID_CANDLES"
  | "STALE_CANDLES"
  | "MISSING_QUOTE";

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
  emaShortPeriod: number;
  emaMediumPeriod: number;
  emaLongPeriod: number;
  rsiPeriod: number;
  macdFastPeriod: number;
  macdSlowPeriod: number;
  macdSignalPeriod: number;
  atrPeriod: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  minSignalScore: number;
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
  },
  emaShortPeriod: 20,
  emaMediumPeriod: 50,
  emaLongPeriod: 200,
  rsiPeriod: 14,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  atrPeriod: 14,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  minSignalScore: 70
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
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_histogram: number | null;
  atr14: number | null;
  atr_ratio: number | null;
  bollinger_upper: number | null;
  bollinger_middle: number | null;
  bollinger_lower: number | null;
  buy_score: number | null;
  sell_score: number | null;
}

export interface ScannerResult {
  signal_id: string;
  symbol: string;
  timeframe: ScannerTimeframe | "M1";
  strategy: string;
  strategy_version: string;
  state: ScannerState;
  reject_reason: RejectReason | null;
  /** 0-100 heuristic score; not a probability of profit. */
  score: number | null;
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  /** Timestamp of the newest observation this result is based on. */
  as_of: string | null;
  features: ScannerFeatures;
  reasons: string[];
}

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume?: number;
}

export interface ScannerQuote {
  bid: number;
  ask: number;
  received_at: string;
}

const BPS = 10_000;
const TIMEFRAME_SECONDS: Record<ScannerTimeframe, number> = {
  M5: 300,
  M15: 900,
  H1: 3_600,
  H4: 14_400
};

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

function maxSpreadForSymbol(
  symbol: string,
  config: ScannerConfig
): number {
  const exact = config.maxSpreadBpsBySymbol[symbol];
  if (exact !== undefined) return exact;

  const normalized = symbol.toUpperCase();
  const prefix = Object.keys(config.maxSpreadBpsBySymbol).find(key =>
    normalized.startsWith(key.toUpperCase())
  );
  return prefix
    ? config.maxSpreadBpsBySymbol[prefix]
    : config.defaultMaxSpreadBps;
}

/** Deterministic id: the same symbol + newest observation always yields the same id. */
export function signalId(
  symbol: string,
  asOf: string | null,
  timeframe: ScannerTimeframe | "M1" = "M1",
  strategy = STRATEGY
): string {
  return `${strategy}:${symbol}:${timeframe}:${asOf ?? "none"}`;
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
    window_seconds: null,
    ema20: null,
    ema50: null,
    ema200: null,
    rsi14: null,
    macd: null,
    macd_signal: null,
    macd_histogram: null,
    atr14: null,
    atr_ratio: null,
    bollinger_upper: null,
    bollinger_middle: null,
    bollinger_lower: null,
    buy_score: null,
    sell_score: null
  };
}

function result(
  symbol: string,
  asOf: string | null,
  state: ScannerState,
  features: ScannerFeatures,
  reasons: string[],
  extra: {
    reject_reason?: RejectReason;
    score?: number;
    timeframe?: ScannerTimeframe | "M1";
    strategy?: string;
    entry?: number | null;
    stop_loss?: number | null;
    take_profit?: number | null;
  } = {}
): ScannerResult {
  const timeframe = extra.timeframe ?? "M1";
  return {
    signal_id: signalId(symbol, asOf, timeframe, extra.strategy ?? LEGACY_STRATEGY),
    symbol,
    timeframe,
    strategy: extra.strategy ?? LEGACY_STRATEGY,
    strategy_version: STRATEGY_VERSION,
    state,
    reject_reason: extra.reject_reason ?? null,
    score: extra.score ?? null,
    entry: extra.entry ?? null,
    stop_loss: extra.stop_loss ?? null,
    take_profit: extra.take_profit ?? null,
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
/** Legacy observation-only evaluator; production uses evaluateTimeframe. */
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
  const maxSpread = maxSpreadForSymbol(symbol, config);
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

function emaSeries(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;

  let average = sma(values.slice(0, period));
  output[period - 1] = average;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index++) {
    average = values[index] * multiplier + average * (1 - multiplier);
    output[index] = average;
  }
  return output;
}

function rsiSeries(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return output;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const currentRsi = () =>
    averageLoss === 0
      ? averageGain === 0 ? 50 : 100
      : 100 - 100 / (1 + averageGain / averageLoss);
  output[period] = currentRsi();

  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    averageGain =
      (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss =
      (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = currentRsi();
  }
  return output;
}

function atrSeries(candles: Candle[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length <= period) return output;
  const trueRanges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  let atr =
    trueRanges.slice(0, period).reduce((sum, range) => sum + range, 0) /
    period;
  output[period] = atr;
  for (let index = period + 1; index < candles.length; index++) {
    atr = (atr * (period - 1) + trueRanges[index - 1]) / period;
    output[index] = atr;
  }
  return output;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validCandle(candle: Candle): boolean {
  return (
    typeof candle.time === "string" &&
    Number.isFinite(Date.parse(candle.time)) &&
    [candle.open, candle.high, candle.low, candle.close].every(
      value => Number.isFinite(value) && value > 0
    ) &&
    candle.high >= candle.low &&
    candle.high >= candle.open &&
    candle.high >= candle.close &&
    candle.low <= candle.open &&
    candle.low <= candle.close
  );
}

/**
 * Score a completed-candle snapshot for one symbol/timeframe. The weighted
 * score is a deterministic heuristic, not a probability of profit.
 */
export function evaluateTimeframe(
  symbol: string,
  timeframe: ScannerTimeframe,
  candles: Candle[],
  quote: ScannerQuote | null,
  nowMs: number,
  m1Atr: number | null,
  config: ScannerConfig = DEFAULT_CONFIG
): ScannerResult {
  const asOf = candles.length ? candles[candles.length - 1].time : null;
  const features = emptyFeatures();
  const finish = (
    state: ScannerState,
    reasons: string[],
    extra: {
      reject_reason?: RejectReason;
      score?: number;
      entry?: number | null;
      stop_loss?: number | null;
      take_profit?: number | null;
    } = {}
  ) => result(symbol, asOf, state, features, reasons, {
    ...extra,
    timeframe,
    strategy: STRATEGY
  });

  if (candles.length < config.emaLongPeriod) {
    return finish("WARMING_UP", [
      `Need ${config.emaLongPeriod} completed ${timeframe} candles for EMA${config.emaLongPeriod}; have ${candles.length}`
    ]);
  }
  for (let index = 0; index < candles.length; index++) {
    if (!validCandle(candles[index])) {
      return finish("REJECTED", [`Invalid OHLC candle at index ${index}`], {
        reject_reason: "INVALID_CANDLES"
      });
    }
    if (
      index > 0 &&
      Date.parse(candles[index].time) <= Date.parse(candles[index - 1].time)
    ) {
      return finish(
        "REJECTED",
        [`Candle times are not strictly increasing at index ${index}`],
        { reject_reason: "INVALID_CANDLES" }
      );
    }
  }

  const latest = candles[candles.length - 1];
  const candleAge = (nowMs - Date.parse(latest.time)) / 1000;
  const maxCandleAge = Math.max(
    config.staleSeconds,
    TIMEFRAME_SECONDS[timeframe] * 2
  );
  features.age_seconds = round(candleAge, 1);
  if (
    !Number.isFinite(candleAge) ||
    candleAge < 0 ||
    candleAge > maxCandleAge
  ) {
    return finish(
      "REJECTED",
      [`Latest ${timeframe} candle is stale (${Math.round(candleAge)}s; limit ${maxCandleAge}s)`],
      { reject_reason: "STALE_CANDLES" }
    );
  }
  if (
    !quote ||
    !isValidQuote(quote.bid, quote.ask) ||
    !Number.isFinite(Date.parse(quote.received_at)) ||
    (nowMs - Date.parse(quote.received_at)) / 1000 < 0 ||
    (nowMs - Date.parse(quote.received_at)) / 1000 > config.staleSeconds
  ) {
    return finish("REJECTED", ["A fresh valid quote is required"], {
      reject_reason: "MISSING_QUOTE"
    });
  }

  const spread = spreadBps(quote);
  const maxSpread = maxSpreadForSymbol(symbol, config);
  const mid = midPrice(quote);
  features.observations_used = candles.length;
  features.contiguous_observations = candles.length;
  features.mid = round(mid, 8);
  features.spread_bps = round(spread, 3);
  features.max_spread_bps = maxSpread;
  if (spread > maxSpread) {
    return finish(
      "REJECTED",
      [`Spread ${spread.toFixed(2)} bps exceeds limit ${maxSpread} bps`],
      { reject_reason: "SPREAD_TOO_WIDE" }
    );
  }

  const closes = candles.map(candle => candle.close);
  const emaShortSeries = emaSeries(closes, config.emaShortPeriod);
  const emaMediumSeries = emaSeries(closes, config.emaMediumPeriod);
  const emaLongSeries = emaSeries(closes, config.emaLongPeriod);
  const last = candles.length - 1;
  const emaShort = emaShortSeries[last];
  const emaMedium = emaMediumSeries[last];
  const emaLong = emaLongSeries[last];
  const fast = emaSeries(closes, config.macdFastPeriod);
  const slow = emaSeries(closes, config.macdSlowPeriod);
  const macdValues: number[] = [];
  for (let index = 0; index < closes.length; index++) {
    if (fast[index] !== null && slow[index] !== null) {
      macdValues.push(fast[index]! - slow[index]!);
    }
  }
  const macdSignalSeries = emaSeries(macdValues, config.macdSignalPeriod);
  const macd = macdValues.length ? macdValues[macdValues.length - 1] : null;
  const macdSignal = macdSignalSeries.length
    ? macdSignalSeries[macdSignalSeries.length - 1]
    : null;
  const rsiValues = rsiSeries(closes, config.rsiPeriod);
  const rsi = rsiValues[last];
  const atrs = atrSeries(candles, config.atrPeriod);
  const atr = atrs[last];
  const priorAtrs = atrs
    .slice(-21, -1)
    .filter((value): value is number => value !== null);
  const atrRatio =
    atr !== null && priorAtrs.length ? atr / median(priorAtrs) : null;

  const bandPrices = closes.slice(-config.bollingerPeriod);
  const bandMiddle = sma(bandPrices);
  const bandVariance = bandPrices.reduce(
    (sum, close) => sum + (close - bandMiddle) ** 2,
    0
  ) / bandPrices.length;
  const bandDeviation = Math.sqrt(bandVariance);
  const bandUpper = bandMiddle + config.bollingerStdDev * bandDeviation;
  const bandLower = bandMiddle - config.bollingerStdDev * bandDeviation;
  const priorCandles = candles.slice(-config.bollingerPeriod - 1, -1);
  const breakoutUp =
    latest.close > bandUpper ||
    latest.close > Math.max(...priorCandles.map(candle => candle.high));
  const breakoutDown =
    latest.close < bandLower ||
    latest.close < Math.min(...priorCandles.map(candle => candle.low));

  if (
    emaShort === null ||
    emaMedium === null ||
    emaLong === null ||
    macd === null ||
    macdSignal === null ||
    rsi === null ||
    atr === null ||
    atrRatio === null
  ) {
    return finish("WARMING_UP", ["Indicator history is not ready"]);
  }

  features.ema20 = round(emaShort, 8);
  features.ema50 = round(emaMedium, 8);
  features.ema200 = round(emaLong, 8);
  features.rsi14 = round(rsi, 3);
  features.macd = round(macd, 8);
  features.macd_signal = round(macdSignal, 8);
  features.macd_histogram = round(macd - macdSignal, 8);
  features.atr14 = round(atr, 8);
  features.atr_ratio = round(atrRatio, 3);
  features.bollinger_upper = round(bandUpper, 8);
  features.bollinger_middle = round(bandMiddle, 8);
  features.bollinger_lower = round(bandLower, 8);

  const trendUp =
    emaShort > emaMedium && emaMedium > emaLong && latest.close > emaShort;
  const trendDown =
    emaShort < emaMedium && emaMedium < emaLong && latest.close < emaShort;
  const macdUp = macd > macdSignal;
  const macdDown = macd < macdSignal;
  const rsiUp = rsi >= 50 && rsi < 70;
  const rsiDown = rsi <= 50 && rsi > 30;
  const volatilityPoints =
    atrRatio >= 0.75 && atrRatio <= 2
      ? 15
      : atrRatio >= 0.5 && atrRatio <= 2.5
        ? 8
        : 0;
  const buyScore =
    (trendUp ? 25 : 0) +
    (macdUp ? 25 : 0) +
    (rsiUp ? 15 : 0) +
    (breakoutUp ? 20 : 0) +
    volatilityPoints;
  const sellScore =
    (trendDown ? 25 : 0) +
    (macdDown ? 25 : 0) +
    (rsiDown ? 15 : 0) +
    (breakoutDown ? 20 : 0) +
    volatilityPoints;
  features.buy_score = buyScore;
  features.sell_score = sellScore;

  const score = Math.max(buyScore, sellScore);
  const state: ScannerState =
    score < config.minSignalScore
      ? "WATCH"
      : buyScore >= sellScore ? "BUY" : "SELL";
  const reasons = [
    `Heuristic score: BUY ${buyScore}/100, SELL ${sellScore}/100; threshold ${config.minSignalScore}`,
    `EMA trend ${trendUp ? "up" : trendDown ? "down" : "not aligned"}; MACD ${macdUp ? "bullish" : macdDown ? "bearish" : "neutral"}; RSI ${rsi.toFixed(1)}`,
    `Breakout ${breakoutUp ? "up" : breakoutDown ? "down" : "none"}; ATR ratio ${atrRatio.toFixed(2)}`
  ];
  if (state === "WATCH") {
    return finish(state, reasons, { score });
  }

  const direction = state === "BUY" ? 1 : -1;
  const entry = state === "BUY" ? quote.ask : quote.bid;
  const stopDistance =
    m1Atr && Number.isFinite(m1Atr) && m1Atr > 0 ? m1Atr * 2 : null;
  const stopLoss =
    stopDistance === null ? null : entry - direction * stopDistance;
  const takeProfit =
    stopDistance === null ? null : entry + direction * stopDistance * 2;
  if (stopDistance === null) {
    reasons.push("M1 ATR(14) unavailable; SL/TP are not calculated");
  }
  return finish(state, reasons, {
    score,
    entry: round(entry, 8),
    stop_loss: stopLoss === null ? null : round(stopLoss, 8),
    take_profit: takeProfit === null ? null : round(takeProfit, 8)
  });
}
