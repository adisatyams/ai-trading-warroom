declare module "pg" {
  export interface QueryResult<Row = Record<string, unknown>> {
    rows: Row[];
    rowCount: number | null;
  }

  export class Client {
    constructor(options: {
      connectionString: string;
      connectionTimeoutMillis?: number;
    });
    connect(): Promise<void>;
    query<Row = Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }
}
