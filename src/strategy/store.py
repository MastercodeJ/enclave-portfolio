"""Persist strategies as JSON.

A strategy has to outlive the conversation that created it: when a scheduled
rebalance fires with nobody watching, there is no chat context to re-read.
Decimals are stored as strings so weights survive the round trip exactly.
"""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from src.strategy.errors import StrategyError
from src.strategy.models import Cadence, Strategy

DEFAULT_STORE_DIR = Path("strategies")


def to_dict(strategy: Strategy) -> dict:
    """JSON-safe representation. Decimals become strings, never floats."""
    return {
        "targets": {tid: str(w) for tid, w in strategy.targets.items()},
        "symbols": dict(strategy.symbols),
        "driftThresholdPct": str(strategy.drift_threshold_pct),
        "maxTradePct": str(strategy.max_trade_pct),
        "maxPriceImpactPct": str(strategy.max_price_impact_pct),
        "cadence": strategy.cadence.value,
        "sourcePrompt": strategy.source_prompt,
        "createdAt": strategy.created_at.isoformat(),
        "notes": strategy.notes,
    }


def from_dict(payload: dict) -> Strategy:
    """Rebuild a Strategy, restoring exact Decimal weights."""
    try:
        return Strategy(
            targets={tid: Decimal(w) for tid, w in payload["targets"].items()},
            symbols=dict(payload.get("symbols") or {}),
            source_prompt=payload.get("sourcePrompt", ""),
            created_at=datetime.fromisoformat(payload["createdAt"]),
            drift_threshold_pct=Decimal(payload["driftThresholdPct"]),
            max_trade_pct=Decimal(payload["maxTradePct"]),
            max_price_impact_pct=Decimal(payload["maxPriceImpactPct"]),
            cadence=Cadence(payload.get("cadence", "manual")),
            notes=payload.get("notes"),
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise StrategyError(f"Stored strategy is malformed: {exc}") from exc


def save_strategy(
    strategy: Strategy, name: str = "default", directory: Path | None = None
) -> Path:
    """Write a strategy to `<directory>/<name>.json`, returning the path."""
    target_dir = directory or DEFAULT_STORE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{name}.json"
    path.write_text(json.dumps(to_dict(strategy), indent=2) + "\n")
    return path


def load_strategy(name: str = "default", directory: Path | None = None) -> Strategy:
    """Read a stored strategy.

    Raises:
        StrategyError: no such strategy, or the file is malformed.
    """
    path = (directory or DEFAULT_STORE_DIR) / f"{name}.json"
    if not path.exists():
        raise StrategyError(f"No stored strategy named {name!r} at {path}")
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise StrategyError(f"Stored strategy {path} is not valid JSON: {exc}") from exc
    return from_dict(payload)


def list_strategies(directory: Path | None = None) -> list[str]:
    """Names of every stored strategy."""
    target_dir = directory or DEFAULT_STORE_DIR
    if not target_dir.exists():
        return []
    return sorted(p.stem for p in target_dir.glob("*.json"))
