"""Spot prices derived from SaucerSwap pool state.

Prices are computed from the pool rather than read from the API's precomputed
`priceUsd`, so that a price and a quote always describe the same pool state.
The API's figure is an aggregate across pools and was observed to differ from
single-pool spot by up to ~1.2%.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, getcontext, localcontext
from typing import Iterable

import httpx

from src.config import DEFAULT_NETWORK, WHBAR_TOKEN_ID, is_hbar
from src.market.models import Pool, Price
from src.market.pools import find_pools_for_token, get_pools, rank_pools

# sqrtRatioX96 values are ~29 digits and get squared, so the default 28 digits
# of precision is not enough.
#
# Decimal contexts are thread-local, so setting it at import time only covers
# the importing thread -- a worker thread would silently run at 28. Precision
# is therefore applied per-call via `precise()` rather than globally.
PRECISION = 60

Q96 = Decimal(2) ** 96


def precise():
    """Context manager giving arithmetic enough precision for sqrtRatioX96.

    Use around any calculation touching sqrt prices:

        with precise():
            ...
    """
    ctx = getcontext().copy()
    ctx.prec = PRECISION
    return localcontext(ctx)


def pool_spot_price(pool: Pool, base_token_id: str) -> Decimal:
    """Price of `base_token_id` denominated in the pool's other token.

    V1 uses the reserve ratio; V2 derives the price from sqrtRatioX96. Both
    were cross-checked against SaucerSwap's own published prices.
    """
    a_is_base = (
        pool.token_a.token_id == base_token_id
        or (is_hbar(pool.token_a.token_id) and is_hbar(base_token_id))
    )
    base = pool.token_a if a_is_base else pool.token_b
    quote = pool.token_b if a_is_base else pool.token_a

    # Precision is raised per call rather than at import: Decimal contexts are
    # thread-local, so a module-level setting would leave worker threads at the
    # default 28 digits, which is not enough to square sqrtRatioX96.
    with precise():
        if pool.version == "v1":
            base_reserve = pool.reserve_a if a_is_base else pool.reserve_b
            quote_reserve = pool.reserve_b if a_is_base else pool.reserve_a
            if base_reserve == 0:
                return Decimal(0)
            base_amount = Decimal(base_reserve) / (Decimal(10) ** base.decimals)
            quote_amount = Decimal(quote_reserve) / (Decimal(10) ** quote.decimals)
            return quote_amount / base_amount

        # V2: (sqrtRatioX96 / 2^96)^2 gives token_b per token_a in raw units.
        if not pool.sqrt_ratio_x96:
            return Decimal(0)
        raw = (Decimal(pool.sqrt_ratio_x96) / Q96) ** 2
        b_per_a = (
            raw
            * (Decimal(10) ** pool.token_a.decimals)
            / (Decimal(10) ** pool.token_b.decimals)
        )
        if b_per_a == 0:
            return Decimal(0)
        return b_per_a if a_is_base else Decimal(1) / b_per_a


def _price_from_pool(pool: Pool, token_id: str, hbar_usd: Decimal | None) -> Price | None:
    """Build a Price for `token_id` using `pool`, quoted in HBAR."""
    other = pool.other_side(
        pool.token_a.token_id
        if (pool.token_a.token_id == token_id or (is_hbar(pool.token_a.token_id) and is_hbar(token_id)))
        else pool.token_b.token_id
    )
    price_in_other = pool_spot_price(pool, token_id)
    if price_in_other <= 0:
        return None

    if is_hbar(other.token_id):
        price_hbar = price_in_other
    elif other.price_usd and hbar_usd:
        # Cross through USD when the pool is not HBAR-denominated.
        price_hbar = price_in_other * other.price_usd / hbar_usd
    else:
        return None

    symbol = None
    for side in (pool.token_a, pool.token_b):
        if side.token_id == token_id or (is_hbar(side.token_id) and is_hbar(token_id)):
            symbol = side.symbol
            break

    return Price(
        token_id=token_id,
        symbol=symbol,
        hbar=price_hbar,
        usd=price_hbar * hbar_usd if hbar_usd else None,
        pool_contract_id=pool.contract_id,
        version=pool.version,
        fetched_at=datetime.now(timezone.utc),
    )


def _hbar_usd(pools: list[Pool]) -> Decimal | None:
    """HBAR's USD price, taken from any pool that holds it.

    USD conversion is the one place the API's own figure is used: there is no
    on-chain USD, so a reference rate has to come from somewhere.
    """
    for pool in pools:
        for side in (pool.token_a, pool.token_b):
            if is_hbar(side.token_id) and side.price_usd:
                return side.price_usd
    return None


async def get_price(
    token_id: str,
    network: str = DEFAULT_NETWORK,
    *,
    pools: list[Pool] | None = None,
    client: httpx.AsyncClient | None = None,
) -> Price | None:
    """Spot price of one token, in HBAR and USD.

    Returns None when no qualifying pool prices this token. Callers must treat
    that as "exclude from portfolio weights", never as zero — a silent zero
    makes the portfolio total wrong and every target weight wrong with it.

    Args:
        pools: pre-fetched pools, to avoid refetching in a loop.
    """
    if pools is None:
        pools = await get_pools(network, client=client)

    if is_hbar(token_id):
        hbar_usd = _hbar_usd(pools)
        return Price(
            token_id=WHBAR_TOKEN_ID,
            symbol="HBAR",
            hbar=Decimal(1),
            usd=hbar_usd,
            pool_contract_id="",
            version="v1",
            fetched_at=datetime.now(timezone.utc),
        )

    # Walk candidates rather than trusting the best one: a single pool with
    # malformed data would otherwise drop a real asset out of the portfolio,
    # and callers read None as "exclude from weights".
    hbar_usd = _hbar_usd(pools)
    for pool in rank_pools(find_pools_for_token(pools, token_id)):
        price = _price_from_pool(pool, token_id, hbar_usd)
        if price is not None and price.hbar > 0:
            return price
    return None


async def get_prices(
    token_ids: Iterable[str],
    network: str = DEFAULT_NETWORK,
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Price | None]:
    """Spot prices for several tokens from a single pool fetch.

    Unpriceable tokens map to None rather than being omitted, so callers are
    forced to decide what to do about them.
    """
    pools = await get_pools(network, client=client)
    return {tid: await get_price(tid, network, pools=pools) for tid in token_ids}
