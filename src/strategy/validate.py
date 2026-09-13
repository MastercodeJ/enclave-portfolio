"""Turn an untrusted draft into a Strategy, or explain exactly why not.

Nothing here is silently repaired. The strategy is the user's, so quietly
rescaling "33/33/33" to sum to 100 would change what they asked for without
telling them. Every rejection names the field and the actual value found, so
either the user or a repair prompt can fix it precisely.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx

from src.config import DEFAULT_NETWORK, is_hbar, known_symbols, resolve_symbol
from src.formatting import format_pct
from src.market import find_pools_for_pair, get_pools, get_price
from src.market.models import Pool
from src.strategy.models import (
    DEFAULT_DRIFT_THRESHOLD_PCT,
    DEFAULT_MAX_PRICE_IMPACT_PCT,
    DEFAULT_MAX_TRADE_PCT,
    DRIFT_RANGE,
    MAX_TRADE_RANGE,
    PRICE_IMPACT_RANGE,
    WEIGHT_SUM_TOLERANCE,
    Cadence,
    Strategy,
    StrategyDraft,
    StrategyProblem,
)


def _to_decimal(value: float | int | str) -> Decimal | None:
    """Convert via str so that 33.33 does not become 33.3299999999999983."""
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _check_limit(
    value: float | None,
    field: str,
    bounds: tuple[Decimal, Decimal],
    default: Decimal,
    problems: list[StrategyProblem],
) -> Decimal:
    """Validate one stated limit, or fall back to the default if unstated."""
    if value is None:
        return default

    parsed = _to_decimal(value)
    if parsed is None:
        problems.append(
            StrategyProblem(
                field, f"{value!r} is not a number", f"default is {format_pct(default)}%"
            )
        )
        return default

    low, high = bounds
    if not (low <= parsed <= high):
        problems.append(
            StrategyProblem(
                field,
                f"{format_pct(parsed)}% is outside the sensible range "
                f"{format_pct(low)}%-{format_pct(high)}%",
                f"default is {format_pct(default)}%",
            )
        )
        return default
    return parsed


def _resolve_allocations(
    draft: StrategyDraft, network: str, problems: list[StrategyProblem]
) -> tuple[dict[str, Decimal], dict[str, str]]:
    """Resolve symbols to token ids and percentages to fractional weights."""
    targets: dict[str, Decimal] = {}
    symbols: dict[str, str] = {}

    for index, allocation in enumerate(draft.allocations):
        field = f"allocations[{index}]"
        symbol = (allocation.symbol or "").strip().upper()

        if not symbol:
            problems.append(StrategyProblem(field, "no token symbol given"))
            continue

        token_id = resolve_symbol(symbol, network)
        if token_id is None:
            problems.append(
                StrategyProblem(
                    field,
                    f"{symbol} is not a token we can trade on {network}",
                    f"available: {', '.join(known_symbols(network))}",
                )
            )
            continue

        percent = _to_decimal(allocation.percent)
        if percent is None:
            problems.append(
                StrategyProblem(field, f"{allocation.percent!r} is not a percentage")
            )
            continue

        if percent < 0 or percent > 100:
            problems.append(
                StrategyProblem(
                    field, f"{format_pct(percent)}% is not between 0 and 100"
                )
            )
            continue

        # Two lines naming the same token are ambiguous rather than additive:
        # "50% USDC and 30% USDC" could mean 80% or a correction.
        if token_id in targets:
            problems.append(
                StrategyProblem(
                    field,
                    f"{symbol} appears more than once",
                    "state each token once, with its total share",
                )
            )
            continue

        targets[token_id] = percent / Decimal(100)
        symbols[token_id] = symbol

    return targets, symbols


def _check_weights_sum(
    targets: dict[str, Decimal], problems: list[StrategyProblem]
) -> None:
    total_pct = sum(targets.values(), Decimal(0)) * 100
    if abs(total_pct - Decimal(100)) > WEIGHT_SUM_TOLERANCE:
        problems.append(
            StrategyProblem(
                "allocations",
                f"percentages add up to {format_pct(total_pct)}%, not 100%",
                "adjust one of the allocations so the total is exactly 100",
            )
        )


async def _check_tradable(
    targets: dict[str, Decimal],
    symbols: dict[str, str],
    network: str,
    pools: list[Pool],
    problems: list[StrategyProblem],
) -> None:
    """Confirm every token can actually be priced and swapped.

    A hallucinated-but-plausible token is the main failure mode of LLM
    extraction, and an unpriceable one would make every other weight wrong.
    """
    for token_id, weight in targets.items():
        symbol = symbols.get(token_id, token_id)

        if await get_price(token_id, network, pools=pools) is None:
            problems.append(
                StrategyProblem(
                    f"allocations.{symbol}",
                    f"{symbol} has no pool with liquidity on {network}, so it cannot be priced",
                    "choose a token with an active market",
                )
            )
            continue

        # Rebalancing routes through HBAR, so every other token needs a pool
        # paired with it. HBAR itself trivially qualifies.
        if is_hbar(token_id):
            continue
        if not find_pools_for_pair(pools, token_id, "0.0.15058"):
            problems.append(
                StrategyProblem(
                    f"allocations.{symbol}",
                    f"there is no {symbol}/HBAR pool, so it cannot be rebalanced",
                    "rebalancing routes through HBAR",
                )
            )


async def validate_draft(
    draft: StrategyDraft,
    source_prompt: str = "",
    network: str = DEFAULT_NETWORK,
    *,
    pools: list[Pool] | None = None,
    check_tradable: bool = True,
    client: httpx.AsyncClient | None = None,
) -> tuple[Strategy | None, list[StrategyProblem]]:
    """Validate a draft against the rules and live market data.

    Args:
        draft: untrusted model output.
        source_prompt: what the user actually typed, kept on the Strategy for
            provenance.
        pools: pre-fetched pools, to avoid refetching in a loop.
        check_tradable: set False to validate shape alone, without network
            access.

    Returns:
        (strategy, []) when valid, or (None, problems) listing every failure.
        Problems accumulate rather than raising on the first, so a repair
        prompt can address them all at once.
    """
    problems: list[StrategyProblem] = []

    if not draft.allocations:
        problems.append(
            StrategyProblem(
                "allocations",
                "no target allocation was given",
                "say something like 'half HBAR, half USDC'",
            )
        )

    targets, symbols = _resolve_allocations(draft, network, problems)

    # Only meaningful once every line resolved; otherwise the total is
    # misleading and would produce a second, confusing complaint.
    if targets and not problems:
        _check_weights_sum(targets, problems)

    drift = _check_limit(
        draft.drift_threshold_pct, "drift_threshold_pct", DRIFT_RANGE,
        DEFAULT_DRIFT_THRESHOLD_PCT, problems,
    )
    max_trade = _check_limit(
        draft.max_trade_pct, "max_trade_pct", MAX_TRADE_RANGE,
        DEFAULT_MAX_TRADE_PCT, problems,
    )
    max_impact = _check_limit(
        draft.max_price_impact_pct, "max_price_impact_pct", PRICE_IMPACT_RANGE,
        DEFAULT_MAX_PRICE_IMPACT_PCT, problems,
    )

    if targets and check_tradable and not problems:
        if pools is None:
            pools = await get_pools(network, client=client)
        await _check_tradable(targets, symbols, network, pools, problems)

    if problems:
        return None, problems

    return (
        Strategy(
            targets=targets,
            symbols=symbols,
            source_prompt=source_prompt,
            created_at=datetime.now(timezone.utc),
            drift_threshold_pct=drift,
            max_trade_pct=max_trade,
            max_price_impact_pct=max_impact,
            cadence=Cadence.parse(draft.rebalance_cadence),
            notes=draft.notes,
        ),
        [],
    )
