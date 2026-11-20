import type { Env } from "./types";
import { agentStatusUpdate, tableColumns } from "./db_compat";
import {
  DEFAULT_RISK_CONFIG,
  evaluateRisk,
  type CalendarEvent,
  type OpenPosition,
  type RiskCandidate,
  type RiskContext,
  type RiskConfig,
  type RiskResult
} from "./risk_checker";
import type { Observation } from "./scanner";
import { STRATEGY, STRATEGY_VERSION } from "./scanner";

const RISK_RESULT_RETENTION_DAYS = 14;
const POSITION_RETENTION_HOURS = 48;

export interface NewsCalendarBatch {
  generated_at: string;
  available: boolean;
  error?: string | null;
  events: CalendarEvent[];
}

export interface PositionSnapshotBatch {
  captured_at: string;
  positions: OpenPosition[];
}

export type LatestRiskResult = RiskResult & { fresh: boolean };

export function riskConfig(env: Env): RiskConfig {
  const stale = Number(env.BRIDGE_STALE_SECONDS);
  const dailyLoss = Number(env.MAX_DAILY_LOSS_PCT);
  const drawdown = Number(env.MAX_DRAWDOWN_PCT);
  return {
    ...DEFAULT_RISK_CONFIG,
    staleSeconds:
      Number.isFinite(stale) && stale > 0
        ? stale
        : DEFAULT_RISK_CONFIG.staleSeconds,
    maxDailyLossPct:
      Number.isFinite(dailyLoss) && dailyLoss > 0
        ? dailyLoss
        : DEFAULT_RISK_CONFIG.maxDailyLossPct,
    maxDailyDrawdownPct:
      Number.isFinite(drawdown) && drawdown > 0
        ? drawdown
        : DEFAULT_RISK_CONFIG.maxDailyDrawdownPct
  };
}

export async function saveNewsCalendar(
  env: Env,
  batch: NewsCalendarBatch
): Promise<{ stored_events: number; available: boolean }> {
  const receivedAt = new Date().toISOString();
  const events = batch.available ? batch.events : [];
  const statements = [
    env.DB.prepare("DELETE FROM news_calendar_events")
  ];

  for (const event of events) {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO news_calendar_events
        (event_id, currency, name, importance, scheduled_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      event.event_id,
      event.currency,
      event.name,
      event.importance,
      event.scheduled_at
    ));
  }

  statements.push(env.DB.prepare(`
    INSERT OR REPLACE INTO news_calendar_sync
      (id, available, source_generated_at, received_at, event_count, error)
    VALUES (1, ?, ?, ?, ?, ?)
  `).bind(
    batch.available ? 1 : 0,
    batch.generated_at,
    receivedAt,
    events.length,
    batch.available ? null : batch.error ?? "MT5 calendar unavailable"
  ));

  await env.DB.batch(statements);
  return { stored_events: events.length, available: batch.available };
}

export async function savePositionSnapshot(
  env: Env,
  batch: PositionSnapshotBatch
): Promise<{ snapshot_id: string; positions: number }> {
  const snapshotId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const statements = [
    env.DB.prepare(`
      INSERT INTO risk_position_snapshots
        (snapshot_id, captured_at, received_at, position_count)
      VALUES (?, ?, ?, ?)
    `).bind(snapshotId, batch.captured_at, receivedAt, batch.positions.length)
  ];

  for (const [ordinal, position] of batch.positions.entries()) {
    statements.push(env.DB.prepare(`
      INSERT INTO risk_open_positions
        (snapshot_id, ordinal, symbol, direction, volume)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      snapshotId,
      ordinal,
      position.symbol,
      position.direction,
      position.volume
    ));
  }

  await env.DB.batch(statements);
  return { snapshot_id: snapshotId, positions: batch.positions.length };
}

function parseRiskRow(row: any): RiskResult {
  return {
    signal_id: row.signal_id,
    symbol: row.symbol,
    strategy: row.strategy,
    strategy_version: row.strategy_version,
    scanner_state: row.scanner_state,
    decision: row.decision,
    reasons: JSON.parse(row.reasons_json),
    checks: JSON.parse(row.checks_json),
    metrics: JSON.parse(row.metrics_json),
    as_of: row.as_of,
    checked_at: row.checked_at,
    execution_enabled: false
  };
}

async function riskContext(
  env: Env,
  symbol: string,
  nowMs: number
): Promise<RiskContext> {
  const config = riskConfig(env);
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  const [
    bridgeRow,
    observations,
    calendar,
    calendarEvents,
    snapshot,
    dailyEquity
  ] = await Promise.all([
    env.DB.prepare(`
      SELECT connected, trade_mode, received_at
      FROM bridge_heartbeats
      ORDER BY id DESC
      LIMIT 1
    `).first<{ connected: number; trade_mode: number | string; received_at: string }>(),
    env.DB.prepare(`
      SELECT symbol, bid, ask, tick_time, received_at
      FROM market_observations
      WHERE symbol = ?
      ORDER BY received_at DESC
      LIMIT ?
    `).bind(symbol, 21).all<Observation>(),
    env.DB.prepare(`
      SELECT available, received_at
      FROM news_calendar_sync
      WHERE id = 1
      LIMIT 1
    `).first<{ available: number; received_at: string }>(),
    env.DB.prepare(`
      SELECT event_id, name, currency, importance, scheduled_at
      FROM news_calendar_events
      WHERE scheduled_at BETWEEN ? AND ?
    `).bind(
      new Date(nowMs - config.newsBlackoutMinutes * 60_000).toISOString(),
      new Date(nowMs + config.newsBlackoutMinutes * 60_000).toISOString()
    ).all<CalendarEvent>(),
    env.DB.prepare(`
      SELECT snapshot_id, captured_at
      FROM risk_position_snapshots
      ORDER BY received_at DESC
      LIMIT 1
    `).first<{ snapshot_id: string; captured_at: string }>(),
    env.DB.prepare(`
      SELECT
        COUNT(*) AS sample_count,
        (SELECT equity FROM bridge_heartbeats
         WHERE received_at >= ? AND equity > 0
         ORDER BY received_at ASC LIMIT 1) AS start_equity,
        (SELECT received_at FROM bridge_heartbeats
         WHERE received_at >= ? AND equity > 0
         ORDER BY received_at ASC LIMIT 1) AS start_at,
        (SELECT equity FROM bridge_heartbeats
         WHERE received_at >= ? AND equity > 0
         ORDER BY received_at DESC LIMIT 1) AS current_equity,
        (SELECT received_at FROM bridge_heartbeats
         WHERE received_at >= ? AND equity > 0
         ORDER BY received_at DESC LIMIT 1) AS current_at,
        MAX(equity) AS peak_equity
      FROM bridge_heartbeats
      WHERE received_at >= ? AND equity > 0
    `).bind(dayStartIso, dayStartIso, dayStartIso, dayStartIso, dayStartIso)
      .first<{
        sample_count: number;
        start_equity: number | null;
        start_at: string | null;
        current_equity: number | null;
        current_at: string | null;
        peak_equity: number | null;
      }>()
  ]);

  const positions = snapshot
    ? await env.DB.prepare(`
        SELECT symbol, direction, volume
        FROM risk_open_positions
        WHERE snapshot_id = ?
        ORDER BY ordinal
      `).bind(snapshot.snapshot_id).all<OpenPosition>()
    : null;

  return {
    nowMs,
    paperMode: env.PAPER_MODE === "true",
    tradingEnabled: env.TRADING_ENABLED === "true",
    bridge: bridgeRow
      ? {
          connected: !!bridgeRow.connected,
          demo: Number(bridgeRow.trade_mode) === 0,
          received_at: bridgeRow.received_at
        }
      : null,
    observations: [...observations.results].reverse(),
    calendar: calendar
      ? { available: !!calendar.available, received_at: calendar.received_at }
      : null,
    calendarEvents: calendarEvents.results,
    positions: snapshot && positions
      ? {
          captured_at: snapshot.captured_at,
          items: positions.results
        }
      : null,
    dailyEquity:
      dailyEquity?.start_equity &&
      dailyEquity.start_at &&
      dailyEquity.current_equity &&
      dailyEquity.current_at &&
      dailyEquity.peak_equity
        ? {
            start_equity: dailyEquity.start_equity,
            start_at: dailyEquity.start_at,
            current_equity: dailyEquity.current_equity,
            current_at: dailyEquity.current_at,
            peak_equity: dailyEquity.peak_equity
          }
        : null
  };
}

function saveRiskResult(
  env: Env,
  result: RiskResult
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT OR REPLACE INTO risk_check_results
      (
        signal_id, symbol, strategy, strategy_version, scanner_state,
        decision, reasons_json, checks_json, metrics_json, as_of, checked_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    result.signal_id,
    result.symbol,
    result.strategy,
    result.strategy_version,
    result.scanner_state,
    result.decision,
    JSON.stringify(result.reasons),
    JSON.stringify(result.checks),
    JSON.stringify(result.metrics),
    result.as_of,
    result.checked_at
  );
}

export async function checkLatestSignals(
  env: Env,
  symbols: string[]
): Promise<{ evaluated: number; eligible_for_paper_review: number; rejected: number }> {
  const uniqueSymbols = [...new Set(symbols)];
  const results: RiskResult[] = [];
  const nowMs = Date.now();
  const config = riskConfig(env);

  for (const symbol of uniqueSymbols) {
    const row = await env.DB.prepare(`
      SELECT signal_id, symbol, strategy, strategy_version, state, as_of,
             features_json
      FROM scanner_results
      WHERE symbol = ?
      ORDER BY as_of DESC
      LIMIT 1
    `).bind(symbol).first<{
      signal_id: string;
      symbol: string;
      strategy: string;
      strategy_version: string;
      state: string;
      as_of: string | null;
      features_json: string;
    }>();
    if (!row) continue;

    const candidate: RiskCandidate = {
      signal_id: row.signal_id,
      symbol: row.symbol,
      strategy: row.strategy,
      strategy_version: row.strategy_version,
      state: row.state,
      as_of: row.as_of,
      features: JSON.parse(row.features_json)
    };
    const result = evaluateRisk(
      candidate,
      await riskContext(env, symbol, nowMs),
      config
    );
    results.push(result);
  }

  if (results.length) {
    await env.DB.batch(results.map(result => saveRiskResult(env, result)));
  }

  const statusUpdate = agentStatusUpdate(
    await tableColumns(env.DB, "agent_status"),
    "RISK_CHECK",
    new Date(nowMs).toISOString(),
    STRATEGY,
    `${STRATEGY} v${STRATEGY_VERSION}: fail-closed screening only; no order path`
  );
  if (statusUpdate) {
    await env.DB.prepare(statusUpdate.sql)
      .bind(...statusUpdate.values)
      .run();
  }

  return {
    evaluated: results.length,
    eligible_for_paper_review: results.filter(
      result => result.decision === "ELIGIBLE_FOR_PAPER_REVIEW"
    ).length,
    rejected: results.filter(result => result.decision === "REJECTED").length
  };
}

export async function latestRiskResults(
  env: Env,
  filter: { symbol?: string; decision?: string } = {}
): Promise<LatestRiskResult[]> {
  const conditions: string[] = [];
  const values: string[] = [];
  if (filter.symbol) {
    conditions.push("r.symbol = ?");
    values.push(filter.symbol);
  }
  if (filter.decision) {
    conditions.push("r.decision = ?");
    values.push(filter.decision);
  }
  const rows = await env.DB.prepare(`
    SELECT r.*
    FROM risk_check_results r
    JOIN (
      SELECT symbol, MAX(checked_at) AS latest_checked_at
      FROM risk_check_results
      GROUP BY symbol
    ) newest
      ON newest.symbol = r.symbol
      AND newest.latest_checked_at = r.checked_at
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY r.symbol
  `).bind(...values).all<any>();
  const config = riskConfig(env);
  const nowMs = Date.now();
  return rows.results.map(row => {
    const result = parseRiskRow(row);
    const age = (nowMs - Date.parse(result.checked_at)) / 1000;
    return {
      ...result,
      fresh: Number.isFinite(age) && age >= 0 && age <= config.staleSeconds
    };
  });
}

export async function riskStatus(env: Env) {
  const config = riskConfig(env);
  const latest = await latestRiskResults(env);
  const calendar = await env.DB.prepare(`
    SELECT available, received_at, event_count, error
    FROM news_calendar_sync
    WHERE id = 1
  `).first<{
    available: number;
    received_at: string;
    event_count: number;
    error: string | null;
  }>();
  const positions = await env.DB.prepare(`
    SELECT captured_at, position_count
    FROM risk_position_snapshots
    ORDER BY received_at DESC
    LIMIT 1
  `).first<{ captured_at: string; position_count: number }>();

  const summary = {
    ELIGIBLE_FOR_PAPER_REVIEW: 0,
    REJECTED: 0,
    STALE: 0
  };
  for (const result of latest) {
    if (result.fresh) summary[result.decision]++;
    else summary.STALE++;
  }
  const nowMs = Date.now();
  const isFresh = (timestamp: string | null | undefined) => {
    if (!timestamp) return false;
    const age = (nowMs - Date.parse(timestamp)) / 1000;
    return Number.isFinite(age) && age >= 0 && age <= config.staleSeconds;
  };

  return {
    agent: "RISK_CHECK",
    strategy: STRATEGY,
    strategy_version: STRATEGY_VERSION,
    policy: {
      max_daily_loss_pct: config.maxDailyLossPct,
      max_daily_drawdown_pct: config.maxDailyDrawdownPct,
      max_open_positions: config.maxOpenPositions,
      news_blackout_minutes: config.newsBlackoutMinutes,
      volatility_spike_multiple: config.volatilitySpikeMultiple,
      execution_enabled: false
    },
    calendar: calendar
      ? {
          available: !!calendar.available,
          fresh: isFresh(calendar.received_at),
          received_at: calendar.received_at,
          event_count: calendar.event_count,
          error: calendar.error
        }
      : {
          available: false,
          fresh: false,
          error: "No MT5 calendar update received"
        },
    positions: positions
      ? {
          available: true,
          fresh: isFresh(positions.captured_at),
          ...positions
        }
      : { available: false, fresh: false },
    summary,
    symbols: latest.map(result => ({
      symbol: result.symbol,
      decision: result.decision,
      fresh: result.fresh,
      reasons: result.reasons,
      as_of: result.as_of,
      checked_at: result.checked_at
    })),
    advisory_only: true,
    execution_enabled: false
  };
}

export async function pruneRiskData(env: Env): Promise<void> {
  const resultCutoff = new Date(
    Date.now() - RISK_RESULT_RETENTION_DAYS * 86_400_000
  ).toISOString();
  const positionCutoff = new Date(
    Date.now() - POSITION_RETENTION_HOURS * 3_600_000
  ).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM risk_check_results WHERE checked_at < ?"
    ).bind(resultCutoff),
    env.DB.prepare(`
      DELETE FROM risk_open_positions
      WHERE snapshot_id IN (
        SELECT snapshot_id FROM risk_position_snapshots WHERE received_at < ?
      )
    `).bind(positionCutoff),
    env.DB.prepare(
      "DELETE FROM risk_position_snapshots WHERE received_at < ?"
    ).bind(positionCutoff),
    env.DB.prepare(
      "DELETE FROM news_calendar_events WHERE scheduled_at < ?"
    ).bind(new Date(Date.now() - 86_400_000).toISOString())
  ]);
}
