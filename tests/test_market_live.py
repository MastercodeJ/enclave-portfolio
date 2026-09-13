"""Integration tests against the real SaucerSwap testnet API.

Run with:  pytest tests/test_market_live.py -m live

Assertions are invariants, not values: pool prices move continuously and
testnet resets quarterly, so hardcoding numbers here would guarantee failure.
The exact figures are pinned in the unit tests instead, against fixtures.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from src.config import CANONICAL_TESTNET_TOKENS
from src.market import (
    PoolNotFoundError,
    get_pools,
    get_price,
    get_prices,
    get_quote,
)

pytestmark = pytest.mark.live

HBAR = CANONICAL_TESTNET_TOKENS["HBAR"]
SAUCE = CANONICAL_TESTNET_TOKENS["SAUCE"]
USDC = CANONICAL_TESTNET_TOKENS["USDC"]


async def test_quality_pools_exist_and_are_clean():
    pools = await get_pools()

    assert pools, "no quality pools — testnet may have reset"
    for pool in pools:
        assert pool.has_liquidity
        for side in (pool.token_a, pool.token_b):
            assert side.due_diligence_complete
            assert side.priced


async def test_quality_filter_removes_most_pools():
    """Testnet is mostly fabricated tokens; the filter should bite hard."""
    everything = await get_pools(quality_only=False)
    quality = await get_pools(quality_only=True)

    assert len(quality) < len(everything)
    assert len(quality) < len(everything) / 2


async def test_fabricated_billion_dollar_pool_is_excluded():
    """CTK/LTK claims more TVL than the entire network reports."""
    contracts = {p.contract_id for p in await get_pools()}
    assert "0.0.4676065" not in contracts


async def test_canonical_tokens_are_priceable():
    prices = await get_prices(list(CANONICAL_TESTNET_TOKENS.values()))

    for symbol, token_id in CANONICAL_TESTNET_TOKENS.items():
        assert prices[token_id] is not None, f"{symbol} ({token_id}) unpriced"
        assert prices[token_id].hbar > 0


async def test_hbar_prices_as_unity():
    price = await get_price(HBAR)
    assert price is not None
    assert price.hbar == Decimal(1)
    assert price.usd is not None and price.usd > 0


async def test_spot_price_close_to_api_aggregate():
    """Our single-pool spot should track SaucerSwap's cross-pool figure."""
    import httpx

    async with httpx.AsyncClient(timeout=20) as http:
        tokens = (await http.get("https://test-api.saucerswap.finance/tokens")).json()
    api_sauce = next(t for t in tokens if t["id"] == SAUCE)
    api_hbar_price = Decimal(str(api_sauce["price"])) / Decimal(10**8)

    ours = await get_price(SAUCE)
    assert ours is not None
    drift = abs(ours.hbar - api_hbar_price) / api_hbar_price
    assert drift < Decimal("0.05"), f"spot {ours.hbar} vs api {api_hbar_price}"


async def test_quote_is_worse_than_mid_price():
    """Fee plus impact means a quote can never beat the mid price."""
    pools = await get_pools()
    price = await get_price(SAUCE, pools=pools)
    quote = await get_quote(HBAR, SAUCE, Decimal("10"), pools=pools)

    mid_out = Decimal("10") / price.hbar
    assert quote.amount_out < mid_out
    assert quote.price_impact_pct > 0


async def test_larger_trades_have_greater_impact():
    pools = await get_pools()
    impacts = [
        (await get_quote(HBAR, SAUCE, Decimal(a), pools=pools)).price_impact_pct
        for a in ("1", "10", "100", "1000")
    ]
    assert impacts == sorted(impacts)
    assert impacts[-1] > impacts[0]


async def test_round_trip_loses_to_fees():
    """Swapping out and back must lose roughly two fees — never profit."""
    pools = await get_pools()
    out = await get_quote(HBAR, SAUCE, Decimal("10"), pools=pools)
    back = await get_quote(SAUCE, HBAR, out.amount_out, pools=pools)

    assert back.amount_out < Decimal("10")
    assert back.amount_out > Decimal("9")  # sanity: not catastrophic


async def test_quotes_carry_provenance():
    quote = await get_quote(HBAR, SAUCE, Decimal("1"))

    assert quote.pool_contract_id.startswith("0.0.")
    assert quote.version in ("v1", "v2")
    assert quote.fee_bps > 0
    # V2 can only estimate: SaucerSwap never returns tick data.
    assert quote.approximate == (quote.version == "v2")


async def test_unknown_pair_raises():
    with pytest.raises(PoolNotFoundError):
        await get_quote(SAUCE, "0.0.999999999", Decimal("1"))


async def test_unpriceable_token_returns_none():
    assert await get_price("0.0.999999999") is None


async def test_v1_constant_product_invariant_holds():
    """k = x*y must grow after a swap: the fee stays in the pool.

    A property of the AMM itself, independent of how we compute the quote —
    if our output were too large, k would shrink.
    """
    pools = await get_pools()
    pool = next(
        p for p in pools if p.version == "v1" and p.contract_id == "0.0.2656382"
    )

    k_before = Decimal(pool.reserve_a) * Decimal(pool.reserve_b)
    quote = await get_quote(HBAR, SAUCE, Decimal("100"), pools=pools)

    raw_in = Decimal("100") * Decimal(10) ** pool.token_a.decimals
    raw_out = quote.amount_out * Decimal(10) ** pool.token_b.decimals
    k_after = (Decimal(pool.reserve_a) + raw_in) * (Decimal(pool.reserve_b) - raw_out)

    assert k_after > k_before, "quote drained the pool — output too large"


async def test_v2_sqrt_price_agrees_with_tick():
    """sqrtRatioX96 and tickCurrent are independent fields describing one price.

    price = 1.0001^tick must match (sqrtRatioX96 / 2^96)^2, confirming we read
    sqrtRatioX96 correctly.
    """
    pools = await get_pools()
    pool = next(p for p in pools if p.version == "v2" and p.sqrt_ratio_x96 and p.tick_current)

    from_sqrt = (Decimal(pool.sqrt_ratio_x96) / (Decimal(2) ** 96)) ** 2
    from_tick = Decimal("1.0001") ** pool.tick_current

    drift = abs(from_sqrt - from_tick) / from_tick
    assert drift < Decimal("0.01"), f"sqrt {from_sqrt} vs tick {from_tick}"


async def test_v1_and_v2_agree_on_the_same_pair():
    """Two AMMs, two formulas, one pair — arbitrage keeps them close.

    A large divergence would mean one of the two price formulas is wrong.
    """
    from src.market.pools import find_pools_for_pair
    from src.market.prices import pool_spot_price

    pools = await get_pools()
    candidates = find_pools_for_pair(pools, HBAR, SAUCE)
    v1 = next((p for p in candidates if p.version == "v1"), None)
    v2 = next((p for p in candidates if p.version == "v2"), None)
    if not (v1 and v2):
        pytest.skip("pair no longer has both pool versions")

    p1 = pool_spot_price(v1, SAUCE)
    p2 = pool_spot_price(v2, SAUCE)
    spread = abs(p1 - p2) / p1
    assert spread < Decimal("0.10"), f"v1 {p1} vs v2 {p2}"
