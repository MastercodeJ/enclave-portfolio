"""Request and response schemas for the HTTP API.

Kept separate from the domain models: these are wire formats, so Decimals
become strings and token ids are always explicit.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from src.strategy.models import Allocation, Strategy, StrategyProblem


class ParseRequest(BaseModel):
    prompt: str = Field(..., description="What the user typed.")
    check_tradable: bool = Field(
        True, description="Validate tokens against live pool data."
    )


class ValidateRequest(BaseModel):
    """Manual allocation entry, bypassing the language model.

    Lets the page work before any LLM credentials are configured, and gives
    tests a route that never touches a model.
    """

    allocations: list[Allocation]
    drift_threshold_pct: float | None = None
    max_trade_pct: float | None = None
    max_price_impact_pct: float | None = None
    rebalance_cadence: str | None = None
    check_tradable: bool = True


class ProblemOut(BaseModel):
    field: str
    reason: str
    suggestion: str | None = None

    @classmethod
    def of(cls, problem: StrategyProblem) -> "ProblemOut":
        return cls(
            field=problem.field, reason=problem.reason, suggestion=problem.suggestion
        )


class AllocationOut(BaseModel):
    token_id: str
    symbol: str
    weight: str
    percent: str


class StrategyOut(BaseModel):
    allocations: list[AllocationOut]
    drift_threshold_pct: str
    max_trade_pct: str
    max_price_impact_pct: str
    cadence: str
    source_prompt: str
    created_at: str
    notes: str | None = None
    summary: str

    @classmethod
    def of(cls, strategy: Strategy) -> "StrategyOut":
        from src.formatting import format_pct

        return cls(
            allocations=[
                AllocationOut(
                    token_id=token_id,
                    symbol=strategy.symbol_for(token_id),
                    weight=str(weight),
                    percent=format_pct(weight * 100),
                )
                for token_id, weight in sorted(
                    strategy.targets.items(), key=lambda kv: kv[1], reverse=True
                )
            ],
            drift_threshold_pct=format_pct(strategy.drift_threshold_pct),
            max_trade_pct=format_pct(strategy.max_trade_pct),
            max_price_impact_pct=format_pct(strategy.max_price_impact_pct),
            cadence=strategy.cadence.value,
            source_prompt=strategy.source_prompt,
            created_at=strategy.created_at.isoformat(),
            notes=strategy.notes,
            summary=str(strategy),
        )


class StrategyResponse(BaseModel):
    """Either a strategy or the reasons there isn't one — never both."""

    ok: bool
    strategy: StrategyOut | None = None
    problems: list[ProblemOut] = Field(default_factory=list)


class TokenOut(BaseModel):
    symbol: str
    token_id: str
    price_hbar: str | None = None
    price_usd: str | None = None
    tradable: bool = True


class PositionOut(BaseModel):
    token_id: str
    symbol: str | None
    amount: str
    raw_balance: int
    decimals: int
    transferable: bool


class PortfolioOut(BaseModel):
    account_id: str
    evm_address: str | None
    network: str
    hbar: str
    positions: list[PositionOut]
    fetched_at: str


class HealthOut(BaseModel):
    ok: bool
    network: str
    llm_configured: bool
    operator_account: str | None
    detail: dict[str, Any] = Field(default_factory=dict)
