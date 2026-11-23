import importlib
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch


os.environ.setdefault("WARROOM_API_URL", "https://example.invalid")
os.environ.setdefault("WARROOM_API_KEY", "test")

fake_mt5 = types.ModuleType("MetaTrader5")
for name, value in {
    "ACCOUNT_TRADE_MODE_DEMO": 0,
    "SYMBOL_TRADE_MODE_DISABLED": 0,
    "SYMBOL_TRADE_MODE_LONGONLY": 1,
    "SYMBOL_TRADE_MODE_SHORTONLY": 2,
    "SYMBOL_TRADE_MODE_CLOSEONLY": 3,
    "SYMBOL_FILLING_FOK": 1,
    "SYMBOL_FILLING_IOC": 2,
    "ORDER_FILLING_FOK": 0,
    "ORDER_FILLING_IOC": 1,
    "TRADE_ACTION_DEAL": 1,
    "ORDER_TYPE_BUY": 0,
    "ORDER_TYPE_SELL": 1,
    "ORDER_TIME_GTC": 0,
    "TRADE_RETCODE_DONE": 10009,
    "TRADE_RETCODE_DONE_PARTIAL": 10010,
    "TRADE_RETCODE_PLACED": 10008,
    "DEAL_ENTRY_IN": 0,
    "DEAL_ENTRY_OUT": 1,
    "DEAL_ENTRY_INOUT": 2,
    "DEAL_ENTRY_OUT_BY": 3,
    "TIMEFRAME_M5": 5,
    "TIMEFRAME_M15": 15,
    "TIMEFRAME_H1": 60,
    "TIMEFRAME_H4": 240,
}.items():
    setattr(fake_mt5, name, value)
sys.modules["MetaTrader5"] = fake_mt5

fake_dotenv = types.ModuleType("dotenv")
fake_dotenv.load_dotenv = lambda _path: None
sys.modules["dotenv"] = fake_dotenv

fake_httpx = types.ModuleType("httpx")
fake_httpx.Client = object
sys.modules["httpx"] = fake_httpx

bridge = importlib.import_module("bridge")


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        bridge.EXECUTOR_ENABLED = True
        bridge.SYMBOLS[:] = ["EURUSD"]
        fake_mt5.symbol_select = lambda _symbol, _select: True
        fake_mt5.symbol_info = lambda _symbol: SimpleNamespace(
            trade_mode=4,
            filling_mode=1,
            trade_tick_size=0.0001,
            trade_tick_value_loss=1.0,
            point=0.00001,
            volume_min=0.01,
            volume_max=100.0,
            volume_step=0.01,
            digits=5,
        )
        fake_mt5.symbol_info_tick = lambda _symbol: SimpleNamespace(
            bid=1.1000,
            ask=1.1001,
        )
        fake_mt5.positions_get = lambda: []
        fake_mt5.order_check = lambda _request: SimpleNamespace(
            retcode=0,
            comment="Done",
        )
        fake_mt5.order_send = self.order_send
        fake_mt5.last_error = lambda: (0, "OK")
        self.account = SimpleNamespace(
            trade_mode=fake_mt5.ACCOUNT_TRADE_MODE_DEMO,
            equity=10_000.0,
        )

    def order_send(self, request):
        self.requests.append(request)
        return SimpleNamespace(
            retcode=fake_mt5.TRADE_RETCODE_DONE,
            deal=12345,
            order=12345,
            volume=request["volume"],
            price=request["price"],
            comment="Done",
        )

    def command(self, **overrides):
        payload = {
            "intent_id": "intent-123",
            "symbol": "EURUSD",
            "direction": "BUY",
            "volume": 0.1,
            "stop_loss": 1.0991,
            "take_profit": 1.1021,
            "risk_budget": 25.0,
            "risk_pct_limit": 0.25,
            "max_spread_bps": 2.0,
            "max_open_positions": 3,
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=60)
            ).isoformat(),
        }
        payload.update(overrides)
        return payload

    def test_heartbeat_worker_reports_stale_main_loop_as_disconnected(self):
        account = SimpleNamespace(
            server="demo",
            balance=1000.0,
            equity=1000.0,
            currency="USD",
            trade_mode=fake_mt5.ACCOUNT_TRADE_MODE_DEMO,
        )
        worker = bridge.HeartbeatWorker(interval=30, progress_timeout=90)
        with patch("bridge.time.monotonic", return_value=100.0):
            worker.update_account(account)
        self.assertTrue(worker.heartbeat_payload(now=190.0)["connected"])
        self.assertFalse(worker.heartbeat_payload(now=190.1)["connected"])
        with patch("bridge.time.monotonic", return_value=200.0):
            worker.touch()
        self.assertTrue(worker.heartbeat_payload(now=250.0)["connected"])
        worker.mark_disconnected()
        self.assertFalse(worker.heartbeat_payload(now=250.0)["connected"])

    def test_sizing_422_isolates_bad_symbol_and_records_it_unavailable(self):
        class Response:
            def __init__(self, status_code, body):
                self.status_code = status_code
                self.body = body
                self.text = str(body)

            def json(self):
                return self.body

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise AssertionError(f"Unexpected HTTP {self.status_code}")

        class Client:
            def __init__(self):
                self.payloads = []

            def post(self, _url, headers, json):
                self.payloads.append(json)
                symbols = json["symbols"]
                if any(
                    item["symbol"] == "BROKEN" and item["available"]
                    for item in symbols
                ):
                    return Response(422, {
                        "error": "Invalid M1 candle",
                        "symbol": "BROKEN",
                    })
                return Response(200, {"accepted": True})

        client = Client()
        items = [
            {
                "symbol": symbol,
                "available": True,
                "error": None,
                "candles": [{"time": "bad"}],
                "spec": {},
            }
            for symbol in ("GOOD", "BROKEN")
        ]
        available, rejected, safe = bridge._post_sizing_batch(
            client,
            "2026-11-23T03:00:00Z",
            items,
        )

        self.assertEqual((available, rejected, safe), (1, 1, True))
        fallback = client.payloads[-1]["symbols"][0]
        self.assertEqual(fallback["symbol"], "BROKEN")
        self.assertFalse(fallback["available"])
        self.assertEqual(fallback["candles"], [])
        self.assertIsNone(fallback["spec"])

    def test_sizing_fallback_failure_marks_cycle_unsafe_without_raising(self):
        class Response:
            status_code = 422
            text = "invalid candle"

            def json(self):
                return {"error": "Invalid M1 candle"}

            def raise_for_status(self):
                raise AssertionError("422 should be handled without raising")

        class Client:
            def post(self, _url, headers, json):
                return Response()

        item = {
            "symbol": "BROKEN",
            "available": True,
            "error": None,
            "candles": [{"time": "bad"}],
            "spec": {},
        }
        available, rejected, safe = bridge._post_sizing_batch(
            Client(),
            "2026-11-23T03:00:00Z",
            [item],
        )
        self.assertEqual((available, rejected, safe), (0, 1, False))

    def test_sends_demo_market_order_at_current_broker_price(self):
        ack = bridge._execute_trade_command(self.command(), self.account)
        self.assertEqual(ack["status"], "EXECUTED")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0]["price"], 1.1001)
        self.assertEqual(self.requests[0]["sl"], 1.0991)
        self.assertEqual(self.requests[0]["tp"], 1.1021)

    def test_refuses_live_account_and_closed_trading_gate(self):
        live = SimpleNamespace(trade_mode=1, equity=10_000.0)
        self.assertEqual(
            bridge._execute_trade_command(self.command(), live)["status"],
            "REJECTED",
        )
        bridge.EXECUTOR_ENABLED = False
        self.assertEqual(
            bridge._execute_trade_command(self.command(), self.account)["status"],
            "REJECTED",
        )
        self.assertEqual(self.requests, [])

    def test_worst_fill_includes_slippage_in_risk_budget(self):
        ack = bridge._execute_trade_command(
            self.command(
                volume=1.0,
                stop_loss=1.0998,
                risk_budget=3.5,
            ),
            self.account,
        )
        self.assertEqual(ack["status"], "REJECTED")
        self.assertEqual(self.requests, [])

    def test_refuses_existing_positions_and_risk_overrun(self):
        fake_mt5.positions_get = lambda: [SimpleNamespace(symbol="EURUSD")]
        self.assertEqual(
            bridge._execute_trade_command(self.command(), self.account)["status"],
            "REJECTED",
        )
        fake_mt5.positions_get = lambda: [
            SimpleNamespace(symbol="GBPUSD"),
            SimpleNamespace(symbol="USDJPY"),
            SimpleNamespace(symbol="XAUUSD"),
        ]
        self.assertEqual(
            bridge._execute_trade_command(self.command(), self.account)["status"],
            "REJECTED",
        )
        fake_mt5.positions_get = lambda: []
        self.assertEqual(
            bridge._execute_trade_command(
                self.command(risk_budget=0.01),
                self.account,
            )["status"],
            "REJECTED",
        )
        self.assertEqual(self.requests, [])

    def test_closed_trade_report_aggregates_exit_price_and_realized_pnl(self):
        opened_at = int(datetime.now(timezone.utc).timestamp() * 1000) - 60_000
        closed_at = opened_at + 30_000
        deals = [
            SimpleNamespace(
                position_id=12345,
                entry=fake_mt5.DEAL_ENTRY_IN,
                magic=bridge.ORDER_MAGIC,
                comment="WR:0123456789abcdef01234567",
                time_msc=opened_at,
                volume=0.1,
                price=1.1001,
                profit=0,
                commission=-0.5,
                swap=0,
                fee=0,
                ticket=1,
            ),
            SimpleNamespace(
                position_id=12345,
                entry=fake_mt5.DEAL_ENTRY_OUT,
                magic=bridge.ORDER_MAGIC,
                comment="tp",
                time_msc=closed_at,
                volume=0.1,
                price=1.102,
                profit=19,
                commission=-0.5,
                swap=0,
                fee=0,
                ticket=2,
            ),
        ]
        reports = bridge._closed_trade_reports(deals, set())
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["intent_prefix"], "0123456789abcdef01234567")
        self.assertEqual(reports[0]["exit_price"], 1.102)
        self.assertEqual(reports[0]["pnl"], 18)
        self.assertEqual(reports[0]["close_ticket"], "2")

    def test_closed_trade_report_waits_until_position_is_closed(self):
        opened = SimpleNamespace(
            position_id=12345,
            entry=fake_mt5.DEAL_ENTRY_IN,
            magic=bridge.ORDER_MAGIC,
            comment="WR:0123456789abcdef01234567",
            time_msc=1,
            volume=0.1,
            price=1.1,
            profit=0,
            commission=0,
            swap=0,
            fee=0,
            ticket=1,
        )
        closed = SimpleNamespace(
            **{
                **opened.__dict__,
                "entry": fake_mt5.DEAL_ENTRY_OUT,
                "comment": "tp",
            }
        )
        self.assertEqual(
            bridge._closed_trade_reports([opened, closed], {12345}),
            [],
        )


if __name__ == "__main__":
    unittest.main()
