import type { Env, SizingInputSymbol, SizingInputsPayload } from "./types";
import type { DatabaseStatement } from "./postgres";
import { agentStatusUpdate, tableColumns } from "./db_compat";
import {
  DEFAULT_POSITION_SIZER_CONFIG,
  MAX_ALLOWED_RISK_PCT,
  TAKE_PROFIT_R_MULTIPLE,
  sizePosition,
  type PositionSizerInput,
  type PositionSizerResult,
  type SizingCandidate
} from "./position_sizer";
import {
  STRATEGY,
  STRATEGY_VERSION
} from "./scanner";

const RESULT_RETENTION_DAYS = 14;

export interface PositionSizerConfig {
  riskPct: number;
  staleSeconds: number;
  maxCandleGapSeconds: number;
  valid: boolean;
}

export type LatestPositionSize = PositionSizerResult & { fresh: boolean };

export function positionSizerConfig(env: Env): PositionSizerConfig {
  const riskPct = Number(env.MAX_RISK_PER_TRADE_PCT);
  const staleSeconds = Number(env.BRIDGE_STALE_SECONDS);
  const valid =
    Number.isFinite(riskPct) &&
    riskPct > 0 &&
    riskPct <= MAX_ALLOWED_RISK_PCT;
  return {
    riskPct,
    staleSeconds:
      Number.isFinite(staleSeconds) && staleSeconds > 0
        ? staleSeconds
        : DEFAULT_POSITION_SIZER_CONFIG.staleSeconds,
    maxCandleGapSeconds:
      DEFAULT_POSITION_SIZER_CONFIG.maxCandleGapSeconds,
    valid
  };
}

export async function saveSizingInputs(
  env: Env,
  payload: SizingInputsPayload
): Promise<{ symbols: number; available: number }> {
  const receivedAt = new Date().toISOString();
  const statements = payload.symbols.map(item =>
    env.DB.prepare(`
      INSERT INTO position_sizing_inputs
        (symbol, captured_at, received_at, available, error, input_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        captured_at = excluded.captured_at,
        received_at = excluded.received_at,
        available = excluded.available,
        error = excluded.error,
        input_json = excluded.input_json
    `).bind(
      item.symbol,
      payload.captured_at,
      receivedAt,
      item.available ? 1 : 0,
      item.available ? null : item.error ?? "MT5 sizing data unavailable",
      JSON.stringify({ candles: item.candles, spec: item.spec })
    )
  );
  if (statements.length) await env.DB.batch(statements);
  return {
    symbols: payload.symbols.length,
    available: payload.symbols.filter(item => item.available).length
  };
}

function isFresh(timestamp: string, nowMs: number, staleSeconds: number): boolean {
  const ageSeconds = (nowMs - Date.parse(timestamp)) / 1000;
  return Number.isFinite(ageSeconds) && ageSeconds >= 0 && ageSeconds <= staleSeconds;
}

function saveResult(
  env: Env,
  result: PositionSizerResult
): DatabaseStatement {
  return env.DB.prepare(`
    INSERT INTO position_sizing_results
      (signal_id, symbol, timeframe, decision, checked_at, result_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (signal_id) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      timeframe = EXCLUDED.timeframe,
      decision = EXCLUDED.decision,
      checked_at = EXCLUDED.checked_at,
      result_json = EXCLUDED.result_json
  `).bind(
    result.signal_id,
    result.symbol,
    result.timeframe,
    result.decision,
    result.checked_at,
    JSON.stringify(result)
  );
}

export async function sizeEligibleSignals(
  env: Env,
  symbols: string[]
): Promise<{
  evaluated: number;
  sized: number;
  rejected: number;
  skipped_risk: number;
}> {
  const uniqueSymbols = [...new Set(symbols)];
  const nowMs = Date.now();
  const config = positionSizerConfig(env);
  const results: PositionSizerResult[] = [];
  const symbolFilter = uniqueSymbols.map(() => "?").join(",");
  const riskRows = uniqueSymbols.length
    ? (await env.DB.prepare(`
        SELECT current.signal_id, current.symbol, current.strategy,
               current.strategy_version, current.scanner_state,
               current.timeframe, current.decision, current.as_of,
               current.checked_at
        FROM risk_check_results current
        JOIN (
          SELECT symbol, timeframe, MAX(checked_at) AS latest_checked_at
          FROM risk_check_results
          WHERE symbol IN (${symbolFilter})
            AND timeframe IN ('M5', 'M15', 'H1', 'H4')
          GROUP BY symbol, timeframe
        ) newest
          ON newest.symbol = current.symbol
          AND newest.timeframe = current.timeframe
          AND newest.latest_checked_at = current.checked_at
      `).bind(...uniqueSymbols).all<{
        signal_id: string;
        symbol: string;
        strategy: string;
        strategy_version: string;
        scanner_state: string;
        timeframe: SizingCandidate["timeframe"];
        decision: string;
        as_of: string | null;
        checked_at: string;
      }>()).results
    : [];
  const eligibleRiskRows = riskRows.filter(
    (row): row is NonNullable<typeof row> => row !== null &&
    row.decision === "ELIGIBLE_FOR_PAPER_REVIEW" &&
    isFresh(row.checked_at, nowMs, config.staleSeconds)
  );
  const skippedRisk = riskRows.length - eligibleRiskRows.length;
  const bridgeRow = eligibleRiskRows.length
    ? await env.DB.prepare(`
        SELECT connected, trade_mode, equity, received_at
        FROM bridge_heartbeats
        ORDER BY id DESC
        LIMIT 1
      `).first<{
        connected: number;
        trade_mode: number | string;
        equity: number | null;
        received_at: string;
      }>()
    : null;

  const eligibleSymbols = [...new Set(
    eligibleRiskRows.map(row => row.symbol)
  )];
  const eligibleSymbolFilter = eligibleSymbols.map(() => "?").join(",");
  const [quoteRows, inputRows] = eligibleSymbols.length
    ? await Promise.all([
        env.DB.prepare(`
          SELECT symbol, bid, ask, received_at
          FROM market_observation_latest
          WHERE symbol IN (${eligibleSymbolFilter})
        `).bind(...eligibleSymbols).all<{
          symbol: string;
          bid: number;
          ask: number;
          received_at: string;
        }>(),
        env.DB.prepare(`
          SELECT symbol, captured_at, received_at, available, input_json
          FROM position_sizing_inputs
          WHERE symbol IN (${eligibleSymbolFilter})
        `).bind(...eligibleSymbols).all<{
          symbol: string;
          captured_at: string;
          received_at: string;
          available: number;
          input_json: string;
        }>()
      ])
    : [{ results: [] }, { results: [] }];
  const quoteBySymbol = new Map(quoteRows.results.map(row => [row.symbol, row]));
  const inputBySymbol = new Map(inputRows.results.map(row => [row.symbol, row]));

  for (const riskRow of eligibleRiskRows) {
    const quoteRow = quoteBySymbol.get(riskRow.symbol);
    const inputRow = inputBySymbol.get(riskRow.symbol);

    const candidate: SizingCandidate = {
      signal_id: riskRow.signal_id,
      symbol: riskRow.symbol,
      timeframe: riskRow.timeframe,
      strategy: riskRow.strategy,
      strategy_version: riskRow.strategy_version,
      state: riskRow.scanner_state,
      as_of: riskRow.as_of
    };

    let snapshot: PositionSizerInput["snapshot"] = null;
    if (inputRow) {
      const saved = JSON.parse(inputRow.input_json) as {
        candles: SizingInputSymbol["candles"];
        spec: SizingInputSymbol["spec"];
      };
      snapshot = {
        available: !!inputRow.available,
        captured_at: inputRow.captured_at,
        received_at: inputRow.received_at,
        candles: saved.candles,
        spec: saved.spec
      };
    }

    const input: PositionSizerInput = {
      nowMs,
      staleSeconds: config.staleSeconds,
      maxCandleGapSeconds: config.maxCandleGapSeconds,
      riskPct: config.riskPct,
      paperMode: env.PAPER_MODE === "true",
      tradingEnabled: env.TRADING_ENABLED === "true",
      risk: {
        eligible: true,
        checked_at: riskRow.checked_at
      },
      bridge: bridgeRow
        ? {
            connected: !!bridgeRow.connected,
            demo: Number(bridgeRow.trade_mode) === 0,
            received_at: bridgeRow.received_at,
            equity: bridgeRow.equity
          }
        : null,
      quote: quoteRow ?? null,
      snapshot
    };
    results.push(sizePosition(candidate, input));
  }

  if (results.length) {
    await env.DB.batch(results.map(result => saveResult(env, result)));
  }

  const statusUpdate = agentStatusUpdate(
    await tableColumns(env.DB, "agent_status"),
    "SIZER",
    new Date(nowMs).toISOString(),
    STRATEGY,
    `${STRATEGY} v${STRATEGY_VERSION}: M1 ATR(14), stop 2x ATR, TP ${TAKE_PROFIT_R_MULTIPLE}R, max ${MAX_ALLOWED_RISK_PCT}% equity risk; no order path`
  );
  if (statusUpdate) {
    await env.DB.prepare(statusUpdate.sql)
      .bind(...statusUpdate.values)
      .run();
  }

  return {
    evaluated: results.length,
    sized: results.filter(
      result => result.decision === "SIZED_FOR_PAPER_REVIEW"
    ).length,
    rejected: results.filter(result => result.decision === "REJECTED").length,
    skipped_risk: skippedRisk
  };
}

export async function latestPositionSizes(
  env: Env,
  filter: { symbol?: string; timeframe?: string; decision?: string } = {}
): Promise<LatestPositionSize[]> {
  const conditions: string[] = ["r.timeframe IN ('M5', 'M15', 'H1', 'H4')"];
  const values: string[] = [];
  if (filter.symbol) {
    conditions.push("r.symbol = ?");
    values.push(filter.symbol);
  }
  if (filter.timeframe) {
    conditions.push("r.timeframe = ?");
    values.push(filter.timeframe);
  }
  if (filter.decision) {
    conditions.push("r.decision = ?");
    values.push(filter.decision);
  }
  const rows = await env.DB.prepare(`
    SELECT r.result_json, r.checked_at
    FROM position_sizing_results r
    JOIN (
      SELECT symbol, timeframe, MAX(checked_at) AS latest_checked_at
      FROM position_sizing_results
      GROUP BY symbol, timeframe
    ) newest
      ON newest.symbol = r.symbol
      AND newest.timeframe = r.timeframe
      AND newest.latest_checked_at = r.checked_at
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY r.symbol, r.timeframe
  `).bind(...values).all<{ result_json: string; checked_at: string }>();
  const config = positionSizerConfig(env);
  const nowMs = Date.now();
  return rows.results.map(row => ({
    ...JSON.parse(row.result_json) as PositionSizerResult,
    fresh: isFresh(row.checked_at, nowMs, config.staleSeconds)
  }));
}

export async function positionSizerStatus(env: Env) {
  const config = positionSizerConfig(env);
  const [inputs, sizes] = await Promise.all([
    env.DB.prepare(`
      SELECT symbol, available, captured_at, received_at, error
      FROM position_sizing_inputs
      ORDER BY symbol
    `).all<{
      symbol: string;
      available: number;
      captured_at: string;
      received_at: string;
      error: string | null;
    }>(),
    latestPositionSizes(env)
  ]);
  const nowMs = Date.now();
  const sizedSummary = {
    SIZED_FOR_PAPER_REVIEW: 0,
    REJECTED: 0,
    STALE: 0
  };
  for (const result of sizes) {
    if (!result.fresh) sizedSummary.STALE++;
    else sizedSummary[result.decision]++;
  }
  return {
    agent: "SIZER",
    strategy: STRATEGY,
    strategy_version: STRATEGY_VERSION,
    policy: {
      risk_pct: config.riskPct,
      risk_pct_limit: MAX_ALLOWED_RISK_PCT,
      atr_timeframe: "M1",
      atr_period: DEFAULT_POSITION_SIZER_CONFIG.atrPeriod,
      stop_atr_multiple: DEFAULT_POSITION_SIZER_CONFIG.stopAtrMultiple,
      take_profit_r_multiple: TAKE_PROFIT_R_MULTIPLE,
      execution_enabled: false
    },
    config_valid: config.valid,
    inputs: inputs.results.map(row => ({
      symbol: row.symbol,
      available: !!row.available,
      fresh:
        isFresh(row.captured_at, nowMs, config.staleSeconds) &&
        isFresh(row.received_at, nowMs, config.staleSeconds),
      captured_at: row.captured_at,
      received_at: row.received_at,
      error: row.error
    })),
    summary: sizedSummary,
    symbols: sizes.map(result => ({
      symbol: result.symbol,
      decision: result.decision,
      fresh: result.fresh,
      volume: result.metrics.volume,
      stop_loss_price: result.metrics.stop_loss_price,
      estimated_risk_pct: result.metrics.estimated_risk_pct,
      reasons: result.reasons,
      checked_at: result.checked_at
    })),
    advisory_only: true,
    execution_enabled: false
  };
}

export async function prunePositionSizingData(env: Env): Promise<void> {
  const cutoff = new Date(
    Date.now() - RESULT_RETENTION_DAYS * 86_400_000
  ).toISOString();
  await env.DB.prepare(
    "DELETE FROM position_sizing_results WHERE checked_at < ?"
  ).bind(cutoff).run();
}
