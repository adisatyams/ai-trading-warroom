# MT5 Scanner, Risk Checker, and Position Sizer data feeds

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
the size; no order is submitted. The estimate does not include commissions or
slippage.

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
  size.
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

Position Sizer runs only after a fresh Risk Checker pass. Its stop and size are
research estimates, not trading instructions or authorization.
