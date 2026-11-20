import os
import time
import uuid
import logging
from datetime import datetime, timezone

import httpx
import MetaTrader5 as mt5
from dotenv import load_dotenv
from calendar_feed import read_calendar_snapshot

load_dotenv(".env.windows")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

BASE = os.environ["WARROOM_API_URL"].rstrip("/")
KEY = os.environ["WARROOM_API_KEY"]
PATH = os.getenv("MT5_PATH", "")
DEFAULT_SYMBOLS = "XAUUSDm,EURUSDm,GBPUSDm,USDJPYm,AUDUSDm,USDCADm,BTCUSDm,ETHUSDm"
SYMBOLS = [
    symbol.strip()
    for symbol in os.getenv("SYMBOLS", DEFAULT_SYMBOLS).split(",")
    if symbol.strip()
]
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "5"))
HEARTBEAT_SECONDS = int(os.getenv("HEARTBEAT_SECONDS", "60"))
MARKET_BATCH_SECONDS = int(os.getenv("MARKET_BATCH_SECONDS", "60"))
RISK_SNAPSHOT_SECONDS = int(os.getenv("RISK_SNAPSHOT_SECONDS", "60"))
CALENDAR_FILE = os.getenv("MT5_CALENDAR_FILE", "")
HEADERS = {"x-api-key": KEY}


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
    for symbol in SYMBOLS:
        if not mt5.symbol_select(symbol, True):
            logging.warning("Symbol unavailable: %s (%s)", symbol, mt5.last_error())
    return acc


def send_heartbeat(client: httpx.Client, acc):
    payload = {
        "terminal_name": "Exness MT5 Windows VPS",
        "account_server": str(acc.server),
        # Account login is intentionally not transmitted or stored by the bridge.
        "connected": True,
        "balance": float(acc.balance),
        "equity": float(acc.equity),
        "currency": str(acc.currency),
        "trade_mode": int(acc.trade_mode),
    }
    response = client.post(BASE + "/api/v1/bridge/heartbeat", headers=HEADERS, json=payload)
    response.raise_for_status()


def send_market_batch(client: httpx.Client):
    ticks = []
    for symbol in SYMBOLS:
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
    response = client.post(BASE + "/api/v1/bridge/market-batch", headers=HEADERS, json={
        "batch_id": str(uuid.uuid4()),
        "ticks": ticks,
    })
    response.raise_for_status()
    logging.info("Market batch accepted: %d symbols", len(ticks))


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


def send_sizing_inputs(client: httpx.Client):
    captured_at = datetime.now(timezone.utc).isoformat()
    items = []
    for symbol in SYMBOLS:
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

    response = client.post(
        BASE + "/api/v1/bridge/sizing-inputs",
        headers=HEADERS,
        json={"captured_at": captured_at, "symbols": items},
    )
    response.raise_for_status()
    available = sum(1 for item in items if item["available"])
    logging.info(
        "Position sizing inputs accepted: %d/%d symbols available",
        available,
        len(items),
    )


def main():
    acc = connect()
    logging.info("Connected to DEMO server %s", acc.server)
    last_heartbeat = 0.0
    last_market = 0.0
    last_risk_snapshot = 0.0

    with httpx.Client(timeout=15) as client:
        while True:
            try:
                acc = mt5.account_info()
                if acc is None:
                    raise RuntimeError(f"MT5 account unavailable: {mt5.last_error()}")
                if acc.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
                    raise RuntimeError("Account is no longer DEMO; stopping bridge")

                now_mono = time.monotonic()
                if now_mono - last_heartbeat >= HEARTBEAT_SECONDS:
                    send_heartbeat(client, acc)
                    last_heartbeat = now_mono
                    logging.info("Heartbeat sent")

                if now_mono - last_market >= MARKET_BATCH_SECONDS:
                    send_market_batch(client)
                    last_market = now_mono

                if now_mono - last_risk_snapshot >= RISK_SNAPSHOT_SECONDS:
                    send_calendar_snapshot(client)
                    send_position_snapshot(client)
                    send_sizing_inputs(client)
                    last_risk_snapshot = now_mono

            except Exception:
                logging.exception("Bridge cycle failed; reconnecting to MT5")
                mt5.shutdown()
                time.sleep(5)
                try:
                    connect()
                except Exception:
                    logging.exception("MT5 reconnect failed")

            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    finally:
        mt5.shutdown()
