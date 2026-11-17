import os, time, logging
from datetime import datetime, timezone
import httpx
import MetaTrader5 as mt5
from dotenv import load_dotenv

load_dotenv(".env.windows")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
BASE = os.environ["WARROOM_API_URL"].rstrip("/")
KEY = os.environ["WARROOM_API_KEY"]
PATH = os.getenv("MT5_PATH", "")
SYMBOLS = [x.strip() for x in os.getenv("SYMBOLS", "XAUUSD,EURUSD").split(",") if x.strip()]
POLL = int(os.getenv("POLL_SECONDS", "5"))
HEADERS = {"x-api-key": KEY}

def connect():
    ok = mt5.initialize(path=PATH) if PATH else mt5.initialize()
    if not ok: raise RuntimeError(f"MT5 init failed: {mt5.last_error()}")
    acc = mt5.account_info()
    if acc is None: raise RuntimeError(f"MT5 account_info failed: {mt5.last_error()}")
    if acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL:
        raise RuntimeError("REAL account detected. Phase 1 telemetry bridge refuses live accounts.")
    for s in SYMBOLS:
        if not mt5.symbol_select(s, True):
            logging.warning("Symbol unavailable: %s (%s)", s, mt5.last_error())
    return acc

def main():
    acc = connect()
    logging.info("Connected to %s, account %s", acc.server, acc.login)
    with httpx.Client(timeout=10) as client:
        while True:
            try:
                acc = mt5.account_info()
                if acc is None: raise RuntimeError("MT5 account unavailable")
                if acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL:
                    raise RuntimeError("REAL account detected; stopping bridge")
                client.post(BASE+"/api/v1/bridge/heartbeat", headers=HEADERS, json={
                    "terminal_name":"Exness MT5 Windows VPS", "account_server":str(acc.server),
                    "account_login":str(acc.login), "connected":True,
                    "balance":float(acc.balance), "equity":float(acc.equity),
                    "currency":str(acc.currency), "trade_mode":int(acc.trade_mode)
                }).raise_for_status()
                for symbol in SYMBOLS:
                    tick=mt5.symbol_info_tick(symbol)
                    if tick is None: continue
                    client.post(BASE+"/api/v1/bridge/market-snapshot",headers=HEADERS,json={
                        "symbol":symbol,"bid":float(tick.bid),"ask":float(tick.ask),
                        "last":float(tick.last),"time":datetime.fromtimestamp(tick.time,timezone.utc).isoformat(),
                        "volume":float(tick.volume_real)
                    }).raise_for_status()
                logging.info("Telemetry sent for %d symbols",len(SYMBOLS))
            except Exception:
                logging.exception("Bridge cycle failed")
                mt5.shutdown()
                time.sleep(5)
                try: connect()
                except Exception: logging.exception("MT5 reconnect failed")
            time.sleep(POLL)

if __name__=="__main__":
    try: main()
    finally: mt5.shutdown()
