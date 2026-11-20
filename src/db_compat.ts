type CompatibleTable =
  | "agent_status"
  | "market_latest"
  | "system_events"
  | "instruments"
  | "equity_snapshots";

export async function tableColumns(
  db: D1Database,
  table: CompatibleTable
): Promise<Set<string>> {
  const statements: Record<CompatibleTable, string> = {
    agent_status: "PRAGMA table_info(agent_status)",
    market_latest: "PRAGMA table_info(market_latest)",
    system_events: "PRAGMA table_info(system_events)",
    instruments: "PRAGMA table_info(instruments)",
    equity_snapshots: "PRAGMA table_info(equity_snapshots)"
  };
  const rows = await db.prepare(statements[table]).all<{ name: string }>();
  return new Set(rows.results.map(row => row.name));
}

export function agentStatusSelect(columns: Set<string>): string | null {
  const nameColumn = ["agent_name", "agent_id"].find(column =>
    columns.has(column)
  );
  if (!nameColumn || !columns.has("status")) return null;

  const detailColumns = [
    "detail",
    "metadata",
    "error_message",
    "strategy_name"
  ].filter(column => columns.has(column));
  const detail = detailColumns.length
    ? `COALESCE(${detailColumns.join(", ")}, '')`
    : "''";
  const seenColumn = ["last_seen_at", "last_heartbeat"].find(column =>
    columns.has(column)
  );

  return `
    SELECT
      ${nameColumn} AS name,
      status,
      ${detail} AS detail,
      ${seenColumn ?? "NULL"} AS last_seen_at
    FROM agent_status
    ORDER BY ${nameColumn}
  `;
}

export function marketLatestSelect(columns: Set<string>): string | null {
  if (!["symbol", "bid", "ask"].every(column => columns.has(column))) {
    return null;
  }
  const lastColumn = ["last", "last_price"].find(column =>
    columns.has(column)
  );
  const tickTimeColumn = columns.has("tick_time") ? "tick_time" : "NULL";
  const receivedColumn = ["received_at", "updated_at"].find(column =>
    columns.has(column)
  );

  return `
    SELECT
      symbol,
      bid,
      ask,
      ${lastColumn ?? "NULL"} AS last,
      ${tickTimeColumn} AS tick_time,
      ${receivedColumn ?? "NULL"} AS received_at
    FROM market_latest
    ORDER BY symbol
  `;
}

export function marketLatestUpsert(
  columns: Set<string>
): { sql: string; legacy: boolean } | null {
  if (!["symbol", "bid", "ask"].every(column => columns.has(column))) {
    return null;
  }

  if (
    columns.has("last_price") &&
    columns.has("updated_at") &&
    !columns.has("received_at")
  ) {
    return {
      legacy: true,
      sql: `
        INSERT INTO market_latest
          (symbol, bid, ask, last_price, last, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          bid = excluded.bid,
          ask = excluded.ask,
          last_price = excluded.last_price,
          last = excluded.last,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= market_latest.updated_at
      `
    };
  }

  if (!["tick_time", "received_at"].every(column => columns.has(column))) {
    return null;
  }
  return {
    legacy: false,
    sql: `
      INSERT INTO market_latest
        (symbol, bid, ask, last, tick_time, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        bid = excluded.bid,
        ask = excluded.ask,
        last = excluded.last,
        tick_time = excluded.tick_time,
        received_at = excluded.received_at
      WHERE excluded.received_at >= market_latest.received_at
    `
  };
}

export function scannerAgentStatusUpdate(
  columns: Set<string>,
  timestamp: string,
  strategy: string,
  detail: string
): { sql: string; values: unknown[] } | null {
  if (
    columns.has("agent_name") &&
    columns.has("last_seen_at") &&
    columns.has("detail") &&
    columns.has("status")
  ) {
    return {
      sql: `
        UPDATE agent_status
        SET status = 'READY', last_seen_at = ?, detail = ?
        WHERE agent_name = 'SCANNER'
      `,
      values: [timestamp, detail]
    };
  }

  if (
    !columns.has("agent_id") ||
    !columns.has("last_heartbeat") ||
    !columns.has("status")
  ) {
    return null;
  }

  const assignments = ["status = 'running'", "last_heartbeat = ?"];
  const values: unknown[] = [timestamp];
  if (columns.has("strategy_name")) {
    assignments.push("strategy_name = ?");
    values.push(strategy);
  }
  if (columns.has("metadata")) {
    assignments.push("metadata = ?");
    values.push(JSON.stringify({ detail, execution_enabled: false }));
  }
  if (columns.has("error_message")) {
    assignments.push("error_message = NULL");
  }
  values.push("SCANNER");

  return {
    sql: `
      UPDATE agent_status
      SET ${assignments.join(", ")}
      WHERE agent_id = ?
    `,
    values
  };
}

export async function insertSystemEvent(
  db: D1Database,
  event: {
    level: string;
    event_type: string;
    message: string;
    payload?: string;
    created_at: string;
  }
): Promise<void> {
  const columns = await tableColumns(db, "system_events");
  const statement = systemEventInsert(columns, event);

  await db.prepare(statement.sql).bind(...statement.values).run();
}

export function systemEventInsert(
  columns: Set<string>,
  event: {
    level: string;
    event_type: string;
    message: string;
    payload?: string;
    created_at: string;
  }
): { sql: string; values: unknown[] } {
  const values: Array<[string, unknown]> = [
    ["component", "worker"],
    ["level", event.level],
    ["event_type", event.event_type],
    ["message", event.message],
    ["payload_json", event.payload ?? null],
    ["payload", event.payload ?? null],
    ["created_at", event.created_at]
  ];
  const entries = values.filter(([column]) => columns.has(column));

  if (!["level", "event_type", "message", "created_at"].every(column =>
    columns.has(column)
  )) {
    throw new Error("system_events table is missing required columns");
  }

  return {
    sql: `
      INSERT INTO system_events (${entries.map(([column]) => column).join(", ")})
      VALUES (${entries.map(() => "?").join(", ")})
    `,
    values: entries.map(([, value]) => value)
  };
}
