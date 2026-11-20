import json
import os
import tempfile
import unittest
from datetime import datetime, timezone

from calendar_feed import read_calendar_snapshot


class CalendarFeedTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, "calendar.json")

    def tearDown(self):
        self.temp.cleanup()

    def write(self, payload):
        with open(self.path, "w", encoding="utf-8") as file:
            json.dump(payload, file)
        os.utime(self.path, (self.now.timestamp(), self.now.timestamp()))

    def test_reads_fresh_high_impact_events(self):
        self.write({
            "generated_at": self.now.isoformat(),
            "available": True,
            "events": [{
                "event_id": "42",
                "name": "Policy decision",
                "currency": "usd",
                "importance": "HIGH",
                "scheduled_at": self.now.isoformat(),
            }],
        })
        result = read_calendar_snapshot(self.path, self.now)
        self.assertTrue(result["available"])
        self.assertEqual(result["events"][0]["currency"], "USD")

    def test_missing_stale_or_invalid_export_fails_closed(self):
        self.assertFalse(read_calendar_snapshot("", self.now)["available"])
        self.write({"available": True, "events": []})
        os.utime(self.path, (self.now.timestamp() - 151, self.now.timestamp() - 151))
        self.assertFalse(read_calendar_snapshot(self.path, self.now)["available"])

        self.write({"available": True, "generated_at": "bad", "events": []})
        self.assertFalse(read_calendar_snapshot(self.path, self.now)["available"])

        self.write({
            "available": True,
            "generated_at": "2026-11-20T11:57:29+00:00",
            "events": [],
        })
        self.assertFalse(read_calendar_snapshot(self.path, self.now)["available"])

    def test_unavailable_calendar_never_returns_events(self):
        self.write({
            "generated_at": self.now.isoformat(),
            "available": False,
            "error": "calendar feed unavailable",
            "events": [],
        })
        result = read_calendar_snapshot(self.path, self.now)
        self.assertFalse(result["available"])
        self.assertEqual(result["events"], [])


if __name__ == "__main__":
    unittest.main()
