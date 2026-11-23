import os
import time
import uuid
import logging
import threading
from datetime import datetime, timedelta, timezone

import httpx
import MetaTrader5 as mt5
from dotenv import load_dotenv
from calendar_feed import read_calendar_snapshot

load_dotenv(".env.windows")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

BASE = os.environ["WARROOM_API_URL"].rstrip("/")
KEY = os.environ["WARROOM_API_KEY"]
PATH = os.getenv("MT5_PATH", "")
SYMBOLS = []
SCANNER_TIMEFRAMES = {
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
}
SCANNER_CANDLE_COUNT = 220
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "5"))
HEARTBEAT_SECONDS = min(max(int(os.getenv("HEARTBEAT_SECONDS", "30")), 10), 60)
MARKET_BATCH_SECONDS = int(os.getenv("MARKET_BATCH_SECONDS", "60"))
RISK_SNAPSHOT_SECONDS = int(os.getenv("RISK_SNAPSHOT_SECONDS", "60"))
CALENDAR_FILE = os.getenv("MT5_CALENDAR_FILE", "")
HEADERS = {"x-api-key": KEY}
EXECUTOR_KEY = os.getenv("EXECUTOR_API_KEY", "")
EXECUTOR_ENABLED = os.getenv("MT5_TRADING_ENABLED", "").lower() == "true"
EXECUTOR_POLL_SECONDS = int(os.getenv("EXECUTOR_POLL_SECONDS", "5"))
EXECUTOR_HEADERS = {"x-executor-api-key": EXECUTOR_KEY}
ORDER_MAGIC = int(os.getenv("MT5_ORDER_MAGIC", "540062"))
ORDER_DEVIATION = int(os.getenv("MT5_ORDER_DEVIATION", "20"))
REPORTED_CLOSED_TRADES = set()
HEARTBEAT_WORKER = None


def _ack(command, status, message, result=None, volume=None, entry_price=None):
    deal = getattr(result, "deal", 0) if result is not None else 0
    order = getattr(result, "order", 0) if result is not None else 0
    return {
        "intent_id": command.get("intent_id", ""),
        "status": status,
        "broker_ticket": (
            str(deal or order)
            if deal or order
            else None
        ),
        "volume": volume,
        "entry_price": entry_price,
        "retcode": int(result.retcode) if result is not None else None,
        "message": str(message)[:500],
        "opened_at": datetime.now(timezone.utc).isoformat()
        if status in ("EXECUTED", "PARTIAL")
        else None,
    }


def _valid_positive(value):
    try:
        return float(value) > 0 and float(value) < float("inf")
    except (TypeError, ValueError):
        return False


def _execute_trade_command(command, acc):
    if not EXECUTOR_ENABLED:
        return _ack(command, "REJECTED", "MT5_TRADING_ENABLED is false")
    if acc is None or acc.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
        return _ack(command, "REJECTED", "Only an MT5 demo account may execute orders")

    intent_id = command.get("intent_id")
    symbol = command.get("symbol")
    direction = command.get("direction")
    if not isinstance(intent_id, str) or not intent_id or len(intent_id) > 64:
        return _ack(command, "REJECTED", "Invalid intent id")
    if not isinstance(symbol, str) or not symbol or len(symbol) > 32:
        return _ack(command, "REJECTED", "Invalid symbol")
    if direction not in ("BUY", "SELL"):
        return _ack(command, "REJECTED", "Invalid direction")

    try:
        expires_at = datetime.fromisoformat(
            str(command["expires_at"]).replace("Z", "+00:00")
        )
        if expires_at.tzinfo is None or expires_at <= datetime.now(timezone.utc):
            return _ack(command, "REJECTED", "Trade intent expired")
        volume = float(command["volume"])
        stop_loss = float(command["stop_loss"])
        take_profit = float(command["take_profit"])
        risk_budget = float(command["risk_budget"])
        risk_pct_limit = float(command["risk_pct_limit"])
        max_spread_bps = float(command["max_spread_bps"])
        max_open_positions = int(command["max_open_positions"])
    except (KeyError, TypeError, ValueError):
        return _ack(command, "REJECTED", "Invalid sizing or expiry data")

    if (
        not all(_valid_positive(value) for value in (
            volume, stop_loss, take_profit, risk_budget, risk_pct_limit,
            max_spread_bps
        ))
        or risk_pct_limit > 0.25
        or max_open_positions < 1
        or max_open_positions > 3
    ):
        return _ack(command, "REJECTED", "Invalid size or risk limit")

    try:
        if symbol not in SYMBOLS:
            refresh_symbols()
        selected = symbol in SYMBOLS and mt5.symbol_select(symbol, True)
        info = mt5.symbol_info(symbol) if selected else None
        tick = mt5.symbol_info_tick(symbol) if selected else None
    except Exception as error:
        logging.exception("MT5 symbol preflight failed for intent %s", intent_id)
        return _ack(command, "REJECTED", f"MT5 symbol preflight failed: {error}")
    if not selected:
        return _ack(command, "REJECTED", "Symbol is unavailable in MT5 Market Watch")
    if info is None or tick is None:
        return _ack(command, "REJECTED", "Current MT5 symbol data is unavailable")

    try:
        trade_mode = int(info.trade_mode)
    except (TypeError, ValueError, OverflowError):
        return _ack(command, "REJECTED", "Broker trade mode is invalid")
    if (
        trade_mode == getattr(mt5, "SYMBOL_TRADE_MODE_DISABLED", 0)
        or trade_mode == getattr(mt5, "SYMBOL_TRADE_MODE_CLOSEONLY", 3)
        or (direction == "BUY" and trade_mode == getattr(mt5, "SYMBOL_TRADE_MODE_SHORTONLY", 2))
        or (direction == "SELL" and trade_mode == getattr(mt5, "SYMBOL_TRADE_MODE_LONGONLY", 1))
    ):
        return _ack(command, "REJECTED", "Broker does not permit this trade direction")

    try:
        positions = mt5.positions_get()
    except Exception as error:
        logging.exception("MT5 position preflight failed for intent %s", intent_id)
        return _ack(command, "REJECTED", f"Unable to verify current positions: {error}")
    if positions is None:
        return _ack(command, "REJECTED", "Unable to verify current open positions")
    if any(str(position.symbol) == symbol for position in positions):
        return _ack(command, "REJECTED", "A position is already open for this symbol")
    if len(positions) >= max_open_positions:
        return _ack(command, "REJECTED", "Maximum open-position limit has been reached")

    try:
        entry_price = float(tick.ask if direction == "BUY" else tick.bid)
        bid = float(tick.bid)
        ask = float(tick.ask)
        if not _valid_positive(bid) or not _valid_positive(ask) or ask < bid:
            return _ack(command, "REJECTED", "Current MT5 quote is invalid")
        spread_bps = ((ask - bid) / ((ask + bid) / 2)) * 10_000
        if spread_bps > max_spread_bps:
            return _ack(command, "REJECTED", "Current spread exceeds the Risk Checker limit")
        tick_size = float(info.trade_tick_size)
        tick_value_loss = float(info.trade_tick_value_loss)
        point = float(info.point)
        equity = float(acc.equity)
        volume_min = float(info.volume_min)
        volume_max = float(info.volume_max)
        volume_step = float(info.volume_step)
        digits = int(info.digits)
        filling_modes = int(info.filling_mode)
    except (TypeError, ValueError, OverflowError):
        return _ack(command, "REJECTED", "Broker price or contract specification is invalid")
    if (
        not all(_valid_positive(value) for value in (
            entry_price, tick_size, tick_value_loss, point, equity,
            volume_min, volume_max, volume_step
        ))
        or digits < 0
        or volume < volume_min
        or volume > volume_max
    ):
        return _ack(command, "REJECTED", "Broker price or contract specification is invalid")

    if abs(round(volume / volume_step) * volume_step - volume) > volume_step * 1e-6:
        return _ack(command, "REJECTED", "Order volume does not match broker volume step")

    if direction == "BUY":
        if not stop_loss < entry_price < take_profit:
            return _ack(command, "REJECTED", "Current price crossed the BUY stop or target")
    elif not take_profit < entry_price < stop_loss:
        return _ack(command, "REJECTED", "Current price crossed the SELL stop or target")

    if filling_modes & getattr(mt5, "SYMBOL_FILLING_FOK", 1):
        filling = mt5.ORDER_FILLING_FOK
    elif filling_modes & getattr(mt5, "SYMBOL_FILLING_IOC", 2):
        filling = mt5.ORDER_FILLING_IOC
    else:
        return _ack(command, "REJECTED", "Broker has no supported market-order filling mode")

    rounded_stop_loss = round(stop_loss, digits)
    rounded_take_profit = round(take_profit, digits)
    if direction == "BUY":
        if not rounded_stop_loss < entry_price < rounded_take_profit:
            return _ack(command, "REJECTED", "Rounded BUY stop or target is invalid")
    elif not rounded_take_profit < entry_price < rounded_stop_loss:
        return _ack(command, "REJECTED", "Rounded SELL stop or target is invalid")

    deviation_points = float(ORDER_DEVIATION)
    if not _valid_positive(deviation_points):
        return _ack(command, "REJECTED", "MT5 order deviation is invalid")
    worst_entry_price = (
        entry_price + deviation_points * point
        if direction == "BUY"
        else entry_price - deviation_points * point
    )
    if not _valid_positive(worst_entry_price):
        return _ack(command, "REJECTED", "MT5 worst-fill price is invalid")

    if direction == "BUY":
        if not worst_entry_price < take_profit:
            return _ack(command, "REJECTED", "Worst fill would cross the BUY target")
    elif not worst_entry_price > take_profit:
        return _ack(command, "REJECTED", "Worst fill would cross the SELL target")

    current_risk_budget = min(risk_budget, equity * risk_pct_limit / 100)
    estimated_loss = (
        abs(worst_entry_price - rounded_stop_loss)
        / tick_size * tick_value_loss * volume
    )
    if not _valid_positive(estimated_loss) or estimated_loss > current_risk_budget:
        return _ack(command, "REJECTED", "Current entry price would exceed the risk limit")

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL,
        "price": entry_price,
        "sl": rounded_stop_loss,
        "tp": rounded_take_profit,
        "deviation": ORDER_DEVIATION,
        "magic": ORDER_MAGIC,
        "comment": "WR:" + intent_id[:24],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling,
    }
    try:
        checked = mt5.order_check(request)
    except Exception as error:
        logging.exception("MT5 order_check raised for intent %s", intent_id)
        return _ack(command, "REJECTED", f"MT5 order_check failed: {error}")
    if checked is None:
        return _ack(command, "REJECTED", f"MT5 order_check failed: {mt5.last_error()}")
    if int(checked.retcode) not in (
        0,
        getattr(mt5, "TRADE_RETCODE_DONE", 10009),
    ):
        return _ack(command, "REJECTED", checked.comment or "MT5 order_check rejected order", checked)

    try:
        result = mt5.order_send(request)
    except Exception as error:
        logging.exception("MT5 order_send raised for intent %s", intent_id)
        return _ack(command, "UNCERTAIN", str(error))
    if result is None:
        return _ack(
            command,
            "UNCERTAIN",
            f"MT5 order_send returned no result: {mt5.last_error()}",
        )

    retcode = int(result.retcode)
    if retcode == getattr(mt5, "TRADE_RETCODE_DONE", 10009):
        return _ack(
            command,
            "EXECUTED",
            result.comment or "Market order executed",
            result,
            float(getattr(result, "volume", volume) or volume),
            float(getattr(result, "price", entry_price) or entry_price),
        )
    if retcode == getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010):
        return _ack(
            command,
            "PARTIAL",
            result.comment or "Market order partially executed",
            result,
            float(getattr(result, "volume", volume) or volume),
            float(getattr(result, "price", entry_price) or entry_price),
        )
    if retcode == getattr(mt5, "TRADE_RETCODE_PLACED", 10008):
        return _ack(command, "UNCERTAIN", result.comment or "Order placed without fill confirmation", result)
    return _ack(command, "REJECTED", result.comment or f"Broker rejected order ({retcode})", result)


def poll_trade_commands(client: httpx.Client, acc):
    if not EXECUTOR_ENABLED:
        return
    if not EXECUTOR_KEY:
        return

    response = client.get(
        BASE + "/api/v1/bridge/trade-commands",
        headers=EXECUTOR_HEADERS,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("locked"):
        logging.info("Executor remains locked: %s", payload.get("reason", "Worker gate"))
        return

    commands = payload.get("commands")
    if not isinstance(commands, list):
        raise RuntimeError("Executor returned an invalid command list")
    for command in commands:
        current_account = mt5.account_info()
        if current_account is None or current_account.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
            raise RuntimeError("Account is no longer DEMO; refusing executor command")
        ack = _execute_trade_command(command, current_account)
        ack_response = client.post(
            BASE + "/api/v1/bridge/trade-commands/ack",
            headers=EXECUTOR_HEADERS,
            json=ack,
        )
        ack_response.raise_for_status()
        logging.info(
            "Executor intent %s acknowledged: %s (%s)",
            ack["intent_id"],
            ack["status"],
            ack["message"],
        )


def _closed_trade_reports(deals, open_position_ids):
    deals_by_position = {}
    for deal in deals:
        try:
            position_id = int(deal.position_id)
        except (AttributeError, TypeError, ValueError, OverflowError):
            continue
        deals_by_position.setdefault(position_id, []).append(deal)

    entry_in = getattr(mt5, "DEAL_ENTRY_IN", 0)
    exit_entries = {
        getattr(mt5, "DEAL_ENTRY_OUT", 1),
        getattr(mt5, "DEAL_ENTRY_OUT_BY", 3),
        getattr(mt5, "DEAL_ENTRY_INOUT", 2),
    }
    reports = []
    for position_id, position_deals in deals_by_position.items():
        if position_id in open_position_ids:
            continue
        openings = [
            deal for deal in position_deals
            if getattr(deal, "entry", None) == entry_in
            and int(getattr(deal, "magic", 0) or 0) == ORDER_MAGIC
            and str(getattr(deal, "comment", "")).startswith("WR:")
        ]
        exits = [
            deal for deal in position_deals
            if getattr(deal, "entry", None) in exit_entries
        ]
        if not openings or not exits:
            continue

        opening = min(openings, key=lambda deal: int(getattr(deal, "time_msc", 0)))
        intent_prefix = str(opening.comment)[3:27]
        if len(intent_prefix) != 24:
            continue
        close_volume = sum(float(getattr(deal, "volume", 0) or 0) for deal in exits)
        if close_volume <= 0:
            continue
        exit_price = sum(
            float(getattr(deal, "price", 0) or 0) *
            float(getattr(deal, "volume", 0) or 0)
            for deal in exits
        ) / close_volume
        pnl = sum(
            sum(float(getattr(deal, field, 0) or 0) for field in (
                "profit", "commission", "swap", "fee"
            ))
            for deal in position_deals
        )
        closed_deal = max(exits, key=lambda deal: int(getattr(deal, "time_msc", 0)))
        closed_at = datetime.fromtimestamp(
            int(closed_deal.time_msc) / 1000,
            timezone.utc,
        ).isoformat()
        reports.append({
            "intent_prefix": intent_prefix,
            "exit_price": exit_price,
            "pnl": pnl,
            "closed_at": closed_at,
            "close_ticket": str(closed_deal.ticket),
        })
    return reports


def send_closed_trade_reports(client: httpx.Client, history_start=None):
    if not EXECUTOR_KEY:
        return
    now = datetime.now(timezone.utc)
    deals = mt5.history_deals_get(
        history_start or now - timedelta(days=365),
        now,
    )
    if deals is None:
        logging.warning("Unable to load MT5 deal history: %s", mt5.last_error())
        return
    positions = mt5.positions_get()
    if positions is None:
        logging.warning("Unable to verify open positions before logging trade exits")
        return
    open_position_ids = {
        int(getattr(position, "identifier", getattr(position, "ticket", 0)))
        for position in positions
    }
    for report in _closed_trade_reports(deals, open_position_ids):
        report_key = (report["intent_prefix"], report["close_ticket"])
        if report_key in REPORTED_CLOSED_TRADES:
            continue
        response = client.post(
            BASE + "/api/v1/bridge/trade-history/close",
            headers=EXECUTOR_HEADERS,
            json=report,
        )
        response.raise_for_status()
        result = response.json()
        if result.get("accepted") is not True:
            raise RuntimeError("Worker did not accept the closed-trade report")
        REPORTED_CLOSED_TRADES.add(report_key)
        logging.info(
            "Closed trade report recorded for intent prefix %s",
            report["intent_prefix"],
        )


def connect():
    ok = mt5.initialize(path=PATH) if PATH else mt5.initialize()
    if not ok:
        raise RuntimeError(f"MT5 init failed: {mt5.last_error()}")
    acc = mt5.account_info()
    if acc is None:
        raise RuntimeError(f"MT5 account_info failed: {mt5.last_error()}")
    if acc.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
        mt5.shutdown()
        raise RuntimeError("Only an MT5 DEMO account is allowed by this telemetry bridge.")
    refresh_symbols()
    return acc


def refresh_symbols():
    instruments = mt5.symbols_get()
    if instruments is None:
        raise RuntimeError(f"MT5 symbols_get failed: {mt5.last_error()}")
    visible = sorted(
        str(instrument.name)
        for instrument in instruments
        if instrument.visible and instrument.name
    )
    if not visible:
        raise RuntimeError("MT5 Market Watch has no visible instruments")
    SYMBOLS[:] = visible
    logging.info("Market Watch instruments loaded: %d", len(SYMBOLS))


class HeartbeatWorker:
    def __init__(self, interval=HEARTBEAT_SECONDS, progress_timeout=90):
        self.interval = interval
        self.progress_timeout = progress_timeout
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._payload = None
        self._last_progress = 0.0
        self._thread = threading.Thread(
            target=self._run,
            name="mt5-heartbeat",
            daemon=True,
        )

    def update_account(self, acc):
        with self._lock:
            self._payload = {
                "terminal_name": "Exness MT5 Windows VPS",
                "account_server": str(acc.server),
                "connected": True,
                "balance": float(acc.balance),
                "equity": float(acc.equity),
                "currency": str(acc.currency),
                "trade_mode": int(acc.trade_mode),
            }
            self._last_progress = time.monotonic()

    def touch(self):
        with self._lock:
            if self._payload is not None:
                self._last_progress = time.monotonic()

    def mark_disconnected(self):
        with self._lock:
            if self._payload is not None:
                self._payload["connected"] = False
            self._last_progress = 0.0

    def heartbeat_payload(self, now=None):
        now = time.monotonic() if now is None else now
        with self._lock:
            if self._payload is None:
                return None
            payload = dict(self._payload)
            payload["connected"] = (
                payload["connected"] and
                now - self._last_progress <= self.progress_timeout
            )
            return payload

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=3)

    def _run(self):
        with httpx.Client(timeout=15) as client:
            while not self._stop.is_set():
                payload = self.heartbeat_payload()
                if payload is not None:
                    try:
                        response = client.post(
                            BASE + "/api/v1/bridge/heartbeat",
                            headers=HEADERS,
                            json=payload,
                        )
                        response.raise_for_status()
                        if payload["connected"]:
                            logging.info("Heartbeat sent")
                        else:
                            logging.warning(
                                "Heartbeat sent as disconnected: MT5 loop made no progress"
                            )
                    except Exception:
                        logging.exception("Background heartbeat send failed")
                if self._stop.wait(self.interval):
                    break


def send_market_batch(client: httpx.Client, heartbeat=None, acc=None):
    ticks = []
    for index, symbol in enumerate(SYMBOLS):
        if heartbeat:
            heartbeat.touch()
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            logging.warning("No tick available for %s (%s)", symbol, mt5.last_error())
            continue
        ticks.append({
            "symbol": symbol,
            "bid": float(tick.bid),
            "ask": float(tick.ask),
            "last": float(tick.last),
            "time": datetime.fromtimestamp(tick.time, timezone.utc).isoformat(),
            "volume": float(tick.volume_real),
        })
    if not ticks:
        logging.warning("No market ticks available; no Queue message sent")
        return
    for offset in range(0, len(ticks), 10):
        response = client.post(
            BASE + "/api/v1/bridge/market-batch",
            headers=HEADERS,
            json={
                "batch_id": str(uuid.uuid4()),
                "ticks": ticks[offset:offset + 10],
            },
        )
        response.raise_for_status()
    logging.info("Market batch accepted: %d symbols", len(ticks))


def send_scanner_candles(client: httpx.Client, heartbeat=None, acc=None):
    captured_at = datetime.now(timezone.utc).isoformat()
    symbols = []
    for index, symbol in enumerate(SYMBOLS):
        if heartbeat:
            heartbeat.touch()
        timeframes = []
        for name, mt5_timeframe in SCANNER_TIMEFRAMES.items():
            rates = mt5.copy_rates_from_pos(
                symbol, mt5_timeframe, 1, SCANNER_CANDLE_COUNT
            )
            if rates is None:
                timeframes.append({
                    "timeframe": name,
                    "available": False,
                    "error": f"MT5 candles unavailable: {mt5.last_error()}",
                    "candles": [],
                })
                continue
            ordered_rates = sorted(
                rates, key=lambda rate: int(rate["time"])
            )[-SCANNER_CANDLE_COUNT:]
            candles = [{
                "time": datetime.fromtimestamp(
                    int(rate["time"]), timezone.utc
                ).isoformat(),
                "open": float(rate["open"]),
                "high": float(rate["high"]),
                "low": float(rate["low"]),
                "close": float(rate["close"]),
                "tick_volume": int(rate["tick_volume"]),
            } for rate in ordered_rates]
            timeframes.append({
                "timeframe": name,
                "available": True,
                "error": None,
                "candles": candles,
            })
        symbols.append({"symbol": symbol, "timeframes": timeframes})

    for offset in range(0, len(symbols), 5):
        response = client.post(
            BASE + "/api/v1/bridge/scanner-candles",
            headers=HEADERS,
            json={
                "captured_at": captured_at,
                "symbols": symbols[offset:offset + 5],
            },
        )
        response.raise_for_status()
    logging.info(
        "Scanner candles accepted: %d symbols across M5/M15/H1/H4",
        len(symbols),
    )


def send_calendar_snapshot(client: httpx.Client):
    payload = read_calendar_snapshot(CALENDAR_FILE)
    response = client.post(
        BASE + "/api/v1/bridge/news-calendar",
        headers=HEADERS,
        json=payload,
    )
    response.raise_for_status()
    logging.info(
        "Calendar snapshot accepted: available=%s events=%d",
        payload["available"],
        len(payload["events"]),
    )


def send_position_snapshot(client: httpx.Client):
    positions = mt5.positions_get()
    if positions is None:
        logging.warning(
            "MT5 positions unavailable; keeping the last snapshot stale (%s)",
            mt5.last_error(),
        )
        return

    items = []
    for position in positions:
        if position.type == mt5.POSITION_TYPE_BUY:
            direction = "BUY"
        elif position.type == mt5.POSITION_TYPE_SELL:
            direction = "SELL"
        else:
            logging.warning("Ignoring unsupported MT5 position type: %s", position.type)
            continue
        items.append({
            "symbol": str(position.symbol),
            "direction": direction,
            "volume": float(position.volume),
        })

    payload = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "positions": items,
    }
    response = client.post(
        BASE + "/api/v1/bridge/positions",
        headers=HEADERS,
        json=payload,
    )
    response.raise_for_status()
    logging.info("Position snapshot accepted: %d positions", len(items))


def _post_sizing_batch(client, captured_at, items, heartbeat=None, acc=None):
    if heartbeat:
        heartbeat.touch()
    response = client.post(
        BASE + "/api/v1/bridge/sizing-inputs",
        headers=HEADERS,
        json={"captured_at": captured_at, "symbols": items},
    )
    if response.status_code != 422:
        response.raise_for_status()
        return sum(1 for item in items if item["available"]), 0, True

    try:
        rejection = response.json()
    except (ValueError, TypeError):
        rejection = {}
    reason = str(rejection.get("error", response.text))[:200]

    if len(items) > 1:
        midpoint = len(items) // 2
        left = _post_sizing_batch(
            client, captured_at, items[:midpoint], heartbeat, acc
        )
        right = _post_sizing_batch(
            client, captured_at, items[midpoint:], heartbeat, acc
        )
        return (
            left[0] + right[0],
            left[1] + right[1],
            left[2] and right[2],
        )

    item = items[0]
    symbol = item["symbol"]
    logging.warning(
        "Sizing data rejected for %s; recording it as unavailable: %s",
        symbol,
        reason,
    )
    unavailable = {
        "symbol": symbol,
        "available": False,
        "error": f"Sizing data rejected by Worker: {reason}"[:200],
        "candles": [],
        "spec": None,
    }
    fallback = client.post(
        BASE + "/api/v1/bridge/sizing-inputs",
        headers=HEADERS,
        json={"captured_at": captured_at, "symbols": [unavailable]},
    )
    if fallback.status_code >= 400:
        logging.error(
            "Unable to store unavailable sizing state for %s: HTTP %d %s",
            symbol,
            fallback.status_code,
            fallback.text[:200],
        )
        return 0, 1, False
    return 0, 1, True


def send_sizing_inputs(client: httpx.Client, heartbeat=None, acc=None):
    captured_at = datetime.now(timezone.utc).isoformat()
    items = []
    for index, symbol in enumerate(SYMBOLS):
        if heartbeat:
            heartbeat.touch()
        info = mt5.symbol_info(symbol)
        rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M1, 1, 29)
        if info is None or rates is None or len(rates) < 29:
            items.append({
                "symbol": symbol,
                "available": False,
                "error": "MT5 symbol info or 29 completed M1 candles unavailable",
                "candles": [],
                "spec": None,
            })
            continue

        ordered_rates = sorted(rates, key=lambda rate: int(rate["time"]))[-29:]
        candles = [{
            "time": datetime.fromtimestamp(
                int(rate["time"]), timezone.utc
            ).isoformat(),
            "high": float(rate["high"]),
            "low": float(rate["low"]),
            "close": float(rate["close"]),
        } for rate in ordered_rates]
        spec = {
            "tick_size": float(info.trade_tick_size),
            "tick_value_loss": float(info.trade_tick_value_loss),
            "contract_size": float(info.trade_contract_size),
            "volume_min": float(info.volume_min),
            "volume_max": float(info.volume_max),
            "volume_step": float(info.volume_step),
        }
        if any(value <= 0 for value in spec.values()):
            items.append({
                "symbol": symbol,
                "available": False,
                "error": "MT5 tick-value or volume constraints unavailable",
                "candles": [],
                "spec": None,
            })
            continue

        items.append({
            "symbol": symbol,
            "available": True,
            "error": None,
            "candles": candles,
            "spec": spec,
        })

    available = 0
    rejected = 0
    safe_to_execute = True
    for offset in range(0, len(items), 10):
        result = _post_sizing_batch(
            client,
            captured_at,
            items[offset:offset + 10],
            heartbeat,
            acc,
        )
        available += result[0]
        rejected += result[1]
        safe_to_execute = safe_to_execute and result[2]
    logging.info(
        "Position sizing inputs accepted: %d available, %d rejected/unavailable of %d symbols",
        available,
        rejected,
        len(items),
    )
    return safe_to_execute


def main():
    global HEARTBEAT_WORKER
    if EXECUTOR_ENABLED and not EXECUTOR_KEY:
        logging.error(
            "Executor remains locked: EXECUTOR_API_KEY is required when MT5_TRADING_ENABLED=true"
        )
    acc = connect()
    logging.info("Connected to DEMO server %s", acc.server)
    HEARTBEAT_WORKER = HeartbeatWorker()
    HEARTBEAT_WORKER.update_account(acc)
    HEARTBEAT_WORKER.start()
    last_market = 0.0
    last_risk_snapshot = 0.0
    last_executor = 0.0
    last_trade_history = 0.0
    sizing_inputs_ok = False

    with httpx.Client(timeout=15) as client:
        while True:
            try:
                acc = mt5.account_info()
                if acc is None:
                    HEARTBEAT_WORKER.mark_disconnected()
                    raise RuntimeError(f"MT5 account unavailable: {mt5.last_error()}")
                if acc.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
                    HEARTBEAT_WORKER.mark_disconnected()
                    raise RuntimeError("Account is no longer DEMO; stopping bridge")
                HEARTBEAT_WORKER.update_account(acc)
                now_mono = time.monotonic()

                if now_mono - last_market >= MARKET_BATCH_SECONDS:
                    send_market_batch(client, HEARTBEAT_WORKER, acc)
                    last_market = time.monotonic()

                if now_mono - last_risk_snapshot >= RISK_SNAPSHOT_SECONDS:
                    refresh_symbols()
                    HEARTBEAT_WORKER.touch()
                    send_calendar_snapshot(client)
                    send_position_snapshot(client)
                    HEARTBEAT_WORKER.touch()
                    sizing_inputs_ok = send_sizing_inputs(
                        client, HEARTBEAT_WORKER, acc
                    )
                    send_scanner_candles(
                        client, HEARTBEAT_WORKER, acc
                    )
                    last_risk_snapshot = time.monotonic()

                if (
                    EXECUTOR_ENABLED
                    and sizing_inputs_ok
                    and now_mono - last_executor >= EXECUTOR_POLL_SECONDS
                ):
                    try:
                        poll_trade_commands(client, acc)
                    except Exception:
                        logging.exception(
                            "Executor poll/ack failed; dispatched intents will not be replayed"
                        )
                    finally:
                        last_executor = now_mono

                if now_mono - last_trade_history >= 60:
                    try:
                        history_window = (
                            timedelta(days=365)
                            if last_trade_history == 0
                            else timedelta(minutes=5)
                        )
                        history_start = datetime.now(timezone.utc) - history_window
                        send_closed_trade_reports(client, history_start)
                    except Exception:
                        logging.exception("Closed-trade logging failed")
                    finally:
                        last_trade_history = now_mono

            except Exception:
                logging.exception("Bridge cycle failed; reconnecting to MT5")
                HEARTBEAT_WORKER.mark_disconnected()
                mt5.shutdown()
                time.sleep(5)
                try:
                    acc = connect()
                    HEARTBEAT_WORKER.update_account(acc)
                except Exception:
                    logging.exception("MT5 reconnect failed")

            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    finally:
        if HEARTBEAT_WORKER is not None:
            HEARTBEAT_WORKER.stop()
        mt5.shutdown()
