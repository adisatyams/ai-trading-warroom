// D1 integration for the deterministic scanner.
//
// Research only: nothing in this file creates trade intents or talks to the
// executor. Results are written to scanner_results for audit and later review
// by the (not yet built) Risk Engine / AI gateway.

import type { Env, Tick } from "./types";
import {
  DEFAULT_CONFIG,
  STRATEGY,
  STRATEGY_VERSION,
  evaluate,
  isValidQuote,
  rejectInvalidTick,
  type Observation,
  type ScannerConfig,
  type ScannerResult
} from "./scanner";

// Enough history for the long window plus margin for gap handling.
const HISTORY_LIMIT = 40;
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

function saveResultStatement(env: Env, r: ScannerResult): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT OR IGNORE INTO scanner_results
    (
      signal_id, symbol, strategy, strategy_version, state,
      reject_reason, score, as_of, features_json, reasons_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    r.signal_id,
    r.symbol,
    r.strategy,
    r.strategy_version,
    r.state,
    r.reject_reason,
    r.score,
    r.as_of,
    JSON.stringify(r.features),
    JSON.stringify(r.reasons)
  );
}

/**
 * Record observations for a batch of ingested ticks, then evaluate each
 * affected symbol once. Idempotent: a retried batch re-inserts nothing new and
 * re-produces the same deterministic signal_id values.
 */
export async function recordAndScan(
  env: Env,
  items: IngestedTick[],
  fallbackReceivedAt: string
): Promise<{ observations: number; evaluated: number; rejected_ticks: number }> {
  const config = scannerConfig(env);
  const statements: D1PreparedStatement[] = [];
  const symbols = new Set<string>();
  let observations = 0;
  let rejectedTicks = 0;

  for (const item of items) {
    const receivedAt = item.received_at || fallbackReceivedAt;
    const symbol = typeof item.symbol === "string" ? item.symbol : "";
    if (!symbol || symbol.length > 32) continue;

    if (!isValidQuote(item.bid, item.ask)) {
      rejectedTicks++;
      statements.push(
        saveResultStatement(
          env,
          rejectInvalidTick(
            symbol,
            receivedAt,
            `bid=${item.bid ?? "null"}, ask=${item.ask ?? "null"}`
          )
        )
      );
      continue;
    }

    observations++;
    symbols.add(symbol);
    statements.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO market_observations
          (symbol, bid, ask, tick_time, received_at)
        VALUES (?, ?, ?, ?, ?)
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

  const resultStatements: D1PreparedStatement[] = [];
  for (const symbol of symbols) {
    const rows = await env.DB.prepare(`
      SELECT symbol, bid, ask, tick_time, received_at
      FROM market_observations
      WHERE symbol = ?
      ORDER BY received_at DESC
      LIMIT ?
    `).bind(symbol, HISTORY_LIMIT).all<Observation>();

    const series = [...rows.results].reverse(); // oldest first
    resultStatements.push(
      saveResultStatement(env, evaluate(symbol, series, Date.now(), config))
    );
  }

  if (resultStatements.length) {
    // Keep the dashboard's Agent Registry truthful about the scanner.
    // No-op if the SCANNER row does not exist.
    resultStatements.push(
      env.DB.prepare(`
        UPDATE agent_status
        SET status = 'READY', last_seen_at = ?, detail = ?
        WHERE agent_name = 'SCANNER'
      `).bind(
        new Date().toISOString(),
        `${STRATEGY} v${STRATEGY_VERSION}: research candidates only, no order path`
      )
    );
    await env.DB.batch(resultStatements);
  }

  return {
    observations,
    evaluated: symbols.size,
    rejected_ticks: rejectedTicks
  };
}

function parseRow(row: any) {
  return {
    signal_id: row.signal_id,
    symbol: row.symbol,
    strategy: row.strategy,
    strategy_version: row.strategy_version,
    state: row.state,
    reject_reason: row.reject_reason,
    score: row.score,
    as_of: row.as_of,
    features: JSON.parse(row.features_json),
    reasons: JSON.parse(row.reasons_json),
    created_at: row.created_at
  };
}

/** Newest result per symbol, optionally filtered. */
export async function latestResults(
  env: Env,
  filter: { symbol?: string; states?: string[] } = {}
) {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter.symbol) {
    where.push("r.symbol = ?");
    binds.push(filter.symbol);
  }
  if (filter.states && filter.states.length) {
    where.push(`r.state IN (${filter.states.map(() => "?").join(",")})`);
    binds.push(...filter.states);
  }

  const rows = await env.DB.prepare(`
    SELECT r.*
    FROM scanner_results r
    JOIN (
      SELECT symbol, MAX(as_of) AS max_as_of
      FROM scanner_results
      GROUP BY symbol
    ) m ON m.symbol = r.symbol AND m.max_as_of = r.as_of
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.symbol
  `).bind(...binds).all<any>();

  return rows.results.map(parseRow);
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
      short_window: config.shortWindow,
      long_window: config.longWindow,
      momentum_lookback: config.momentumLookback,
      stale_seconds: config.staleSeconds,
      max_gap_seconds: config.maxGapSeconds,
      min_trend_bps: config.minTrendBps,
      min_momentum_bps: config.minMomentumBps,
      spread_multiple: config.spreadMultiple
    },
    summary,
    symbols: latest.map(r => ({
      symbol: r.symbol,
      state: r.state,
      reject_reason: r.reject_reason,
      as_of: r.as_of,
      contiguous_observations: r.features.contiguous_observations,
      observations_stored: obsBySymbol.get(r.symbol) ?? 0,
      warmup_needed: config.longWindow
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
    ).bind(resCutoff)
  ]);
}
