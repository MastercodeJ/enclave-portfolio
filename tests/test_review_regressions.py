"""Regression tests for defects found in code review.

Each test names the defect it locks down. All were reproduced against the real
code before the fix, so they fail on the pre-fix implementation.
"""

from __future__ import annotations

import threading
from decimal import Decimal

import httpx
import pytest
import respx

from src.market import (
    InsufficientLiquidityError,
    MarketDataError,
    get_pools,
    get_price,
    get_quote,
    is_quality_pool,
    rank_pools,
)
from src.market.client import SaucerSwapClient, _RESPONSE_CACHE
from src.market.models import Pool, PoolToken, _round
from src.market.pools import _parse_v1
from src.portfolio import MirrorNodeRequestError
from src.portfolio.balance import _build_token
from tests.test_market_unit import HOST, V1_POOLS, V2_POOLS, mock_dex

MIRROR = "https://testnet.mirrornode.hedera.com"


def _token(**kw) -> PoolToken:
    base = dict(
        token_id="0.0.1", symbol="X", name="X", decimals=8,
        price_usd=Decimal("1"), due_diligence_complete=True, fee_on_transfer=False,
    )
    return PoolToken(**{**base, **kw})


# --------------------------------------------------------------------------
# HIGH
# --------------------------------------------------------------------------

@respx.mock
async def test_v2_quote_cannot_exceed_pool_reserves():
    """V2's single-tick maths would otherwise quote more than the pool holds.

    It reported only ~4% price impact while promising 95.7m DAI from a pool
    holding 5,000 — a max-impact risk limit would have waved it through.
    """
    mock_dex()
    pools = await get_pools()
    with pytest.raises(InsufficientLiquidityError) as exc:
        await get_quote("0.0.5449", "0.0.5529", Decimal("100000000"), pools=pools)
    assert exc.value.available < exc.value.amount_out


@respx.mock
@pytest.mark.parametrize("bad_amount", ["-100000", "-1", "0"])
async def test_non_positive_amount_in_is_rejected(bad_amount):
    """Negative input used to return a large positive amount_out.

    -100000 HBAR quoted 17,304,611 SAUCE at 0.000% impact, because the
    constant-product denominator changes sign.
    """
    mock_dex()
    pools = await get_pools()
    with pytest.raises(ValueError, match="must be positive"):
        await get_quote("0.0.15058", "0.0.1183558", Decimal(bad_amount), pools=pools)


def test_missing_token_metadata_does_not_crash_balance_read():
    """meta is None for deleted tokens; dereferencing it killed the whole read."""
    assert _build_token({"token_id": "0.0.1", "balance": 100}, None) is None

    token = _build_token({"token_id": "0.0.1", "balance": 100, "decimals": 6}, None)
    assert token is not None
    assert token.decimals == 6
    assert token.amount == Decimal("0.000100")


def test_decimals_taken_from_metadata_when_row_omits_it():
    token = _build_token(
        {"token_id": "0.0.1", "balance": 100},
        {"decimals": "8", "type": "FUNGIBLE_COMMON"},
    )
    assert token is not None and token.decimals == 8


# --------------------------------------------------------------------------
# MEDIUM
# --------------------------------------------------------------------------

def test_nft_is_dropped_when_metadata_unavailable():
    """Without metadata the type is unknown; zero decimals is the only signal.

    An NFT previously leaked through as a fungible position with amount=16.
    """
    assert _build_token(
        {"token_id": "0.0.2212736", "balance": 16, "decimals": 0}, None
    ) is None


def test_v2_pool_without_sqrt_price_is_not_quality():
    """It has liquidity but no price source, so it prices nothing."""
    tok = _token()
    broken = Pool("0.0.9", "v2", tok, tok, 100, 100, 30, sqrt_ratio_x96=None, liquidity=999)
    healthy = Pool("0.0.9", "v2", tok, tok, 100, 100, 30,
                   sqrt_ratio_x96=79228162514264337593543950336, liquidity=999)
    assert broken.has_liquidity is False
    assert is_quality_pool(broken) is False
    assert healthy.has_liquidity is True


@respx.mock
async def test_price_falls_back_past_a_broken_pool():
    """One malformed pool must not drop a real asset from the portfolio."""
    broken_v2 = dict(V2_POOLS[0], sqrtRatioX96=None, liquidity="999999999999999")
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=V1_POOLS))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=[broken_v2]))

    price = await get_price("0.0.1183558")
    assert price is not None, "healthy V1 pool was hidden behind the broken V2 pool"
    assert price.version == "v1"


def test_rank_pools_sorts_rather_than_assuming_sorted_input():
    """select_pool used to take v1[0] on faith and return the shallower pool."""
    cheap = _parse_v1(dict(V1_POOLS[0], contractId="0.0.cheap"))
    rich = _parse_v1(dict(V1_POOLS[1], contractId="0.0.rich"))
    unsorted = sorted([cheap, rich], key=lambda p: p.tvl_usd)  # deliberately worst-first
    assert rank_pools(unsorted)[0].tvl_usd == max(cheap.tvl_usd, rich.tvl_usd)


def test_fee_on_transfer_pools_are_excluded():
    """Delivered amount is below the quote, so min_amount_out would revert."""
    normal, taxed = _token(), _token(token_id="0.0.2", fee_on_transfer=True)
    assert is_quality_pool(Pool("0.0.9", "v1", normal, normal, 100, 100, 30)) is True
    assert is_quality_pool(Pool("0.0.9", "v1", normal, taxed, 100, 100, 30)) is False


@respx.mock
async def test_wholesale_parse_failure_is_reported_not_swallowed():
    """Returning [] would make every token look untradable, not the feed broken."""
    garbage = [{"nope": i} for i in range(10)]
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=garbage))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=[]))

    with pytest.raises(MarketDataError, match="shape has likely changed"):
        await get_pools()


@respx.mock
async def test_mirror_node_4xx_is_typed():
    """A raw httpx error would reach the LLM as a traceback."""
    from src.portfolio import get_account_balance

    respx.get(url__regex=rf"{MIRROR}/api/v1/accounts/.*").mock(
        return_value=httpx.Response(400, json={"_status": {"messages": []}})
    )
    with pytest.raises(MirrorNodeRequestError):
        await get_account_balance("my wallet")


@respx.mock
async def test_saucerswap_4xx_is_typed():
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(400))
    with pytest.raises(MarketDataError):
        await get_pools()


@respx.mock
async def test_response_cache_actually_hits():
    """A per-instance cache never registered a hit: get_pools builds a new client."""
    route_v1 = respx.get(f"{HOST}/pools").mock(
        return_value=httpx.Response(200, json=V1_POOLS)
    )
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=V2_POOLS))

    for _ in range(5):
        await get_pools()

    assert route_v1.call_count == 1, f"cache missed: {route_v1.call_count} requests"
    assert len(_RESPONSE_CACHE) == 2


@respx.mock
async def test_clear_cache_forces_a_refetch():
    route = respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=V1_POOLS))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=V2_POOLS))

    await get_pools()
    SaucerSwapClient.clear_cache()
    await get_pools()
    assert route.call_count == 2


# --------------------------------------------------------------------------
# LOW
# --------------------------------------------------------------------------

@respx.mock
async def test_precision_is_independent_of_calling_thread():
    """Decimal contexts are thread-local; workers silently ran at 28 digits."""
    from src.market.prices import pool_spot_price

    mock_dex()
    pools = await get_pools()
    pool = next(p for p in pools if p.version == "v2")

    results: dict[str, Decimal] = {}
    results["main"] = pool_spot_price(pool, pool.token_b.token_id)
    worker = threading.Thread(
        target=lambda: results.__setitem__(
            "worker", pool_spot_price(pool, pool.token_b.token_id)
        )
    )
    worker.start()
    worker.join()

    assert results["main"] == results["worker"]


def test_round_never_raises_from_a_display_path():
    """quantize() overflows on extreme values, and this is called from __str__."""
    assert _round(Decimal("1E+55"), 6) == Decimal("1E+55")
    assert _round(Decimal("57.7164861111"), 6) == Decimal("57.716486")
    assert _round(Decimal("10.000000"), 6) == Decimal("10")


def test_price_and_quote_str_survive_extreme_values():
    from datetime import datetime, timezone

    from src.market.models import Price

    price = Price(
        token_id="0.0.1", symbol="JUNK", hbar=Decimal("1E+60"), usd=Decimal("1E+60"),
        pool_contract_id="0.0.2", version="v1", fetched_at=datetime.now(timezone.utc),
    )
    assert "JUNK" in str(price)  # must not raise InvalidOperation


@respx.mock
async def test_malformed_address_is_reported_as_invalid_not_as_an_outage():
    """A 400 means the address is wrong; the model can fix that, not an outage."""
    from src.plugins.portfolio_plugin import (
        GetPortfolioBalanceInput,
        GetPortfolioBalanceTool,
    )

    respx.get(url__regex=rf"{MIRROR}/api/v1/accounts/.*").mock(
        return_value=httpx.Response(400, json={})
    )
    response = await GetPortfolioBalanceTool(network="testnet").execute(
        client=None, context=None, params=GetPortfolioBalanceInput(address="my wallet")
    )

    assert response.error == "invalid_address"
    assert "not a valid Hedera address" in response.human_message
