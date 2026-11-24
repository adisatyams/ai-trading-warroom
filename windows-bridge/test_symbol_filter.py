import unittest

from symbol_filter import parse_symbol_config, resolve_symbols


class ParseSymbolConfigTests(unittest.TestCase):
    def test_parses_commas_spaces_and_case(self):
        self.assertEqual(
            parse_symbol_config(" xauusd, EURUSD ;gbpusd  USDJPY,,eurusd"),
            ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"],
        )

    def test_empty_values(self):
        self.assertEqual(parse_symbol_config(""), [])
        self.assertEqual(parse_symbol_config(None), [])
        self.assertEqual(parse_symbol_config(" , ; "), [])


class ResolveSymbolsTests(unittest.TestCase):
    available = [
        "EURUSDm", "GBPUSDm", "USDJPYm", "XAUUSDm", "XAUUSDmicro",
        "EURUSDmini2", "AAPLm", "BTCUSDm",
    ]

    def test_maps_base_names_to_broker_suffix(self):
        resolved, missing = resolve_symbols(
            ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"], self.available
        )
        self.assertEqual(resolved, ["XAUUSDm", "EURUSDm", "GBPUSDm", "USDJPYm"])
        self.assertEqual(missing, [])

    def test_prefers_exact_match(self):
        resolved, _ = resolve_symbols(["EURUSD"], ["EURUSDm", "EURUSD"])
        self.assertEqual(resolved, ["EURUSD"])

    def test_reports_missing_and_ignores_unrelated(self):
        resolved, missing = resolve_symbols(["EURUSD", "NZDCAD"], self.available)
        self.assertEqual(resolved, ["EURUSDm"])
        self.assertEqual(missing, ["NZDCAD"])

    def test_long_suffixes_are_not_matched(self):
        # EURUSDmini2 has a 5-character suffix, so it is not a suffix variant.
        resolved, missing = resolve_symbols(["EURUSD"], ["EURUSDmini2"])
        self.assertEqual(resolved, [])
        self.assertEqual(missing, ["EURUSD"])

    def test_one_symbol_per_configured_name(self):
        resolved, _ = resolve_symbols(["XAUUSD"], ["XAUUSDz", "XAUUSDm", "XAUUSDc"])
        self.assertEqual(resolved, ["XAUUSDc"])


if __name__ == "__main__":
    unittest.main()
