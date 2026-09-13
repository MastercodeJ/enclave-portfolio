"""Executable swap quotes computed from pool state.

SaucerSwap exposes no quote or routing endpoint (/quote, /swap/quote and
/router/quote all 404), so the constant-product and concentrated-liquidity
maths are done here. Both formulas were validated against live pools.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import ROUND_FLOOR, Decimal

import httpx

from src.config import DEFAULT_NETWORK, is_hbar
from src.market.errors import (
    InsufficientLiquidityError,
    MarketDataError,
    NonViableQuoteError,
    PoolNotFoundError,
)
from src.market.models import Pool, Quote
from src.market.pools import find_pools_for_pair, get_pools, rank_pools
from src.market.prices import Q96, pool_spot_price, precise

BPS_DENOMINATOR = Decimal(10_000)


def _floor(value: Decimal) -> Decimal:
    """Truncate toward zero, matching Solidity integer division.

    An AMM never rounds in the trader's favour. Rounding half-even instead
    overstates the output by up to one raw unit, which is enough to make an
    on-chain swap revert against a min_amount_out derived from our own quote.
    """
    return value.to_integral_value(rounding=ROUND_FLOOR)


def _sides(pool: Pool, token_in: str) -> tuple[int, int, int, int]:
    """Return (reserve_in, reserve_out, decimals_in, decimals_out)."""
    a_is_in = (
        pool.token_a.token_id == token_in
        or (is_hbar(pool.token_a.token_id) and is_hbar(token_in))
    )
    if a_is_in:
        return pool.reserve_a, pool.reserve_b, pool.token_a.decimals, pool.token_b.decimals
    return pool.reserve_b, pool.reserve_a, pool.token_b.decimals, pool.token_a.decimals


def _available_out(pool: Pool, token_in: str) -> Decimal | None:
    """How much of the output token the pool actually holds, in whole units.

    Returns None when the pool reports no reserve for that side, in which case
    no cap can be applied.
    """
    _, reserve_out, _, dec_out = _sides(pool, token_in)
    if reserve_out <= 0:
        return None
    return Decimal(reserve_out) / Decimal(10) ** dec_out


def quote_v1(pool: Pool, token_in: str, amount_in: Decimal) -> Decimal:
    """Constant product output, fee deducted from the input.

        out = (in * (10000-fee) * reserveOut)
            / (reserveIn * 10000 + in * (10000-fee))

    Verified on HBAR/SAUCE (0.0.2656382): 1 HBAR -> 57.716486 SAUCE.
    """
    reserve_in, reserve_out, dec_in, dec_out = _sides(pool, token_in)
    if reserve_in == 0 or reserve_out == 0:
        return Decimal(0)

    with precise():
        raw_in = _floor(amount_in * Decimal(10) ** dec_in)
        after_fee = BPS_DENOMINATOR - Decimal(pool.fee_bps)
        numerator = raw_in * after_fee * Decimal(reserve_out)
        denominator = Decimal(reserve_in) * BPS_DENOMINATOR + raw_in * after_fee
        if denominator == 0:
            return Decimal(0)
        raw_out = _floor(numerator / denominator)
        return raw_out / Decimal(10) ** dec_out


def quote_v2(pool: Pool, token_in: str, amount_in: Decimal) -> Decimal:
    """Concentrated-liquidity output, assuming a single tick.

        sqrtP' = L * sqrtP / (L + inAfterFee * sqrtP / 2^96)
        out    = L * (sqrtP - sqrtP') / 2^96

    SaucerSwap never returns tick data (`ticks` is empty on every endpoint and
    /v2/pools/{id}/ticks is 404), so liquidity is assumed constant across the
    trade. That holds inside the current tick and degrades as the trade grows,
    which is why every V2 quote is flagged approximate.
    """
    if not pool.sqrt_ratio_x96 or not pool.liquidity:
        return Decimal(0)

    with precise():
        return _quote_v2_inner(pool, token_in, amount_in)


def _quote_v2_inner(pool: Pool, token_in: str, amount_in: Decimal) -> Decimal:
    """V2 maths, called inside a high-precision context by quote_v2."""
    a_is_in = (
        pool.token_a.token_id == token_in
        or (is_hbar(pool.token_a.token_id) and is_hbar(token_in))
    )
    dec_in = pool.token_a.decimals if a_is_in else pool.token_b.decimals
    dec_out = pool.token_b.decimals if a_is_in else pool.token_a.decimals

    liquidity = Decimal(pool.liquidity)
    sqrt_p = Decimal(pool.sqrt_ratio_x96)
    raw_in = _floor(amount_in * Decimal(10) ** dec_in)
    after_fee = raw_in * (BPS_DENOMINATOR - Decimal(pool.fee_bps)) / BPS_DENOMINATOR

    if a_is_in:
        # token0 in: price falls.
        denominator = liquidity + after_fee * sqrt_p / Q96
        if denominator == 0:
            return Decimal(0)
        sqrt_p_next = (liquidity * sqrt_p) / denominator
        raw_out = liquidity * (sqrt_p - sqrt_p_next) / Q96
    else:
        # token1 in: price rises.
        sqrt_p_next = sqrt_p + (after_fee * Q96) / liquidity
        if sqrt_p_next == 0 or sqrt_p == 0:
            return Decimal(0)
        raw_out = liquidity * Q96 * (sqrt_p_next - sqrt_p) / (sqrt_p_next * sqrt_p)

    if raw_out <= 0:
        return Decimal(0)
    return _floor(raw_out) / Decimal(10) ** dec_out


async def get_quote(
    token_in: str,
    token_out: str,
    amount_in: Decimal,
    network: str = DEFAULT_NETWORK,
    *,
    pools: list[Pool] | None = None,
    client: httpx.AsyncClient | None = None,
) -> Quote:
    """What a swap would actually return, fee and price impact included.

    Args:
        token_in / token_out: token ids. HBAR and its wrapped forms are
            interchangeable.
        amount_in: in whole units, not raw.
        pools: pre-fetched pools, to avoid refetching in a loop.

    Raises:
        ValueError: amount_in is zero or negative.
        PoolNotFoundError: no qualifying pool trades this pair.
        InsufficientLiquidityError: every candidate pool holds less of the
            output token than the trade needs.
        NonViableQuoteError: every candidate pool returns nothing.
    """
    # A negative amount flips the sign of the constant-product denominator and
    # yields a large positive output; zero produces a plausible-looking empty
    # quote. Neither is a trade, so both are rejected before any maths runs.
    if amount_in <= 0:
        raise ValueError(f"amount_in must be positive, got {amount_in}")

    if pools is None:
        pools = await get_pools(network, client=client)

    candidates = rank_pools(find_pools_for_pair(pools, token_in, token_out))
    if not candidates:
        raise PoolNotFoundError(token_in, token_out, network)

    # Each candidate is tried in turn so that one malformed or too-shallow pool
    # does not hide a healthy one ranked behind it. The last failure is
    # re-raised if every candidate fails, so the caller still learns why.
    last_error: MarketDataError | None = None

    for pool in candidates:
        amount_out = (
            quote_v1(pool, token_in, amount_in)
            if pool.version == "v1"
            else quote_v2(pool, token_in, amount_in)
        )

        # A pool with liquidity should never return nothing. When it does, the
        # pool data is corrupt or the input rounds away entirely -- either way
        # the trade is not viable, and returning a silent zero invites the
        # agent to swap its input for nothing.
        if amount_out <= 0:
            last_error = NonViableQuoteError(
                token_in, token_out, amount_in, pool.contract_id
            )
            continue

        # V1's constant product asymptotes below the reserve on its own, but
        # V2's single-tick approximation does not: with no tick data it assumes
        # liquidity continues forever, so a large enough input quotes more than
        # the pool physically holds while still reporting a small price impact.
        # Cap against the real reserve, which the pool already carries.
        available = _available_out(pool, token_in)
        if available is not None and amount_out >= available:
            last_error = InsufficientLiquidityError(
                token_in, token_out, amount_in, amount_out, available, pool.contract_id
            )
            continue

        return _build_quote(pool, token_in, token_out, amount_in, amount_out)

    raise last_error or PoolNotFoundError(token_in, token_out, network)


def _build_quote(
    pool: Pool,
    token_in: str,
    token_out: str,
    amount_in: Decimal,
    amount_out: Decimal,
) -> Quote:
    """Assemble a Quote, deriving price impact from the pool's own mid price."""
    # Impact is measured against mid, so it folds in the fee as well as the
    # depth effect. A quote can never beat mid.
    mid = pool_spot_price(pool, token_in)
    ideal = amount_in * mid
    impact = (ideal - amount_out) / ideal * Decimal(100) if ideal > 0 else Decimal(0)

    return Quote(
        token_in=token_in,
        token_out=token_out,
        amount_in=amount_in,
        amount_out=amount_out,
        fee_bps=pool.fee_bps,
        price_impact_pct=impact,
        pool_contract_id=pool.contract_id,
        version=pool.version,
        approximate=pool.version == "v2",
        fetched_at=datetime.now(timezone.utc),
    )
