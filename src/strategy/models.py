"""Strategy models.

Two shapes, deliberately kept apart:

* `StrategyDraft` is what a language model emits. It speaks the user's
  language -- symbols and percentages -- and is never trusted.
* `Strategy` is what survives validation. Token ids, Decimal weights summing
  to exactly 1, limits within sane bounds. Only this may reach an execution
  path.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field

from src.formatting import format_pct

# Applied only where the user said nothing. Stated values always win.
DEFAULT_DRIFT_THRESHOLD_PCT = Decimal("5")
DEFAULT_MAX_TRADE_PCT = Decimal("20")
DEFAULT_MAX_PRICE_IMPACT_PCT = Decimal("1")

# Bounds for stated limits. Outside these a strategy is more likely a
# misparse than an intention -- a 0.001% drift threshold would rebalance
# continuously and a 90% single trade would move the market against itself.
DRIFT_RANGE = (Decimal("0.1"), Decimal("50"))
MAX_TRADE_RANGE = (Decimal("1"), Decimal("100"))
PRICE_IMPACT_RANGE = (Decimal("0.01"), Decimal("10"))

# Allocations must sum to exactly 100%. The tolerance absorbs float noise from
# the model's JSON, not genuine arithmetic slack: "33/33/33" is rejected so the
# user can be told the total, rather than having their intent quietly rescaled.
WEIGHT_SUM_TOLERANCE = Decimal("0.01")


class Cadence(str, Enum):
    """How often the user wants the portfolio brought back to target."""

    MANUAL = "manual"
    HOURLY = "hourly"
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"

    @classmethod
    def parse(cls, raw: str | None) -> "Cadence":
        """Best-effort mapping of a model's phrasing onto the enum.

        Unrecognised cadences fall back to MANUAL rather than failing the whole
        strategy: an unclear schedule should not block an otherwise valid
        allocation, and manual is the conservative reading.
        """
        if not raw:
            return cls.MANUAL
        text = raw.strip().lower()
        for member in cls:
            if member.value in text:
                return member
        if "day" in text:
            return cls.DAILY
        if "week" in text:
            return cls.WEEKLY
        if "month" in text:
            return cls.MONTHLY
        if "hour" in text:
            return cls.HOURLY
        return cls.MANUAL


class Allocation(BaseModel):
    """One line of a requested allocation, in the user's own terms."""

    symbol: str = Field(
        ...,
        description=(
            "Ticker symbol of the token, exactly as the user said it "
            "(for example 'HBAR', 'USDC', 'SAUCE'). Never a token id."
        ),
    )
    percent: float = Field(
        ...,
        description=(
            "Share of the total portfolio for this token, as a percentage "
            "between 0 and 100. All allocations together must total 100."
        ),
    )


class StrategyDraft(BaseModel):
    """Untrusted model output.

    Field descriptions are verbose because they are what the language model
    reads: the schema is the prompt.
    """

    allocations: list[Allocation] = Field(
        default_factory=list,
        description=(
            "The target portfolio mix. One entry per token, with percentages "
            "totalling exactly 100."
        ),
    )
    drift_threshold_pct: float | None = Field(
        None,
        description=(
            "How far the portfolio may drift from target, in percentage "
            "points, before a rebalance is warranted. Only set this if the "
            "user stated it; otherwise leave null."
        ),
    )
    max_trade_pct: float | None = Field(
        None,
        description=(
            "Largest share of the portfolio that may be traded in one swap, "
            "as a percentage. Only set this if the user stated it."
        ),
    )
    max_price_impact_pct: float | None = Field(
        None,
        description=(
            "Largest acceptable price impact on a single swap, as a "
            "percentage. Only set this if the user stated it."
        ),
    )
    rebalance_cadence: str | None = Field(
        None,
        description=(
            "How often to rebalance: 'manual', 'hourly', 'daily', 'weekly' or "
            "'monthly'. Only set this if the user stated it."
        ),
    )
    notes: str | None = Field(
        None,
        description=(
            "Anything the user asked for that does not fit the fields above. "
            "Recorded but not acted upon."
        ),
    )


@dataclass(frozen=True)
class StrategyProblem:
    """One specific reason a draft was rejected.

    Structured rather than a bare string so a repair prompt can point the
    model at the exact field, and so the UI can highlight it.
    """

    field: str
    reason: str
    suggestion: str | None = None

    def __str__(self) -> str:
        text = f"{self.field}: {self.reason}"
        if self.suggestion:
            text += f" ({self.suggestion})"
        return text


@dataclass(frozen=True)
class Strategy:
    """A validated, executable target allocation.

    Weights are keyed by token id, never symbol. `source_prompt` is retained
    so that a rebalance logged to HCS can cite the instruction it came from.
    """

    targets: dict[str, Decimal]
    symbols: dict[str, str]
    source_prompt: str
    created_at: datetime
    drift_threshold_pct: Decimal = DEFAULT_DRIFT_THRESHOLD_PCT
    max_trade_pct: Decimal = DEFAULT_MAX_TRADE_PCT
    max_price_impact_pct: Decimal = DEFAULT_MAX_PRICE_IMPACT_PCT
    cadence: Cadence = Cadence.MANUAL
    notes: str | None = None

    def weight(self, token_id: str) -> Decimal:
        """Target weight for a token, or zero if it is not in the strategy."""
        return self.targets.get(token_id, Decimal(0))

    def symbol_for(self, token_id: str) -> str:
        return self.symbols.get(token_id, token_id)

    @property
    def token_ids(self) -> list[str]:
        return list(self.targets)

    def __str__(self) -> str:
        lines = ["Strategy:"]
        for token_id, weight in sorted(
            self.targets.items(), key=lambda kv: kv[1], reverse=True
        ):
            lines.append(
                f"  {self.symbol_for(token_id):<8} {format_pct(weight * 100):>6}%"
                f"   [{token_id}]"
            )
        lines.append(
            f"  rebalance {self.cadence.value} when drift exceeds "
            f"{format_pct(self.drift_threshold_pct)}%"
        )
        lines.append(
            f"  limits: max {format_pct(self.max_trade_pct)}% per trade, "
            f"max {format_pct(self.max_price_impact_pct)}% price impact"
        )
        return "\n".join(lines)
