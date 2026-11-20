# MT5 Risk Checker data feed

The Risk Checker only screens scanner results for **paper/research review**. It
does not create trade intents or send orders. Missing or stale news, position,
market, or equity data rejects a candidate.

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

The EA converts broker-server event times to UTC using the server/GMT offset.
If the EA cannot read the MT5 calendar or the exported file is older than 150
seconds, the bridge sends an unavailable snapshot and Risk Checker fails closed.
`positions_get() == None` is treated as unavailable; an empty position list is a
valid snapshot.

## Authenticated API

- `GET /api/v1/risk/status` reports the policy, input freshness, and latest
  per-symbol screening decisions.
- `GET /api/v1/risk/latest` returns latest decisions; optional filters:
  `symbol` and `decision=ELIGIBLE_FOR_PAPER_REVIEW|REJECTED`.
- The bridge posts calendar data to `/api/v1/bridge/news-calendar` and positions
  to `/api/v1/bridge/positions` using the existing `x-api-key`.

The agreed gates are a 2% UTC-day loss limit, 3% UTC-day drawdown, at most three
open positions, no existing position in the candidate symbol, a 15-minute
high-impact-news blackout, and rejection when the latest absolute one-minute
move exceeds three times the median of the previous 19 moves. A pass is not
trading authorization; per-trade risk cannot be assessed without stop-loss and
position-sizing data.

The UTC-day baseline must be observed within two minutes after midnight UTC.
If the bridge was not reporting equity then, daily loss and drawdown checks
remain blocked for that UTC day rather than assuming a safe baseline.
