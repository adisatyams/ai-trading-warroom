import { Client } from "pg";

export interface DatabaseStatement {
  bind(...values: unknown[]): DatabaseStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true; meta: { changes: number } }>;
}

export interface Database {
  prepare(sql: string): DatabaseStatement;
  batch(statements: DatabaseStatement[]): Promise<unknown[]>;
}

interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  end(): Promise<void>;
}

function isTransientPostgresError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("open slot") ||
    message.includes("connection terminated unexpectedly") ||
    message.includes("connection reset") ||
    message.includes("temporarily unavailable")
  );
}

async function retryTransientPostgres<T>(
  operation: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientPostgresError(error) || attempt === 2) throw error;
      await new Promise(resolve =>
        setTimeout(resolve, 250 * (attempt + 1))
      );
    }
  }
  throw lastError;
}

export function postgresPlaceholders(sql: string): string {
  let output = "";
  let parameter = 0;
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      output += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      output += char;
      if (char === "*" && next === "/") {
        output += next;
        index++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote && next === quote) {
        output += next;
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      output += char + next;
      index++;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      output += char + next;
      index++;
      blockComment = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      output += char;
    } else if (char === "?") {
      output += `$${++parameter}`;
    } else {
      output += char;
    }
  }
  return output;
}

class PostgresStatement implements DatabaseStatement {
  private values: unknown[] = [];
  private readonly sql: string;
  private readonly connectionString: string;

  constructor(connectionString: string, sql: string) {
    this.connectionString = connectionString;
    this.sql = sql;
  }

  bind(...values: unknown[]): DatabaseStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const result = await this.query();
    return (result.rows[0] as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const result = await this.query();
    return { results: result.rows as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = await this.query();
    return {
      success: true,
      meta: { changes: result.rowCount ?? 0 }
    };
  }

  async execute(client: PgClient): Promise<unknown> {
    return client.query(postgresPlaceholders(this.sql), this.values);
  }

  private async query() {
    return retryTransientPostgres(async () => {
      const client = new Client({
        connectionString: this.connectionString,
        connectionTimeoutMillis: 5_000
      });
      await client.connect();
      try {
        return await client.query(postgresPlaceholders(this.sql), this.values);
      } finally {
        await client.end();
      }
    });
  }
}

export class PostgresDatabase implements Database {
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  prepare(sql: string): DatabaseStatement {
    return new PostgresStatement(this.connectionString, sql);
  }

  async batch(statements: DatabaseStatement[]): Promise<unknown[]> {
    return retryTransientPostgres(async () => {
      const client = new Client({
        connectionString: this.connectionString,
        connectionTimeoutMillis: 5_000
      });
      await client.connect();
      try {
        await client.query("BEGIN");
        const results: unknown[] = [];
        for (const statement of statements) {
          if (!(statement instanceof PostgresStatement)) {
            throw new TypeError("PostgreSQL batch received a foreign statement");
          }
          results.push(await statement.execute(client));
        }
        await client.query("COMMIT");
        return results;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "POSTGRES_BATCH_ROLLBACK_FAILURE",
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          );
        }
        throw error;
      } finally {
        await client.end();
      }
    });
  }
}

export function postgresDatabase(connectionString: string): Database {
  return new PostgresDatabase(connectionString);
}
