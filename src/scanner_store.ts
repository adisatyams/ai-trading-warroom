// PostgreSQL integration for the deterministic scanner.
//
// Research only: nothing in this file creates trade intents or talks to the
// executor. Results are written to scanner_results for audit and later review
// by the Risk Checker and Position Sizer.

import type {
  Env,
  ScannerCandlesPayload,
  SizingInputSymbol,
  Tick
} from "./types";
import type { DatabaseStatement } from "./postgres";
import {
  scannerAgentStatusUpdate,
  tableColumns
} from "./db_compat";
import {
  DEFAULT_CONFIG,
  STRATEGY,
  STRATEGY_VERSION,
  SCANNER_TIMEFRAMES,
  evaluateTimeframe,
  isValidQuote,
  type Candle,
  type Observation,
  type ScannerQuote,
  type ScannerConfig,
  type ScannerResult
} from "./scanner";
import { calculateAtr14M1 } from "./position_sizer";

const OBSERVATION_RETENTION_HOURS = 48;
const RESULT_RETENTION_DAYS = 14;

export const SCANNER_STATES = [
  "BUY",
  "SELL",
  "WATCH",
  "WARMING_UP",
  "REJECTED"
] as const;

export type IngestedTick = Tick & { received_at?: string };

export function scannerConfig(env: Env): ScannerConfig {
  const stale = Number(env.BRIDGE_STALE_SECONDS);
  return {
    ...DEFAULT_CONFIG,
    staleSeconds:
      Number.isFinite(stale) && stale > 0
        ? stale
        : DEFAULT_CONFIG.staleSeconds
  };
}

function saveResultStatement(env: Env, r: ScannerResult): DatabaseStatement {
  return env.DB.prepare(`
    INSERT INTO scanner_results
    (
      signal_id, symbol, timeframe, strategy, strategy_version, state,
      reject_reason, score, entry, stop_loss, take_profit, as_of,
      features_json, reasons_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (signal_id) DO UPDATE SET
      symbol = excluded.symbol,
      timeframe = excluded.timeframe,
      strategy = excluded.strategy,
      strategy_version = excluded.strategy_version,
      state = excluded.state,
      reject_reason = excluded.reject_reason,
      score = excluded.score,
      entry = excluded.entry,
      stop_loss = excluded.stop_loss,
      take_profit = excluded.take_profit,
      as_of = excluded.as_of,
      features_json = excluded.features_json,
      reasons_json = excluded.reasons_json
  `).bind(
    r.signal_id,
    r.symbol,
    r.timeframe,
    r.strategy,
    r.strategy_version,
    r.state,
    r.reject_reason,
    r.score,
    r.entry,
    r.stop_loss,
    r.take_profit,
    r.as_of,
    JSON.stringify(r.features),
    JSON.stringify(r.reasons)
  );
}

export async function saveScannerCandles(
  env: Env,
  payload: ScannerCandlesPayload
): Promise<{ symbols: number; frames: number }> {
  const receivedAt = new Date().toISOString();
  const statements: DatabaseStatement[] = [];
  for (const item of payload.symbols) {
    for (const frame of item.timeframes) {
      statements.push(env.DB.prepare(`
        INSERT INTO scanner_candles
          (symbol, timeframe, captured_at, received_at, available, error, candles_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, timeframe) DO UPDATE SET
          captured_at = excluded.captured_at,
          received_at = excluded.received_at,
          available = excluded.available,
          error = excluded.error,
          candles_json = excluded.candles_json
        WHERE excluded.captured_at >= scanner_candles.captured_at
      `).bind(
        item.symbol,
        frame.timeframe,
        payload.captured_at,
        receivedAt,
        frame.available ? 1 : 0,
        frame.available ? null : frame.error ?? "MT5 candle data unavailable",
        JSON.stringify(frame.candles)
      ));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return {
    symbols: payload.symbols.length,
    frames: statements.length
  };
}

/**
 * Record observations for a batch of ingested ticks, then evaluate the newest
 * stored candle snapshot for each affected symbol and timeframe.
 */
export async function recordAndScan(
  env: Env,
  items: IngestedTick[],
  fallbackReceivedAt: string
): Promise<{
  observations: number;
  evaluated: number;
  rejected_ticks: number;
  symbols: string[];
}> {
  const config = scannerConfig(env);
  const statements: DatabaseStatement[] = [];
  const symbols = new Set<string>();
  let observations = 0;
  let rejectedTicks = 0;

  for (const item of items) {
    const receivedAt = item.received_at || fallbackReceivedAt;
    const symbol = typeof item.symbol === "string" ? item.symbol : "";
    if (!symbol || symbol.length > 32) continue;

    if (!isValidQuote(item.bid, item.ask)) {
      rejectedTicks++;
      continue;
    }

    observations++;
    symbols.add(symbol);
    statements.push(
      env.DB.prepare(`
        INSERT INTO market_observations
          (symbol, bid, ask, tick_time, received_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (symbol, received_at, bid, ask) DO NOTHING
      `).bind(
        symbol,
        item.bid as number,
        item.ask as number,
        item.time ?? null,
        receivedAt
      )
    );
    statements.push(
      env.DB.prepare(`
        INSERT INTO market_observation_latest
          (symbol, bid, ask, tick_time, received_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          bid = excluded.bid,
          ask = excluded.ask,
          tick_time = excluded.tick_time,
          received_at = excluded.received_at
        WHERE excluded.received_at >= market_observation_latest.received_at
      `).bind(
        symbol,
        item.bid as number,
        item.ask as number,
        item.time ?? null,
        receivedAt
      )
    );
  }

  if (statements.length) await env.DB.batch(statements);

  const symbolList = [...symbols];
  const placeholders = symbolList.map(() => "?").join(",");
  const [frameRows, quoteRows, sizingRows] = symbolList.length
    ? await Promise.all([
        env.DB.prepare(`
          SELECT symbol, timeframe, available, error, candles_json, captured_at
          FROM scanner_candles
          WHERE symbol IN (${placeholders})
        `).bind(...symbolList).all<{
          symbol: string;
          timeframe: typeof SCANNER_TIMEFRAMES[number];
          available: number;
          error: string | null;
          candles_json: string;
          captured_at: string;
        }>(),
        env.DB.prepare(`
          SELECT symbol, bid, ask, tick_time, received_at
          FROM market_observation_latest
          WHERE symbol IN (${placeholders})
        `).bind(...symbolList).all<Observation>(),
        env.DB.prepare(`
          SELECT symbol, captured_at, received_at, available, input_json
          FROM position_sizing_inputs
          WHERE symbol IN (${placeholders})
        `).bind(...symbolList).all<{
          symbol: string;
          captured_at: string;
          received_at: string;
          available: number;
          input_json: string;
        }>()
      ])
    : [{ results: [] }, { results: [] }, { results: [] }];
  const framesBySymbol = new Map<string, typeof frameRows.results>();
  for (const row of frameRows.results) {
    const current = framesBySymbol.get(row.symbol) ?? [];
    current.push(row);
    framesBySymbol.set(row.symbol, current);
  }
  const quotesBySymbol = new Map(quoteRows.results.map(row => [row.symbol, row]));
  const sizingBySymbol = new Map(sizingRows.results.map(row => [row.symbol, row]));
  const scanNow = Date.now();

  const results: ScannerResult[] = [];
  for (const symbol of symbols) {
    const sizingRow = sizingBySymbol.get(symbol);
    let m1Atr: number | null = null;
    if (sizingRow?.available) {
      const saved = JSON.parse(sizingRow.input_json) as {
        candles: SizingInputSymbol["candles"];
        spec: SizingInputSymbol["spec"];
      };
      if (saved.candles.length) {
        m1Atr = calculateAtr14M1(
          saved.candles,
          scanNow,
          config.staleSeconds
        ).atr;
      }
    }
    const quote = quotesBySymbol.get(symbol);
    const quoteInput: ScannerQuote | null = quote
      ? {
          bid: quote.bid,
          ask: quote.ask,
          received_at: quote.received_at
        }
      : null;
    const frames = new Map(
      (framesBySymbol.get(symbol) ?? []).map(row => [row.timeframe, row])
    );
    for (const timeframe of SCANNER_TIMEFRAMES) {
      const frame = frames.get(timeframe);
      if (!frame) continue;
      const candles = frame.available
        ? JSON.parse(frame.candles_json) as Candle[]
        : [];
      const result = evaluateTimeframe(
        symbol,
        timeframe,
        candles,
        quoteInput,
        scanNow,
        m1Atr,
        config
      );
      if (!frame.available && frame.error) {
        result.reasons.unshift(frame.error);
      }
      results.push(result);
    }
  }

  const resultStatements = results.map(result =>
    saveResultStatement(env, result)
  );
  const statusUpdate = scannerAgentStatusUpdate(
    await tableColumns(env.DB, "agent_status"),
    new Date().toISOString(),
    STRATEGY,
    `${STRATEGY} v${STRATEGY_VERSION}: M5/M15/H1/H4 indicators, heuristic threshold ${config.minSignalScore}; research only`
  );
  if (statusUpdate) {
    resultStatements.push(
      env.DB.prepare(statusUpdate.sql).bind(...statusUpdate.values)
    );
  }
  if (resultStatements.length) await env.DB.batch(resultStatements);

  return {
    observations,
    evaluated: results.length,
    rejected_ticks: rejectedTicks,
    symbols: [...symbols]
  };
}

function parseRow(row: any) {
  return {
    signal_id: row.signal_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    strategy: row.strategy,
    strategy_version: row.strategy_version,
    state: row.state,
    reject_reason: row.reject_reason,
    score: row.score,
    entry: row.entry,
    stop_loss: row.stop_loss,
    take_profit: row.take_profit,
    as_of: row.as_of,
    features: JSON.parse(row.features_json),
    reasons: JSON.parse(row.reasons_json),
    created_at: row.created_at
  };
}

/** Newest result per symbol/timeframe, optionally filtered. */
export async function latestResults(
  env: Env,
  filter: { symbol?: string; timeframe?: string; states?: string[] } = {}
) {
  const where: string[] = ["r.timeframe IN ('M5', 'M15', 'H1', 'H4')"];
  const binds: unknown[] = [];

  if (filter.symbol) {
    where.push("r.symbol = ?");
    binds.push(filter.symbol);
  }
  if (filter.timeframe) {
    where.push("r.timeframe = ?");
    binds.push(filter.timeframe);
  }
  if (filter.states && filter.states.length) {
    where.push(`r.state IN (${filter.states.map(() => "?").join(",")})`);
    binds.push(...filter.states);
  }

  const rows = await env.DB.prepare(`
    SELECT r.*
    FROM scanner_results r
    JOIN (
      SELECT symbol, timeframe, MAX(as_of) AS max_as_of
      FROM scanner_results
      GROUP BY symbol, timeframe
    ) m ON m.symbol = r.symbol
      AND m.timeframe = r.timeframe
      AND COALESCE(m.max_as_of, '') = COALESCE(r.as_of, '')
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.symbol, r.timeframe
  `).bind(...binds).all<any>();

  const nowMs = Date.now();
  const config = scannerConfig(env);
  const frameSeconds: Record<string, number> = {
    M5: 300,
    M15: 900,
    H1: 3_600,
    H4: 14_400
  };
  return rows.results.map(row => {
    const parsed = parseRow(row);
    const ageSeconds =
      parsed.as_of === null
        ? Number.POSITIVE_INFINITY
        : (nowMs - Date.parse(parsed.as_of)) / 1000;
    const freshnessLimit = Math.max(
      config.staleSeconds,
      (frameSeconds[parsed.timeframe] ?? 60) * 2
    );
    return {
      ...parsed,
      fresh:
        Number.isFinite(ageSeconds) &&
        ageSeconds >= 0 &&
        ageSeconds <= freshnessLimit
    };
  });
}

export async function scannerStatus(env: Env) {
  const config = scannerConfig(env);
  const latest = await latestResults(env);

  const counts = await env.DB.prepare(`
    SELECT symbol, COUNT(*) AS n
    FROM market_observations
    GROUP BY symbol
  `).all<{ symbol: string; n: number }>();
  const obsBySymbol = new Map(counts.results.map(r => [r.symbol, r.n]));

  const summary: Record<string, number> = {};
  for (const s of SCANNER_STATES) summary[s] = 0;
  for (const r of latest) summary[r.state] = (summary[r.state] ?? 0) + 1;

  return {
    strategy: STRATEGY,
    strategy_version: STRATEGY_VERSION,
    paper_mode: env.PAPER_MODE === "true",
    trading_enabled: env.TRADING_ENABLED === "true",
    execution_enabled: false,
    config: {
      stale_seconds: config.staleSeconds,
      timeframes: SCANNER_TIMEFRAMES,
      minimum_candles: config.emaLongPeriod,
      ema_periods: [
        config.emaShortPeriod,
        config.emaMediumPeriod,
        config.emaLongPeriod
      ],
      rsi_period: config.rsiPeriod,
      macd_periods: [
        config.macdFastPeriod,
        config.macdSlowPeriod,
        config.macdSignalPeriod
      ],
      atr_period: config.atrPeriod,
      bollinger_period: config.bollingerPeriod,
      bollinger_std_dev: config.bollingerStdDev,
      score_weights: {
        ema_trend: 25,
        macd: 25,
        rsi: 15,
        breakout_bollinger: 20,
        volatility: 15
      },
      min_signal_score: config.minSignalScore
    },
    summary,
    symbols: latest.map(r => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      state: r.state,
      fresh: r.fresh,
      reject_reason: r.reject_reason,
      as_of: r.as_of,
      contiguous_observations: r.features.contiguous_observations,
      observations_stored: obsBySymbol.get(r.symbol) ?? 0,
      warmup_needed: config.emaLongPeriod
    }))
  };
}

export async function pruneScanner(env: Env): Promise<void> {
  const obsCutoff = new Date(
    Date.now() - OBSERVATION_RETENTION_HOURS * 3_600_000
  ).toISOString();
  const resCutoff = new Date(
    Date.now() - RESULT_RETENTION_DAYS * 86_400_000
  ).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM market_observations WHERE received_at < ?"
    ).bind(obsCutoff),
    env.DB.prepare(
      "DELETE FROM scanner_results WHERE as_of < ?"
    ).bind(resCutoff),
    env.DB.prepare(
      "DELETE FROM scanner_candles WHERE received_at < ?"
    ).bind(new Date(Date.now() - OBSERVATION_RETENTION_HOURS * 3_600_000).toISOString())
  ]);
}
