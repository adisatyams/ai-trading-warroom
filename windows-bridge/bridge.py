import os
import time
import uuid
import logging
from datetime import datetime, timezone

import httpx
import MetaTrader5 as mt5
from dotenv import load_dotenv

load_dotenv(".env.windows")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

BASE = os.environ["WARROOM_API_URL"].rstrip("/")
KEY = os.environ["WARROOM_API_KEY"]
PATH = os.getenv("MT5_PATH", "")
SYMBOLS = [s.strip() for s in os.getenv("SYMBOLS", "EURUSD,GBPUSD,XAUUSD").split(",") if s.strip()]
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "5"))
HEARTBEAT_SECONDS = int(os.getenv("HEARTBEAT_SECONDS", "60"))
MARKET_BATCH_SECONDS = int(os.getenv("MARKET_BATCH_SECONDS", "60"))
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


def main():
    acc = connect()
    logging.info("Connected to DEMO server %s", acc.server)
    last_heartbeat = 0.0
    last_market = 0.0

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
