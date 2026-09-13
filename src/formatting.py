"""Decimal formatting for display.

Working precision is deliberately high across this codebase -- sqrtRatioX96
maths needs 60 digits -- which makes raw values unreadable in logs, demos and
LLM-facing summaries. These helpers are for presentation only; never feed their
output back into arithmetic.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation


def trim_decimal(value: Decimal, places: int = 6) -> Decimal:
    """Round to `places` and drop trailing zeros, without scientific notation.

    `Decimal.normalize()` alone renders whole numbers as exponents
    (10 -> 1E+1), so integral results are re-quantized.
    """
    quantum = Decimal(1).scaleb(-places)
    try:
        trimmed = value.quantize(quantum).normalize()
    except InvalidOperation:
        # quantize() overflows when the result would exceed context precision,
        # which a junk token's absurd price can trigger. Callers are display
        # paths, so raising here would blow up a log line.
        return value
    if trimmed == trimmed.to_integral_value():
        return trimmed.quantize(Decimal(1))
    return trimmed


def format_pct(value: Decimal, places: int = 2) -> str:
    """Render a percentage without trailing zeros: 20, 5.5, 0.05.

    A small non-zero value keeps enough places to stay visible. Rounding
    0.001 to "0" would make an out-of-range error read as nonsense.
    """
    trimmed = trim_decimal(value, places)
    if trimmed == 0 and value != 0:
        trimmed = trim_decimal(value, 8)
    return f"{trimmed}"
