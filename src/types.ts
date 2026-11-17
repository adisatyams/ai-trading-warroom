export interface Env {
  DB: D1Database;
  MARKET_INGEST: Queue;
  AGENT_TASKS: Queue;
  TRADE_COMMANDS: Queue;
  MARKET_ARCHIVE: R2Bucket;
  ACCOUNT_COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  WARROOM_API_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  APP_ENV: string;
  TRADING_ENABLED: string;
  PAPER_MODE: string;
  BRIDGE_STALE_SECONDS: string;
  MAX_RISK_PER_TRADE_PCT: string;
  MAX_DAILY_LOSS_PCT: string;
  MAX_DRAWDOWN_PCT: string;
}

export interface Heartbeat {
  terminal_name?: string;
  account_server?: string;
  account_login?: string | number;
  connected?: boolean;
  balance?: number;
  equity?: number;
  currency?: string;
  trade_mode?: number;
}

export interface Tick {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  time?: string;
  volume?: number;
}

export interface MarketBatch {
  batch_id: string;
  received_at?: string;
  ticks: Tick[];
}
