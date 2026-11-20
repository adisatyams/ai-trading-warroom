import json
import os
from datetime import datetime, timezone


def _utc_iso(now=None):
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()


def _unavailable(error, now=None):
    return {
        "generated_at": _utc_iso(now),
        "available": False,
        "error": error,
        "events": [],
    }


def _parse_utc(value):
    if not isinstance(value, str) or not value:
        raise ValueError("generated_at must be an ISO timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("generated_at must include a timezone")
    return parsed.astimezone(timezone.utc)


def read_calendar_snapshot(file_path, now=None, max_age_seconds=150):
    if not file_path:
        return _unavailable("MT5_CALENDAR_FILE is not configured", now)
    file_path = os.path.expandvars(file_path)

    try:
        stat = os.stat(file_path)
        current = now or datetime.now(timezone.utc)
        age_seconds = current.timestamp() - stat.st_mtime
        if age_seconds < 0 or age_seconds > max_age_seconds:
            return _unavailable("MT5 calendar export file is stale", now)

        with open(file_path, "r", encoding="utf-8-sig") as file:
            source = json.load(file)
        generated_at = source.get("generated_at")
        generated_time = _parse_utc(generated_at)
        source_age = (current - generated_time).total_seconds()
        if source_age < 0 or source_age > max_age_seconds:
            return _unavailable("MT5 calendar snapshot timestamp is stale", now)
        if source.get("available") is not True:
            return _unavailable(
                source.get("error") or "MT5 calendar export is unavailable",
                now,
            )

        events = source.get("events")
        if not isinstance(events, list) or len(events) > 500:
            raise ValueError("events must be an array of at most 500 entries")

        normalized_events = []
        for event in events:
            if not isinstance(event, dict):
                raise ValueError("calendar event must be an object")
            event_id = str(event.get("event_id", ""))
            name = event.get("name")
            currency = event.get("currency")
            scheduled_at = event.get("scheduled_at")
            _parse_utc(scheduled_at)
            if (
                not event_id
                or len(event_id) > 64
                or not isinstance(name, str)
                or not name
                or len(name) > 200
                or not isinstance(currency, str)
                or len(currency) != 3
                or not currency.isalpha()
                or event.get("importance") != "HIGH"
            ):
                raise ValueError("invalid high-impact calendar event")
            normalized_events.append({
                "event_id": event_id,
                "name": name,
                "currency": currency.upper(),
                "importance": "HIGH",
                "scheduled_at": scheduled_at,
            })

        return {
            "generated_at": generated_at,
            "available": True,
            "error": None,
            "events": normalized_events,
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        return _unavailable(f"Invalid or unavailable MT5 calendar export: {error}", now)
