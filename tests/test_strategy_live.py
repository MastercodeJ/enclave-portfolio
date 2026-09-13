"""Strategy validation against real SaucerSwap pools.

Run with:  pytest tests/test_strategy_live.py -m live

No LLM is involved: extraction is stubbed, so these exercise only the
tradability rules, which are the ones that need real market data.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from src.strategy import Allocation, StrategyDraft, parse_strategy, validate_draft

pytestmark = pytest.mark.live


def draft(allocations: list[tuple[str, float]], **kw) -> StrategyDraft:
    return StrategyDraft(
        allocations=[Allocation(symbol=s, percent=p) for s, p in allocations], **kw
    )


async def test_realistic_strategy_validates_against_live_pools():
    strategy, problems = await validate_draft(
        draft([("HBAR", 50), ("USDC", 30), ("SAUCE", 20)]),
        source_prompt="50/30/20 HBAR USDC SAUCE",
    )

    assert problems == [], [str(p) for p in problems]
    assert sum(strategy.targets.values()) == Decimal("1.00")
    assert set(strategy.symbols.values()) == {"HBAR", "USDC", "SAUCE"}


async def test_every_canonical_token_is_tradable():
    """If one stops validating, its pool has gone — likely a testnet reset."""
    from src.config import CANONICAL_TESTNET_TOKENS

    symbols = list(CANONICAL_TESTNET_TOKENS)
    share = round(100 / len(symbols), 2)
    allocations = [(s, share) for s in symbols[:-1]]
    allocations.append((symbols[-1], round(100 - share * (len(symbols) - 1), 2)))

    _, problems = await validate_draft(draft(allocations))
    tradability = [p for p in problems if "pool" in p.reason or "priced" in p.reason]
    assert tradability == [], [str(p) for p in tradability]


async def test_hbar_only_strategy_is_valid():
    """HBAR needs no route to itself."""
    strategy, problems = await validate_draft(draft([("HBAR", 100)]))
    assert problems == []
    assert strategy.targets == {"0.0.15058": Decimal("1")}


async def test_parse_strategy_end_to_end_with_a_stubbed_model():
    prompt = "Keep me 50/50 HBAR and USDC, rebalance weekly, max 15% per trade"
    strategy, problems = await parse_strategy(
        prompt,
        extractor=lambda _p: draft(
            [("HBAR", 50), ("USDC", 50)], max_trade_pct=15, rebalance_cadence="weekly"
        ),
    )

    assert problems == []
    assert strategy.source_prompt == prompt
    assert strategy.max_trade_pct == Decimal("15")
    assert strategy.cadence.value == "weekly"
