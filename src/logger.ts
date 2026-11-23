import type { Database } from "./postgres";

export interface LoggerEvent {
  occurred_at: string;
  source: string;
  level: string;
  event_type: string;
  message: string;
  details: string;
}

export interface ClosedTradeReport {
  intent_prefix: string;
  exit_price: number;
  pnl: number;
  closed_at: string;
  close_ticket: string;
}

export function validClosedTradeReport(value: unknown): value is ClosedTradeReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return (
    typeof report.intent_prefix === "string" &&
    /^[a-zA-Z0-9-]{24}$/.test(report.intent_prefix) &&
    typeof report.exit_price === "number" &&
    Number.isFinite(report.exit_price) &&
    report.exit_price > 0 &&
    typeof report.pnl === "number" &&
    Number.isFinite(report.pnl) &&
    typeof report.closed_at === "string" &&
    Number.isFinite(Date.parse(report.closed_at)) &&
    typeof report.close_ticket === "string" &&
    report.close_ticket.length > 0 &&
    report.close_ticket.length <= 80
  );
}

export async function recordClosedTrade(
  db: Database,
  report: ClosedTradeReport
): Promise<{ accepted: boolean; duplicate: boolean }> {
  const matches = await db.prepare(`
    SELECT h.trade_id, h.symbol, h.status, h.exit_price, h.pnl
    FROM trade_intents i
    JOIN trade_history h ON h.trade_id = i.intent_id
    WHERE i.intent_id LIKE ?
  `).bind(`${report.intent_prefix}%`).all<{
    trade_id: string;
    symbol: string;
    status: string;
    exit_price: number | null;
    pnl: number | null;
  }>();
  if (matches.results.length !== 1) {
    return { accepted: false, duplicate: false };
  }

  const trade = matches.results[0];
  if (trade.exit_price !== null) {
    const sameReport =
      trade.exit_price === report.exit_price &&
      trade.pnl === report.pnl;
    return { accepted: sameReport, duplicate: sameReport };
  }
  if (!["EXECUTED", "PARTIAL", "CLOSED"].includes(trade.status)) {
    return { accepted: false, duplicate: false };
  }

  const updated = await db.prepare(`
    UPDATE trade_history
    SET exit_price = ?, pnl = ?, closed_at = ?, status = 'CLOSED'
    WHERE trade_id = ? AND exit_price IS NULL
  `).bind(
    report.exit_price,
    report.pnl,
    report.closed_at,
    trade.trade_id
  ).run();
  if (!updated.meta.changes) {
    return { accepted: false, duplicate: false };
  }

  return { accepted: true, duplicate: false };
}

export const LOGGER_EVENTS_SQL = `
  SELECT occurred_at, source, level, event_type, message, details
  FROM (
    SELECT
      COALESCE(as_of, created_at) AS occurred_at,
      'SCANNER' AS source,
      CASE WHEN state = 'REJECTED' THEN 'WARN' ELSE 'INFO' END AS level,
      'SIGNAL_' || state AS event_type,
      'Scanner ' || state || ' ' || symbol || ' (' || timeframe || ')' AS message,
      'signal_id=' || signal_id ||
        '; score=' || COALESCE(CAST(score AS TEXT), 'null') ||
        '; entry=' || COALESCE(CAST(entry AS TEXT), 'null') ||
        '; stop_loss=' || COALESCE(CAST(stop_loss AS TEXT), 'null') ||
        '; take_profit=' || COALESCE(CAST(take_profit AS TEXT), 'null') ||
        '; reject_reason=' || COALESCE(reject_reason, '') ||
        '; reasons=' || reasons_json AS details
    FROM scanner_results
    WHERE state IN ('BUY', 'SELL', 'REJECTED')

    UNION ALL

    SELECT
      checked_at AS occurred_at,
      'RISK_CHECK' AS source,
      CASE WHEN decision = 'REJECTED' THEN 'WARN' ELSE 'INFO' END AS level,
      CASE
        WHEN decision = 'REJECTED' THEN 'SIGNAL_REJECTED'
        ELSE 'RISK_CHECK_PASSED'
      END AS event_type,
      'Risk check ' || decision || ' ' || symbol || ' (' || timeframe || ')' AS message,
      'signal_id=' || signal_id ||
        '; reasons=' || reasons_json ||
        '; metrics=' || metrics_json AS details
    FROM risk_check_results

    UNION ALL

    SELECT
      COALESCE(closed_at, opened_at, '') AS occurred_at,
      'EXECUTOR' AS source,
      CASE
        WHEN status IN ('REJECTED', 'FAILED', 'UNCERTAIN') THEN 'ERROR'
        ELSE 'INFO'
      END AS level,
      'TRADE_' || status AS event_type,
      'Trade ' || status || ' ' || direction || ' ' || symbol AS message,
      'trade_id=' || trade_id ||
        '; broker_ticket=' || COALESCE(broker_ticket, '') ||
        '; volume=' || COALESCE(CAST(volume AS TEXT), 'null') ||
        '; entry_price=' || COALESCE(CAST(entry_price AS TEXT), 'null') ||
        '; exit_price=' || COALESCE(CAST(exit_price AS TEXT), 'null') ||
        '; pnl=' || COALESCE(CAST(pnl AS TEXT), 'null') AS details
    FROM trade_history

    UNION ALL

    SELECT
      created_at AS occurred_at,
      'WORKER' AS source,
      level,
      event_type,
      message,
      COALESCE(payload_json, '') AS details
    FROM system_events
  ) events
  ORDER BY occurred_at DESC, event_type ASC
  LIMIT ?
`;

export async function loggerEvents(
  db: Database,
  limit: number
): Promise<LoggerEvent[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Logger event limit must be an integer from 1 to 100");
  }
  const result = await db.prepare(LOGGER_EVENTS_SQL)
    .bind(limit)
    .all<LoggerEvent>();
  return result.results;
}
