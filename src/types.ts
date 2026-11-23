import type { Database } from "./postgres";
import type {
  Candle,
  ScannerTimeframe
} from "./scanner";

export interface Env {
  DB: Database;
  HYPERDRIVE: Hyperdrive;
  MARKET_INGEST: Queue;
  AGENT_TASKS: Queue;
  TRADE_COMMANDS: Queue;
  MARKET_ARCHIVE: R2Bucket;
  ACCOUNT_COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  WARROOM_API_KEY: string;
  EXECUTOR_API_KEY?: string;
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

export interface NewsCalendarEvent {
  event_id: string;
  name: string;
  currency: string;
  importance: "HIGH";
  scheduled_at: string;
}

export interface NewsCalendarPayload {
  generated_at: string;
  available: boolean;
  error?: string | null;
  events: NewsCalendarEvent[];
}

export interface PositionSnapshotPayload {
  captured_at: string;
  positions: Array<{
    symbol: string;
    direction: "BUY" | "SELL";
    volume: number;
  }>;
}

export interface M1Candle {
  time: string;
  high: number;
  low: number;
  close: number;
}

export interface SizingInputSymbol {
  symbol: string;
  available: boolean;
  error?: string | null;
  candles: M1Candle[];
  spec: {
    tick_size: number;
    tick_value_loss: number;
    contract_size: number;
    volume_min: number;
    volume_max: number;
    volume_step: number;
  } | null;
}

export interface SizingInputsPayload {
  captured_at: string;
  symbols: SizingInputSymbol[];
}

export interface ScannerCandleFrame {
  timeframe: ScannerTimeframe;
  available: boolean;
  error?: string | null;
  candles: Candle[];
}

export interface ScannerCandleSymbol {
  symbol: string;
  timeframes: ScannerCandleFrame[];
}

export interface ScannerCandlesPayload {
  captured_at: string;
  symbols: ScannerCandleSymbol[];
}
