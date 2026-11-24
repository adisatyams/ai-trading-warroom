"""Pick which MT5 instruments the bridge reports, from the SYMBOLS setting.

Pure functions (no MetaTrader5 import) so they can be unit tested anywhere.
"""

# Brokers such as Exness append a short suffix to base names (EURUSD -> EURUSDm).
MAX_BROKER_SUFFIX_LENGTH = 3


def parse_symbol_config(raw):
    """Parse 'XAUUSD, eurusd;GBPUSD' into ['XAUUSD', 'EURUSD', 'GBPUSD'].

    Returns an empty list when nothing is configured.
    """
    if not raw:
        return []
    cleaned = raw.replace(";", ",").replace("\n", ",").replace(" ", ",")
    seen = []
    for part in cleaned.split(","):
        base = part.strip().upper()
        if base and base not in seen:
            seen.append(base)
    return seen


def resolve_symbols(wanted, available):
    """Map configured base names to the broker's actual symbol names.

    An exact (case-insensitive) match wins. Otherwise the shortest broker
    symbol that is the base plus a short suffix is used, so EURUSD resolves to
    EURUSDm. One broker symbol is chosen per configured name.

    Returns (resolved_symbols, missing_names).
    """
    resolved = []
    missing = []
    names = sorted(set(available))
    for base in wanted:
        exact = [name for name in names if name.upper() == base]
        if exact:
            choice = exact[0]
        else:
            candidates = [
                name
                for name in names
                if name.upper().startswith(base)
                and 0 < len(name) - len(base) <= MAX_BROKER_SUFFIX_LENGTH
            ]
            choice = min(candidates, key=lambda name: (len(name), name)) if candidates else None
        if choice is None:
            missing.append(base)
        elif choice not in resolved:
            resolved.append(choice)
    return resolved, missing
