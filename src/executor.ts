import type { Env } from "./types";
import { DEFAULT_CONFIG, type ScannerTimeframe } from "./scanner.ts";

const TIMEFRAME_PRIORITY: Record<ScannerTimeframe, number> = {
  H4: 0,
  H1: 1,
  M15: 2,
  M5: 3
};

/** Only signals on this timeframe are executed. M15, H1 and H4 are not traded. */
export const EXECUTION_TIMEFRAME: ScannerTimeframe = "M5";
/** Higher timeframes whose EMA trend must agree with the execution signal. */
export const TREND_TIMEFRAMES: ScannerTimeframe[] = ["H1", "H4"];

type TrendFeatures = {
  ema20?: number | null;
  ema50?: number | null;
  ema200?: number | null;
} | null | undefined;

/** EMA20 > EMA50 > EMA200 is an uptrend, the reverse a downtrend. */
export function emaTrend(features: TrendFeatures): "UP" | "DOWN" | "NONE" {
  if (!features) return "NONE";
  const { ema20, ema50, ema200 } = features;
  if (
    typeof ema20 !== "number" || typeof ema50 !== "number" ||
    typeof ema200 !== "number" ||
    !Number.isFinite(ema20) || !Number.isFinite(ema50) ||
    !Number.isFinite(ema200)
  ) {
    return "NONE";
  }
  if (ema20 > ema50 && ema50 > ema200) return "UP";
  if (ema20 < ema50 && ema50 < ema200) return "DOWN";
  return "NONE";
}

/** True only when every higher timeframe trend matches the trade direction. */
export function trendAligned(
  direction: "BUY" | "SELL",
  higher: Partial<Record<ScannerTimeframe, TrendFeatures>>
): boolean {
  const wanted = direction === "BUY" ? "UP" : "DOWN";
  return TREND_TIMEFRAMES.every(
    timeframe => emaTrend(higher[timeframe]) === wanted
  );
}

const ACTIVE_INTENT_STATUSES = [
  "PENDING",
  "DISPATCHED",
  "EXECUTED",
  "PARTIAL",
  "UNCERTAIN"
] as const;

const TERMINAL_ACK_STATUSES = [
  "EXECUTED",
  "PARTIAL",
  "REJECTED",
  "FAILED",
  "UNCERTAIN"
] as const;

interface EligibleTradeRow {
  signal_id: string;
  symbol: string;
  timeframe: ScannerTimeframe;
  strategy: string;
  strategy_version: string;
  state: "BUY" | "SELL";
  score: number;
  as_of: string;
  risk_checked_at: string;
  risk_metrics_json: string;
  sizing_checked_at: string;
  sizing_result_json: string;
}

interface SizingResult {
  direction: "BUY" | "SELL";
  metrics: {
    entry_price: number | null;
    stop_loss_price: number | null;
    take_profit_price: number | null;
    volume: number | null;
    risk_budget: number | null;
    risk_pct_limit: number;
  };
}

interface AccountControlState {
  paused: boolean;
  kill_switch: boolean;
}

export interface ExecutorAck {
  intent_id: string;
  status: typeof TERMINAL_ACK_STATUSES[number];
  broker_ticket?: string | number | null;
  volume?: number | null;
  entry_price?: number | null;
  retcode?: number | null;
  message?: string | null;
  opened_at?: string | null;
}

function isFresh(timestamp: string, nowMs: number, staleSeconds: number): boolean {
  const age = (nowMs - Date.parse(timestamp)) / 1000;
  return Number.isFinite(age) && age >= 0 && age <= staleSeconds;
}

function bridgeStaleSeconds(env: Env): number {
  const configured = Number(env.BRIDGE_STALE_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : 150;
}

async function accountControlState(env: Env): Promise<AccountControlState> {
  const id = env.ACCOUNT_COORDINATOR.idFromName("exness-demo-primary");
  const response = await env.ACCOUNT_COORDINATOR.get(id).fetch(
    "https://coordinator/state"
  );
  if (!response.ok) {
    throw new Error(`Account control state failed with HTTP ${response.status}`);
  }
  const state = await response.json() as Partial<AccountControlState>;
  if (
    typeof state.paused !== "boolean" ||
    typeof state.kill_switch !== "boolean"
  ) {
    throw new Error("Account control state is invalid");
  }
  return {
    paused: state.paused,
    kill_switch: state.kill_switch
  };
}

function validPositive(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function chooseTopSignalPerSymbol<
  T extends { symbol: string; timeframe: ScannerTimeframe; score: number }
>(rows: T[]): T[] {
  const bestBySymbol = new Map<string, T>();
  for (const row of rows) {
    const current = bestBySymbol.get(row.symbol);
    if (
      !current ||
      row.score > current.score ||
      (row.score === current.score &&
        TIMEFRAME_PRIORITY[row.timeframe] < TIMEFRAME_PRIORITY[current.timeframe])
    ) {
      bestBySymbol.set(row.symbol, row);
    }
  }
  return [...bestBySymbol.values()];
}

async function expirePendingIntents(env: Env, staleSeconds: number): Promise<void> {
  const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
  const pending = await env.DB.prepare(`
    UPDATE trade_intents
    SET status = 'EXPIRED'
    WHERE status = 'PENDING' AND created_at < ?
  `).bind(cutoff).run();
  const dispatched = await env.DB.prepare(`
    UPDATE trade_intents
    SET status = 'UNCERTAIN'
    WHERE status = 'DISPATCHED'
      AND COALESCE(dispatched_at, created_at) < ?
  `).bind(cutoff).run();
  const expiredCount =
    (pending.meta.changes ?? 0) + (dispatched.meta.changes ?? 0);
  if (expiredCount) {
    await env.DB.prepare(`
      INSERT INTO system_events
        (level, event_type, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      "WARN",
      "TRADE_INTENTS_EXPIRED",
      "Expired stale pending or dispatched demo trade intents",
      JSON.stringify({
        count: expiredCount,
        pending_expired: pending.meta.changes,
        dispatched_uncertain: dispatched.meta.changes
      }),
      new Date().toISOString()
    ).run();
  }
}

export async function enqueueEligibleTrades(
  env: Env,
  symbols: string[]
): Promise<{
  locked: boolean;
  reason?: string;
  evaluated: number;
  enqueued: number;
  trend_blocked?: number;
}> {
  if (env.TRADING_ENABLED !== "true" || env.PAPER_MODE !== "true") {
    return { locked: true, evaluated: 0, enqueued: 0 };
  }

  const uniqueSymbols = [...new Set(symbols)];
  if (!uniqueSymbols.length) {
    return { locked: false, evaluated: 0, enqueued: 0 };
  }
  const control = await accountControlState(env);
  if (control.paused || control.kill_switch) {
    return {
      locked: true,
      reason: control.kill_switch ? "Account kill switch is active" : "Account is paused",
      evaluated: 0,
      enqueued: 0
    };
  }

  const nowMs = Date.now();
  const staleSeconds = bridgeStaleSeconds(env);
  await expirePendingIntents(env, staleSeconds);
  const heartbeat = await env.DB.prepare(`
    SELECT connected, trade_mode, received_at
    FROM bridge_heartbeats
    ORDER BY id DESC
    LIMIT 1
  `).first<{
    connected: number;
    trade_mode: number | string;
    received_at: string;
  }>();
  if (
    !heartbeat ||
    !heartbeat.connected ||
    Number(heartbeat.trade_mode) !== 0 ||
    !isFresh(heartbeat.received_at, nowMs, staleSeconds)
  ) {
    return { locked: true, evaluated: 0, enqueued: 0 };
  }

  const symbolFilter = uniqueSymbols.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT s.signal_id, s.symbol, s.timeframe, s.strategy,
           s.strategy_version, s.state, s.score, s.as_of,
           r.checked_at AS risk_checked_at,
           r.metrics_json AS risk_metrics_json,
           z.checked_at AS sizing_checked_at,
           z.result_json AS sizing_result_json
    FROM scanner_results s
    JOIN (
      SELECT symbol, timeframe, MAX(as_of) AS latest_as_of
      FROM scanner_results
      WHERE symbol IN (${symbolFilter})
        AND timeframe = 'M5'
      GROUP BY symbol, timeframe
    ) newest
      ON newest.symbol = s.symbol
      AND newest.timeframe = s.timeframe
      AND newest.latest_as_of = s.as_of
    JOIN risk_check_results r
      ON r.signal_id = s.signal_id
      AND r.decision = 'ELIGIBLE_FOR_DEMO_EXECUTION'
    JOIN position_sizing_results z
      ON z.signal_id = s.signal_id
      AND z.decision = 'SIZED_FOR_DEMO_EXECUTION'
    WHERE s.symbol IN (${symbolFilter})
      AND s.state IN ('BUY', 'SELL')
      AND s.score >= ?
    ORDER BY s.symbol, s.score DESC, s.as_of DESC
  `).bind(
    ...uniqueSymbols,
    ...uniqueSymbols,
    DEFAULT_CONFIG.minSignalScore
  ).all<EligibleTradeRow>();

  const freshRows = rows.results.filter(row =>
    isFresh(row.risk_checked_at, nowMs, staleSeconds) &&
    isFresh(row.sizing_checked_at, nowMs, staleSeconds)
  );

  // Execute on M5 only, and only when the latest H1 and H4 EMA trends agree
  // with the M5 direction.
  const trendBySymbol = new Map<
    string,
    Partial<Record<ScannerTimeframe, TrendFeatures>>
  >();
  const candidateSymbols = [...new Set(freshRows.map(row => row.symbol))];
  if (candidateSymbols.length) {
    const trendRows = await env.DB.prepare(`
      SELECT s.symbol, s.timeframe, s.features_json
      FROM scanner_results s
      JOIN (
        SELECT symbol, timeframe, MAX(as_of) AS latest_as_of
        FROM scanner_results
        WHERE symbol IN (${candidateSymbols.map(() => "?").join(",")})
          AND timeframe IN ('H1', 'H4')
        GROUP BY symbol, timeframe
      ) newest
        ON newest.symbol = s.symbol
        AND newest.timeframe = s.timeframe
        AND newest.latest_as_of = s.as_of
    `).bind(...candidateSymbols).all<{
      symbol: string;
      timeframe: ScannerTimeframe;
      features_json: string;
    }>();
    for (const row of trendRows.results) {
      let features: TrendFeatures = null;
      try {
        features = JSON.parse(row.features_json) as TrendFeatures;
      } catch {
        features = null;
      }
      const current = trendBySymbol.get(row.symbol) ?? {};
      current[row.timeframe] = features;
      trendBySymbol.set(row.symbol, current);
    }
  }
  const alignedRows = freshRows.filter(row =>
    row.timeframe === EXECUTION_TIMEFRAME &&
    trendAligned(row.state, trendBySymbol.get(row.symbol) ?? {})
  );
  const trendBlocked = freshRows.length - alignedRows.length;
  const bestRows = chooseTopSignalPerSymbol(alignedRows);

  let enqueued = 0;
  for (const row of bestRows) {
    const sizing = JSON.parse(row.sizing_result_json) as SizingResult;
    const riskMetrics = JSON.parse(row.risk_metrics_json) as {
      max_spread_bps?: number | null;
    };
    const metrics = sizing.metrics;
    if (
      sizing.direction !== row.state ||
      !validPositive(metrics.entry_price) ||
      !validPositive(metrics.stop_loss_price) ||
      !validPositive(metrics.take_profit_price) ||
      !validPositive(metrics.volume) ||
      !validPositive(metrics.risk_budget) ||
      !Number.isFinite(metrics.risk_pct_limit) ||
      metrics.risk_pct_limit <= 0 ||
      metrics.risk_pct_limit > 0.25 ||
      !validPositive(riskMetrics.max_spread_bps ?? null)
    ) {
      continue;
    }

    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(
      nowMs + staleSeconds * 1000
    ).toISOString();
    const intentId = crypto.randomUUID();
    const payload = {
      intent_id: intentId,
      idempotency_key: row.signal_id,
      signal_id: row.signal_id,
      symbol: row.symbol,
      direction: row.state,
      timeframe: row.timeframe,
      score: row.score,
      strategy: row.strategy,
      strategy_version: row.strategy_version,
      signal_as_of: row.as_of,
      entry_reference: metrics.entry_price,
      stop_loss: metrics.stop_loss_price,
      take_profit: metrics.take_profit_price,
      volume: metrics.volume,
      risk_budget: metrics.risk_budget,
      risk_pct_limit: metrics.risk_pct_limit,
      max_spread_bps: riskMetrics.max_spread_bps,
      max_open_positions: 3,
      created_at: createdAt,
      expires_at: expiresAt
    };
    const inserted = await env.DB.prepare(`
      INSERT INTO trade_intents
        (intent_id, signal_id, symbol, direction, status,
         idempotency_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)
      ON CONFLICT DO NOTHING
      RETURNING intent_id
    `).bind(
      intentId,
      row.signal_id,
      row.symbol,
      row.state,
      row.signal_id,
      JSON.stringify(payload),
      createdAt
    ).first<{ intent_id: string }>();

    if (inserted) {
      enqueued++;
      await env.DB.prepare(`
        INSERT INTO system_events
          (level, event_type, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        "INFO",
        "TRADE_INTENT_CREATED",
        `Demo trade intent created for ${row.symbol}`,
        JSON.stringify({
          intent_id: intentId,
          signal_id: row.signal_id,
          timeframe: row.timeframe,
          score: row.score
        }),
        createdAt
      ).run();
    }
  }

  return {
    locked: false,
    evaluated: bestRows.length,
    enqueued,
    trend_blocked: trendBlocked
  };
}

export async function claimTradeIntents(
  env: Env,
  limit = 1
): Promise<{ locked: boolean; reason?: string; commands: Record<string, unknown>[] }> {
  const staleSeconds = bridgeStaleSeconds(env);
  await expirePendingIntents(env, staleSeconds);
  if (env.TRADING_ENABLED !== "true" || env.PAPER_MODE !== "true") {
    return { locked: true, reason: "Worker trading gate is disabled", commands: [] };
  }
  if (!env.EXECUTOR_API_KEY) {
    return { locked: true, reason: "Executor API key is not configured", commands: [] };
  }

  const control = await accountControlState(env);
  if (control.paused || control.kill_switch) {
    return {
      locked: true,
      reason: control.kill_switch ? "Account kill switch is active" : "Account is paused",
      commands: []
    };
  }

  const heartbeat = await env.DB.prepare(`
    SELECT connected, trade_mode, received_at
    FROM bridge_heartbeats
    ORDER BY id DESC
    LIMIT 1
  `).first<{
    connected: number;
    trade_mode: number | string;
    received_at: string;
  }>();
  if (
    !heartbeat ||
    !heartbeat.connected ||
    Number(heartbeat.trade_mode) !== 0 ||
    !isFresh(heartbeat.received_at, Date.now(), staleSeconds)
  ) {
    return { locked: true, reason: "Fresh connected demo heartbeat is required", commands: [] };
  }

  const pending = await env.DB.prepare(`
    SELECT intent_id, payload_json
    FROM trade_intents
    WHERE status = 'PENDING'
    ORDER BY created_at, intent_id
    LIMIT ?
  `).bind(limit).all<{ intent_id: string; payload_json: string }>();
  const commands: Record<string, unknown>[] = [];
  for (const row of pending.results) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown> & {
      expires_at?: string;
    };
    if (
      !payload.expires_at ||
      !Number.isFinite(Date.parse(payload.expires_at)) ||
      Date.parse(payload.expires_at) <= Date.now()
    ) {
      await env.DB.prepare(`
        UPDATE trade_intents
        SET status = 'EXPIRED'
        WHERE intent_id = ? AND status = 'PENDING'
      `).bind(row.intent_id).run();
      await env.DB.prepare(`
        INSERT INTO system_events
          (level, event_type, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        "WARN",
        "TRADE_INTENT_EXPIRED",
        `Demo trade intent expired for ${String(payload.symbol ?? "unknown")}`,
        JSON.stringify({ intent_id: row.intent_id }),
        new Date().toISOString()
      ).run();
      continue;
    }

    const claimed = await env.DB.prepare(`
      UPDATE trade_intents
      SET status = 'DISPATCHED', dispatched_at = ?
      WHERE intent_id = ? AND status = 'PENDING'
      RETURNING intent_id, payload_json
    `).bind(new Date().toISOString(), row.intent_id).first<{
      intent_id: string;
      payload_json: string;
    }>();
    if (claimed) commands.push(JSON.parse(claimed.payload_json));
  }
  return { locked: false, commands };
}

export function validExecutorAck(value: unknown): value is ExecutorAck {
  if (!value || typeof value !== "object") return false;
  const ack = value as Record<string, unknown>;
  const validCommonFields = (
    typeof ack.intent_id === "string" &&
    ack.intent_id.length > 0 &&
    ack.intent_id.length <= 64 &&
    (TERMINAL_ACK_STATUSES as readonly unknown[]).includes(ack.status) &&
    (
      ack.broker_ticket === undefined ||
      ack.broker_ticket === null ||
      (
        (typeof ack.broker_ticket === "string" ||
          (typeof ack.broker_ticket === "number" &&
            Number.isFinite(ack.broker_ticket))) &&
        String(ack.broker_ticket).length > 0 &&
        String(ack.broker_ticket).length <= 80
      )
    ) &&
    (
      ack.volume === undefined ||
      ack.volume === null ||
      (typeof ack.volume === "number" &&
        Number.isFinite(ack.volume) &&
        ack.volume > 0)
    ) &&
    (
      ack.entry_price === undefined ||
      ack.entry_price === null ||
      (typeof ack.entry_price === "number" &&
        Number.isFinite(ack.entry_price) &&
        ack.entry_price > 0)
    ) &&
    (
      ack.retcode === undefined ||
      ack.retcode === null ||
      (typeof ack.retcode === "number" && Number.isInteger(ack.retcode))
    ) &&
    (
      ack.message === undefined ||
      ack.message === null ||
      (typeof ack.message === "string" && ack.message.length <= 500)
    ) &&
    (
      ack.opened_at === undefined ||
      ack.opened_at === null ||
      (typeof ack.opened_at === "string" &&
        Number.isFinite(Date.parse(ack.opened_at)))
    )
  );
  if (!validCommonFields) return false;
  if (ack.status === "EXECUTED" || ack.status === "PARTIAL") {
    return (
      ack.broker_ticket !== undefined &&
      ack.broker_ticket !== null &&
      ack.volume !== undefined &&
      ack.volume !== null &&
      ack.entry_price !== undefined &&
      ack.entry_price !== null &&
      typeof ack.opened_at === "string" &&
      typeof ack.retcode === "number"
    );
  }
  return true;
}

export async function acknowledgeTradeIntent(
  env: Env,
  ack: ExecutorAck
): Promise<{ accepted: boolean; duplicate: boolean }> {
  const intent = await env.DB.prepare(`
    SELECT intent_id, symbol, direction, status
    FROM trade_intents
    WHERE intent_id = ?
  `).bind(ack.intent_id).first<{
    intent_id: string;
    symbol: string;
    direction: string;
    status: string;
  }>();
  if (!intent) return { accepted: false, duplicate: false };

  let history: { trade_id: string; status: string } | null = null;
  if (intent.status !== "DISPATCHED") {
    history = await env.DB.prepare(`
      SELECT trade_id, status
      FROM trade_history
      WHERE trade_id = ?
    `).bind(ack.intent_id).first<{ trade_id: string; status: string }>();
  }

  // An intent that the expiry job already flipped to UNCERTAIN may still
  // receive its real acknowledgement (the broker call can outlive the expiry
  // window). Accept it so the order is recorded and the symbol is released or
  // tracked correctly, instead of orphaning a live position.
  const lateAck =
    intent.status === "UNCERTAIN" &&
    (!history || history.status === "UNCERTAIN") &&
    !(history && ack.status === "UNCERTAIN");

  if (intent.status !== "DISPATCHED" && !lateAck) {
    return {
      accepted: !!history &&
        (intent.status === ack.status ||
          (intent.status === "CLOSED" &&
            history.status === "CLOSED" &&
            (ack.status === "EXECUTED" || ack.status === "PARTIAL"))),
      duplicate: !!history
    };
  }

  const status = ack.status;
  const level = status === "EXECUTED" || status === "PARTIAL"
    ? "INFO"
    : status === "UNCERTAIN"
      ? "ERROR"
      : "WARN";
  const openedAt = ack.opened_at ?? null;
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE trade_intents
      SET status = ?
      WHERE intent_id = ? AND status IN ('DISPATCHED', 'UNCERTAIN')
    `).bind(status, ack.intent_id),
    env.DB.prepare(`
      INSERT INTO trade_history
        (trade_id, broker_ticket, symbol, direction, volume, entry_price,
         exit_price, pnl, status, opened_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)
      ON CONFLICT (trade_id) DO UPDATE SET
        broker_ticket = EXCLUDED.broker_ticket,
        volume = EXCLUDED.volume,
        entry_price = EXCLUDED.entry_price,
        status = EXCLUDED.status,
        opened_at = EXCLUDED.opened_at
      WHERE trade_history.status = 'UNCERTAIN'
    `).bind(
      ack.intent_id,
      ack.broker_ticket == null ? null : String(ack.broker_ticket),
      intent.symbol,
      intent.direction,
      ack.volume ?? null,
      ack.entry_price ?? null,
      status,
      openedAt
    ),
    env.DB.prepare(`
      INSERT INTO system_events
        (level, event_type, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      level,
      `TRADE_${status}`,
      `Demo order ${status.toLowerCase()} for ${intent.symbol}`,
      JSON.stringify(lateAck ? { ...ack, late_ack: true } : ack),
      new Date().toISOString()
    )
  ]);
  return { accepted: true, duplicate: false };
}

export interface ResolveRequest {
  intent_id: string;
  /** NO_FILL: the operator confirmed in MT5 that no order exists.
   *  FILLED: the operator confirmed an open (or closed) position exists. */
  resolution: "NO_FILL" | "FILLED";
  broker_ticket?: string | number | null;
  volume?: number | null;
  entry_price?: number | null;
  opened_at?: string | null;
  note?: string | null;
}

export function validResolveRequest(value: unknown): value is ResolveRequest {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (
    typeof body.intent_id !== "string" ||
    !body.intent_id ||
    body.intent_id.length > 64 ||
    (body.resolution !== "NO_FILL" && body.resolution !== "FILLED") ||
    (body.note != null &&
      (typeof body.note !== "string" || body.note.length > 500)) ||
    (body.opened_at != null &&
      (typeof body.opened_at !== "string" ||
        !Number.isFinite(Date.parse(body.opened_at))))
  ) {
    return false;
  }
  if (body.resolution === "NO_FILL") return true;

  const ticket = body.broker_ticket;
  return (
    (typeof ticket === "string" || typeof ticket === "number") &&
    String(ticket).length > 0 &&
    String(ticket).length <= 80 &&
    (typeof ticket !== "number" || Number.isFinite(ticket)) &&
    typeof body.volume === "number" &&
    Number.isFinite(body.volume) &&
    body.volume > 0 &&
    typeof body.entry_price === "number" &&
    Number.isFinite(body.entry_price) &&
    body.entry_price > 0
  );
}

/**
 * Operator reconciliation for an UNCERTAIN intent. Without this an UNCERTAIN
 * intent holds the one-active-intent-per-symbol lock forever.
 */
export async function resolveUncertainIntent(
  env: Env,
  request: ResolveRequest
): Promise<{
  resolved: boolean;
  code?: "NOT_FOUND" | "NOT_UNCERTAIN";
  reason?: string;
  status?: string;
}> {
  const intent = await env.DB.prepare(`
    SELECT intent_id, symbol, direction, status
    FROM trade_intents
    WHERE intent_id = ?
  `).bind(request.intent_id).first<{
    intent_id: string;
    symbol: string;
    direction: string;
    status: string;
  }>();
  if (!intent) {
    return { resolved: false, code: "NOT_FOUND", reason: "Unknown trade intent" };
  }
  if (intent.status !== "UNCERTAIN") {
    return {
      resolved: false,
      code: "NOT_UNCERTAIN",
      reason: `Intent is ${intent.status}; only UNCERTAIN intents can be resolved`
    };
  }

  const nowIso = new Date().toISOString();
  const filled = request.resolution === "FILLED";
  const newStatus = filled ? "EXECUTED" : "REJECTED";
  const statements = [
    env.DB.prepare(`
      UPDATE trade_intents
      SET status = ?
      WHERE intent_id = ? AND status = 'UNCERTAIN'
    `).bind(newStatus, request.intent_id)
  ];

  if (filled) {
    statements.push(env.DB.prepare(`
      INSERT INTO trade_history
        (trade_id, broker_ticket, symbol, direction, volume, entry_price,
         exit_price, pnl, status, opened_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'EXECUTED', ?, NULL)
      ON CONFLICT (trade_id) DO UPDATE SET
        broker_ticket = EXCLUDED.broker_ticket,
        volume = EXCLUDED.volume,
        entry_price = EXCLUDED.entry_price,
        status = EXCLUDED.status,
        opened_at = EXCLUDED.opened_at
      WHERE trade_history.status = 'UNCERTAIN'
    `).bind(
      request.intent_id,
      String(request.broker_ticket),
      intent.symbol,
      intent.direction,
      request.volume ?? null,
      request.entry_price ?? null,
      request.opened_at ?? nowIso
    ));
  } else {
    statements.push(env.DB.prepare(`
      UPDATE trade_history
      SET status = 'REJECTED'
      WHERE trade_id = ? AND status = 'UNCERTAIN'
    `).bind(request.intent_id));
  }

  statements.push(env.DB.prepare(`
    INSERT INTO system_events
      (level, event_type, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    "WARN",
    "TRADE_INTENT_RESOLVED",
    `Operator resolved UNCERTAIN intent for ${intent.symbol} as ${request.resolution}`,
    JSON.stringify({
      intent_id: request.intent_id,
      resolution: request.resolution,
      new_status: newStatus,
      broker_ticket: request.broker_ticket ?? null,
      note: request.note ?? null
    }),
    nowIso
  ));

  await env.DB.batch(statements);
  return { resolved: true, status: newStatus };
}

export async function executorStatus(env: Env) {
  const uncertain = await env.DB.prepare(`
    SELECT intent_id, symbol, direction, created_at, dispatched_at
    FROM trade_intents
    WHERE status = 'UNCERTAIN'
    ORDER BY created_at
    LIMIT 20
  `).all<{
    intent_id: string;
    symbol: string;
    direction: string;
    created_at: string;
    dispatched_at: string | null;
  }>();
  const statuses = await env.DB.prepare(`
    SELECT status, COUNT(*) AS count
    FROM trade_intents
    GROUP BY status
  `).all<{ status: string; count: number | string }>();
  const heartbeat = await env.DB.prepare(`
    SELECT connected, trade_mode, received_at
    FROM bridge_heartbeats
    ORDER BY id DESC
    LIMIT 1
  `).first<{
    connected: number;
    trade_mode: number | string;
    received_at: string;
  }>();
  const staleSeconds = bridgeStaleSeconds(env);
  const heartbeatFresh = !!heartbeat &&
    !!heartbeat.connected &&
    Number(heartbeat.trade_mode) === 0 &&
    isFresh(heartbeat.received_at, Date.now(), staleSeconds);
  const control = await accountControlState(env);
  const counts = Object.fromEntries(
    statuses.results.map(row => [row.status, Number(row.count)])
  );
  const workerGateOpen =
    env.TRADING_ENABLED === "true" &&
    env.PAPER_MODE === "true" &&
    heartbeatFresh &&
    !!env.EXECUTOR_API_KEY &&
    !control.paused &&
    !control.kill_switch;
  return {
    agent: "EXECUTOR",
    mode: workerGateOpen ? "WORKER_GATE_OPEN" : "LOCKED",
    trading_enabled: env.TRADING_ENABLED === "true",
    paper_mode: env.PAPER_MODE === "true",
    demo_account_connected: heartbeatFresh,
    account_paused: control.paused,
    kill_switch: control.kill_switch,
    executor_key_configured: !!env.EXECUTOR_API_KEY,
    active_intents: ACTIVE_INTENT_STATUSES.reduce(
      (total, status) => total + (counts[status] ?? 0),
      0
    ),
    intents: counts,
    uncertain_intents: uncertain.results,
    position_management: {
      trailing_stop: false,
      modification: false,
      close: false
    },
    worker_gate_open: workerGateOpen,
    bridge_gate_required: true,
    execution_enabled: workerGateOpen
  };
}
