import type { Database } from "./postgres";

interface EquitySnapshot {
  balance: number | null;
  equity: number | null;
  floating_pnl: number | null;
  currency: string | null;
  captured_at: string;
}

interface TradeMetrics {
  trades_with_pnl: number | string;
  wins: number | string;
  losses: number | string;
  gross_profit: number | string;
  gross_loss: number | string;
  realized_pl: number | string;
  daily_realized_pl: number | string;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value: number | string): number {
  return Number(value) || 0;
}

export async function equityStatus(
  db: Database,
  now = new Date()
) {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  const [curveRows, dayStartRow, tradeMetrics, drawdownRow] = await Promise.all([
    db.prepare(`
      SELECT balance, equity, floating_pnl, currency, captured_at
      FROM equity_snapshots
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).bind(100).all<EquitySnapshot>(),
    db.prepare(`
      SELECT equity, captured_at
      FROM equity_snapshots
      WHERE captured_at >= ? AND equity IS NOT NULL
      ORDER BY captured_at, id
      LIMIT 1
    `).bind(dayStartIso).first<{ equity: number | null; captured_at: string }>(),
    db.prepare(`
      SELECT
        COUNT(*) AS trades_with_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) AS losses,
        COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0) AS gross_profit,
        COALESCE(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END), 0) AS gross_loss,
        COALESCE(SUM(pnl), 0) AS realized_pl,
        COALESCE(SUM(
          CASE WHEN closed_at >= ? THEN pnl ELSE 0 END
        ), 0) AS daily_realized_pl
      FROM trade_history
      WHERE status = 'CLOSED' AND pnl IS NOT NULL
    `).bind(dayStartIso).first<TradeMetrics>(),
    db.prepare(`
      SELECT MAX(
        CASE WHEN running_peak > 0
          THEN (running_peak - equity) / running_peak * 100
          ELSE NULL
        END
      ) AS max_drawdown_pct
      FROM (
        SELECT equity,
          MAX(equity) OVER (
            ORDER BY captured_at, id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS running_peak
        FROM equity_snapshots
        WHERE equity IS NOT NULL
      ) drawdowns
    `).first<{ max_drawdown_pct: number | null }>()
  ]);

  const latest = curveRows.results[0] ?? null;
  const trades = tradeMetrics ?? {
    trades_with_pnl: 0,
    wins: 0,
    losses: 0,
    gross_profit: 0,
    gross_loss: 0,
    realized_pl: 0,
    daily_realized_pl: 0
  };
  const wins = count(trades.wins);
  const losses = count(trades.losses);
  const grossProfit = numberOrNull(trades.gross_profit) ?? 0;
  const grossLoss = numberOrNull(trades.gross_loss) ?? 0;
  const currentEquity = numberOrNull(latest?.equity);
  const baselineEquity = numberOrNull(dayStartRow?.equity);
  const ageSeconds = latest
    ? (now.getTime() - Date.parse(latest.captured_at)) / 1000
    : null;

  return {
    agent: "EQUITY",
    monitoring_only: true,
    data_available: !!latest,
    balance: numberOrNull(latest?.balance),
    equity: currentEquity,
    floating_pl: numberOrNull(latest?.floating_pnl),
    realized_pl: numberOrNull(trades.realized_pl) ?? 0,
    daily_pl: currentEquity !== null && baselineEquity !== null
      ? currentEquity - baselineEquity
      : null,
    daily_realized_pl: numberOrNull(trades.daily_realized_pl) ?? 0,
    max_drawdown_pct: numberOrNull(drawdownRow?.max_drawdown_pct),
    win_rate_pct: wins + losses > 0 ? wins / (wins + losses) * 100 : null,
    profit_factor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    closed_trades_with_pnl: count(trades.trades_with_pnl),
    currency: latest?.currency ?? null,
    last_updated_at: latest?.captured_at ?? null,
    age_seconds: ageSeconds !== null && Number.isFinite(ageSeconds)
      ? Math.max(0, ageSeconds)
      : null,
    equity_curve: curveRows.results.reverse(),
    execution_enabled: false
  };
}
