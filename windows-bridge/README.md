# MT5 Scanner, Risk Checker, Position Sizer, Executor, and Logger

The Scanner, Risk Checker, and Position Sizer produce per-timeframe candidates,
fail-closed risk decisions, and broker-specific sizes. The Executor can send a
market order only to an MT5 demo account; it remains locked unless both the
Worker and this bridge are explicitly enabled.

## Enable the MT5 economic calendar feed

1. Copy `WarRoomCalendarEA.mq5` to the demo terminal's `MQL5\Experts` folder.
2. Open it in MetaEditor, compile it, then attach `WarRoomCalendarEA` to any
   chart in the same demo terminal. The EA uses MT5's built-in economic calendar
   and writes only high-impact events within the 15-minute screening window.
3. Find the terminal's shared `Common\Files` directory and confirm it contains
   `warroom_calendar.json`. The default path is
   `%APPDATA%\MetaQuotes\Terminal\Common\Files\warroom_calendar.json`.
4. Set `MT5_CALENDAR_FILE` in `.env.windows` to that exact file path, then start
   or restart `bridge.py`. The bridge sends the calendar and open-position
   snapshots every `RISK_SNAPSHOT_SECONDS` (default 60).

The bridge discovers every instrument currently visible in MT5 Market Watch,
including broker suffixes such as `m`, and refreshes that list once per risk
snapshot. Make the intended instruments visible in Market Watch before starting
the bridge. It sends completed M5, M15, H1, and H4 candles for scanner analysis;
220 bars are requested for each timeframe and the bridge chunks requests to
stay within the API limits.

The bridge also submits 29 completed M1 candles and the broker's tick-value and
volume and contract-size specifications for each visible symbol. Scanner uses EMA(20/50/200),
MACD(12/26/9), RSI(14), ATR(14), and Bollinger Bands(20, 2). The rule score uses
weights 25/25/15/20/15 and the candidate threshold is 70; it is a heuristic, not
a probability of profit. Hypothetical SL is 2x M1 ATR(14), TP is 2R, and the
Sizer floors volume to the broker's volume step so estimated risk does not exceed
0.25% of current equity. Missing, stale, invalid, or below-minimum inputs reject
the size. The estimate does not include commissions or slippage.

The EA converts broker-server event times to UTC using the server/GMT offset.
If the EA cannot read the MT5 calendar or the exported file is older than 150
seconds, the bridge sends an unavailable snapshot and Risk Checker fails closed.
`positions_get() == None` is treated as unavailable; an empty position list is a
valid snapshot.

## Authenticated API

- `GET /api/v1/scanner/latest` reports the latest result for each symbol and
  timeframe; optional filters include `symbol` and `timeframe=M5|M15|H1|H4`.
- `GET /api/v1/risk/status` reports the policy, input freshness, and latest
  per-symbol/timeframe screening decisions.
- `GET /api/v1/risk/latest` returns latest decisions; optional filters:
  `symbol`, `timeframe`, and `decision=ELIGIBLE_FOR_PAPER_REVIEW|REJECTED`.
- `GET /api/v1/sizer/status` reports M1 input freshness and latest sizing results.
- `GET /api/v1/sizer/latest` returns the latest per-symbol/timeframe paper-review
  or demo-execution size.
- The bridge posts calendar data to `/api/v1/bridge/news-calendar` and positions
  to `/api/v1/bridge/positions`, ATR and contract data to
  `/api/v1/bridge/sizing-inputs`, and scanner candles to
  `/api/v1/bridge/scanner-candles`, using the existing `x-api-key`.

The agreed gates are a 2% UTC-day loss limit, 3% UTC-day drawdown, at most three
open positions, no existing position in the candidate symbol, a 15-minute
high-impact-news blackout, and rejection when the latest absolute one-minute
move exceeds three times the median of the previous 19 moves. A pass is not
trading authorization; per-trade risk cannot be assessed without stop-loss and
position-sizing data.

The UTC-day baseline must be observed within two minutes after midnight UTC.
If the bridge was not reporting equity then, daily loss and drawdown checks
remain blocked for that UTC day rather than assuming a safe baseline.

Position Sizer runs only after a fresh Risk Checker pass. The Executor selects
the highest-scoring eligible timeframe per symbol and enforces one active intent
per symbol. It uses a market order at the current broker quote with the Sizer's
SL/TP and volume, rechecks the demo account, open positions, broker volume
limits, expiry, and current-price risk budget, then records the broker result.
Uncertain broker outcomes remain locked for manual reconciliation; commands are
never automatically retried after dispatch.

## Executor activation and API

The Worker gate is open by default (`TRADING_ENABLED=true` in Wrangler) for the
demo observation run, but the bridge stays locked with
`MT5_TRADING_ENABLED=false` in `.env.windows.example`. Position management is
not enabled: trailing stops, modification, and closing are deferred.

Before any activation:

1. Apply `postgres/003_executor.sql` and `postgres/004_executor_hardening.sql`
   to Aiven PostgreSQL.
2. Set the Worker secret `EXECUTOR_API_KEY` and the same value in the bridge's
   local `.env.windows`; it is separate from `WARROOM_API_KEY`.
3. Keep `PAPER_MODE=true` and verify the VPS is connected to the intended demo
   account.
4. The account coordinator starts paused. Use the authenticated
   `/api/v1/control/resume` route to clear the pause. A latched kill switch
   blocks execution and makes `/resume` return 409 until it is cleared with
   `/api/v1/control/reset-kill` (which leaves the account paused).
5. To arm demo orders, Worker `TRADING_ENABLED=true` (already the default) and
   bridge `MT5_TRADING_ENABLED=true` in `.env.windows` must both be set. Either gate being false prevents
   order dispatch.

- `GET /api/v1/executor/status` reports the Worker gate, demo heartbeat, and
  outstanding intent counts (authenticated by `WARROOM_API_KEY`).
- A dedicated heartbeat thread sends a status update every 30 seconds. It only
  reports the terminal connected while the MT5 polling loop is making progress;
  if that loop stalls for 90 seconds, the heartbeat is marked disconnected and
  Executor stays fail-closed.
- The bridge claims commands from `GET /api/v1/bridge/trade-commands` and
  acknowledges them at `POST /api/v1/bridge/trade-commands/ack`, authenticated
  only by `EXECUTOR_API_KEY`.
- Closed trades with the WarRoom order magic and `WR:` intent comment are
  reconciled from MT5 deal history and reported to
  `POST /api/v1/bridge/trade-history/close`. This fills the recorded exit price
  and realized P/L; reports that cannot be matched to exactly one trade intent
  are rejected.
- Demo-eligible results appear as
  `ELIGIBLE_FOR_DEMO_EXECUTION` and `SIZED_FOR_DEMO_EXECUTION`; otherwise the
  existing paper-review decisions remain advisory.

## Logger

The Logger exposes a read-only timeline that combines scanner signals, Risk
Checker decisions and rejection reasons, trade outcomes, and Worker/system
events. Use **Load recent logs** on the dashboard or call
`GET /api/v1/logger/events?limit=50` with the `WARROOM_API_KEY`. The limit must
be between 1 and 100. Trade exit price and realized P/L are populated after the
bridge reconciles a closed MT5 deal.

## Equity

The read-only `GET /api/v1/equity/status` endpoint reports the latest balance,
equity, floating and realized P/L, UTC daily P/L, maximum drawdown, win rate,
profit factor, and the latest 100 equity snapshots. It is authenticated with
`WARROOM_API_KEY` and does not make trading decisions.
