"""Unit tests for src/market — fully mocked, no network.

Fixtures mirror real testnet payloads captured from
test-api.saucerswap.finance, including their quirks: dueDiligenceComplete
arrives as 1/0 from /pools but true/false elsewhere, priceUsd is sometimes a
string, and V2 `ticks` is always empty.
"""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest
import respx

from src.market import (
    PoolNotFoundError,
    get_pools,
    get_price,
    get_prices,
    get_quote,
    is_quality_pool,
    select_pool,
)

HOST = "https://test-api.saucerswap.finance"

WHBAR = {"id": "0.0.15058", "symbol": "HBAR", "name": "WHBAR[new]", "decimals": 8,
         "price": "100000000", "priceUsd": 0.07367756, "dueDiligenceComplete": 1,
         "isFeeOnTransferToken": 0}
SAUCE = {"id": "0.0.1183558", "symbol": "SAUCE", "name": "Sauce", "decimals": 6,
         "price": "1739340", "priceUsd": 0.0012815017803927268,
         "dueDiligenceComplete": 1, "isFeeOnTransferToken": 0}
USDC = {"id": "0.0.5449", "symbol": "USDC", "name": "USD Coin", "decimals": 6,
        "price": "44558892", "priceUsd": 0.03282990610881684,
        "dueDiligenceComplete": 1, "isFeeOnTransferToken": 0}
DAI = {"id": "0.0.5529", "symbol": "DAI", "name": "Dai", "decimals": 8,
       "price": "44668703", "priceUsd": 0.03184241031036916,
       "dueDiligenceComplete": 1, "isFeeOnTransferToken": 0}
# Fabricated token: the real testnet pair CTK/LTK claims ~$5.9bn TVL while the
# whole network is ~$683k.
CTK = {"id": "0.0.4673010", "symbol": "CTK", "name": "CTK", "decimals": 8,
       "price": "999999999999", "priceUsd": 12345.6, "dueDiligenceComplete": 0,
       "isFeeOnTransferToken": 0}
LTK = {"id": "0.0.4673011", "symbol": "LTK", "name": "LTK", "decimals": 8,
       "price": "999999999999", "priceUsd": 9876.5, "dueDiligenceComplete": 0,
       "isFeeOnTransferToken": 0}
# Zero-price token: due-diligence complete but a dead market.
XSAUCE = {"id": "0.0.1460200", "symbol": "XSAUCE", "name": "xSAUCE", "decimals": 6,
          "price": "0", "priceUsd": 0, "dueDiligenceComplete": 1,
          "isFeeOnTransferToken": 0}

V1_POOLS = [
    {   # the pool every verified quote figure comes from
        "id": 9, "contractId": "0.0.2656382", "inTopPools": True,
        "lpToken": {"decimals": 8, "id": "0.0.2656383", "name": "SS-LP HBAR - SAUCE",
                    "symbol": "HBAR - SAUCE", "priceUsd": "1.0"},
        "lpTokenReserve": "1000",
        "tokenA": WHBAR, "tokenReserveA": "7476358815713",
        "tokenB": SAUCE, "tokenReserveB": "4328133568240",
    },
    {
        "id": 3, "contractId": "0.0.2661044", "inTopPools": True,
        "lpToken": {"decimals": 8, "id": "0.0.2661045", "name": "SS-LP USDC - HBAR",
                    "symbol": "USDC - HBAR", "priceUsd": "0.98"},
        "lpTokenReserve": "2011704619891",
        "tokenA": USDC, "tokenReserveA": "303241261288",
        "tokenB": WHBAR, "tokenReserveB": "13677774860577",
    },
    {   # junk: must be filtered out despite enormous TVL
        "id": 99, "contractId": "0.0.4676065", "inTopPools": False,
        "lpToken": {"decimals": 8, "id": "0.0.4676066", "name": "SS-LP CTK - LTK",
                    "symbol": "CTK - LTK", "priceUsd": "NaN"},
        "lpTokenReserve": "1",
        "tokenA": CTK, "tokenReserveA": "50000000000000000",
        "tokenB": LTK, "tokenReserveB": "50000000000000000",
    },
    {   # dead: zero reserves
        "id": 0, "contractId": "0.0.117649", "inTopPools": False,
        "lpToken": {"decimals": 8, "id": "0.0.117650", "name": "SS-LP dead",
                    "symbol": "dead", "priceUsd": "NaN"},
        "lpTokenReserve": "0",
        "tokenA": XSAUCE, "tokenReserveA": "0",
        "tokenB": WHBAR, "tokenReserveB": "0",
    },
]

V2_POOLS = [
    {   # same pair as the V1 pool above, shallower -> V1 must win
        "id": 1, "contractId": "0.0.2661057",
        "tokenA": WHBAR, "tokenB": SAUCE,
        "amountA": "2849110756214", "amountB": "1125899160129",
        "fee": 3000, "sqrtRatioX96": "60021221918238822468213032530",
        "tickCurrent": -5553, "liquidity": "1000515875966", "ticks": [],
    },
    {   # only pool for this pair -> V2 must be used, flagged approximate
        "id": 7, "contractId": "0.0.2661063",
        "tokenA": USDC, "tokenB": DAI,
        "amountA": "5000000000", "amountB": "500000000000",
        "fee": 500, "sqrtRatioX96": "791388481892928938397732785096",
        "tickCurrent": -230271, "liquidity": "24183957272792619", "ticks": [],
    },
]


def mock_dex() -> None:
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=V1_POOLS))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=V2_POOLS))


# --------------------------------------------------------------------------
# pool filtering
# --------------------------------------------------------------------------

@respx.mock
async def test_quality_filter_excludes_junk_and_dead_pools():
    mock_dex()
    pools = await get_pools()
    contracts = {p.contract_id for p in pools}

    assert "0.0.2656382" in contracts  # real
    assert "0.0.4676065" not in contracts  # fabricated $5.9bn CTK/LTK
    assert "0.0.117649" not in contracts  # zero reserves


@respx.mock
async def test_quality_filter_can_be_disabled():
    mock_dex()
    assert len(await get_pools(quality_only=False)) == len(V1_POOLS) + len(V2_POOLS)


@respx.mock
async def test_pools_sorted_by_tvl_descending():
    mock_dex()
    tvls = [p.tvl_usd for p in await get_pools()]
    assert tvls == sorted(tvls, reverse=True)


def test_is_quality_pool_requires_due_diligence():
    from src.market.pools import _parse_v1

    assert is_quality_pool(_parse_v1(V1_POOLS[0])) is True
    assert is_quality_pool(_parse_v1(V1_POOLS[2])) is False  # CTK/LTK


# --------------------------------------------------------------------------
# HBAR aliasing
# --------------------------------------------------------------------------

@respx.mock
async def test_hbar_aliases_resolve_to_one_asset():
    mock_dex()
    pools = await get_pools()
    # 0.0.0 (native sentinel) and 0.0.15058 (WHBAR) are the same asset.
    for alias in ("0.0.0", "0.0.15058", "0.0.2230359"):
        price = await get_price(alias, pools=pools)
        assert price is not None, alias
        assert price.hbar == Decimal(1)


@respx.mock
async def test_non_alias_hbar_token_is_not_treated_as_hbar():
    """0.0.8647814 calls itself HBAR but prices differently."""
    mock_dex()
    pools = await get_pools()
    assert await get_price("0.0.8647814", pools=pools) is None


@respx.mock
async def test_quote_accepts_hbar_alias_as_input():
    mock_dex()
    pools = await get_pools()
    via_native = await get_quote("0.0.0", "0.0.1183558", Decimal("1"), pools=pools)
    via_whbar = await get_quote("0.0.15058", "0.0.1183558", Decimal("1"), pools=pools)
    assert via_native.amount_out == via_whbar.amount_out


# --------------------------------------------------------------------------
# prices
# --------------------------------------------------------------------------

@respx.mock
async def test_v1_spot_price_matches_reserve_ratio():
    mock_dex()
    price = await get_price("0.0.1183558", pools=await get_pools())
    assert price is not None
    assert price.symbol == "SAUCE"
    # reserves 7476358815713(8dp) / 4328133568240(6dp) -> 1 SAUCE = 0.01727 HBAR
    assert price.hbar == pytest.approx(Decimal("0.01727"), abs=Decimal("0.0001"))
    assert price.version == "v1"
    assert price.pool_contract_id == "0.0.2656382"


@respx.mock
async def test_unpriceable_token_returns_none_not_zero():
    """A silent zero would corrupt every portfolio weight."""
    mock_dex()
    assert await get_price("0.0.4673010", pools=await get_pools()) is None


@respx.mock
async def test_get_prices_keeps_none_entries():
    mock_dex()
    result = await get_prices(["0.0.1183558", "0.0.4673010"])
    assert set(result) == {"0.0.1183558", "0.0.4673010"}
    assert result["0.0.1183558"] is not None
    assert result["0.0.4673010"] is None


# --------------------------------------------------------------------------
# quotes
# --------------------------------------------------------------------------

@respx.mock
@pytest.mark.parametrize(
    "amount_in,expected_out,expected_impact",
    [
        ("1", "57.716486", "0.301"),
        ("10", "577.095603", "0.313"),
        ("100", "5764.039055", "0.433"),
        ("1000", "56957.704163", "1.612"),
    ],
)
async def test_v1_quote_matches_verified_values(amount_in, expected_out, expected_impact):
    """Exact outputs, cross-checked against Uniswap V2's getAmountOut.

    These agree to the raw unit with the canonical (amountIn * 997 * reserveOut)
    / (reserveIn * 1000 + amountIn * 997) reference at every trade size, which
    is why the rounding must floor rather than round half-even.
    """
    mock_dex()
    quote = await get_quote(
        "0.0.15058", "0.0.1183558", Decimal(amount_in), pools=await get_pools()
    )
    assert quote.amount_out == Decimal(expected_out)
    assert quote.price_impact_pct == pytest.approx(Decimal(expected_impact), abs=Decimal("0.001"))
    assert quote.approximate is False
    assert quote.fee_bps == 30


@respx.mock
async def test_price_impact_grows_with_trade_size():
    mock_dex()
    pools = await get_pools()
    impacts = [
        (await get_quote("0.0.15058", "0.0.1183558", Decimal(a), pools=pools)).price_impact_pct
        for a in ("1", "10", "100", "1000")
    ]
    assert impacts == sorted(impacts)


@respx.mock
async def test_quote_never_beats_mid_price():
    mock_dex()
    pools = await get_pools()
    quote = await get_quote("0.0.15058", "0.0.1183558", Decimal("100"), pools=pools)
    price = await get_price("0.0.1183558", pools=pools)
    mid_out = Decimal("100") / price.hbar
    assert quote.amount_out < mid_out


@respx.mock
async def test_v2_quote_is_flagged_approximate():
    """V2 has no tick data, so its output is an approximation."""
    mock_dex()
    quote = await get_quote("0.0.5449", "0.0.5529", Decimal("100"), pools=await get_pools())
    assert quote.version == "v2"
    assert quote.approximate is True
    assert quote.fee_bps == 5  # 500 hundredths of a bip = 0.05%
    assert quote.amount_out > 0


@respx.mock
async def test_v1_preferred_over_v2_at_similar_depth():
    """Both versions trade HBAR/SAUCE; V1 wins because V2 can only estimate."""
    mock_dex()
    quote = await get_quote("0.0.15058", "0.0.1183558", Decimal("1"), pools=await get_pools())
    assert quote.version == "v1"
    assert quote.approximate is False


@respx.mock
async def test_reverse_direction_quotes():
    mock_dex()
    quote = await get_quote("0.0.1183558", "0.0.15058", Decimal("1000"), pools=await get_pools())
    assert quote.amount_out > 0
    assert quote.token_in == "0.0.1183558"


@respx.mock
async def test_missing_pair_raises():
    mock_dex()
    with pytest.raises(PoolNotFoundError) as exc:
        await get_quote("0.0.1183558", "0.0.999999", Decimal("1"), pools=await get_pools())
    assert exc.value.token_out == "0.0.999999"


@respx.mock
async def test_min_amount_out_applies_slippage():
    mock_dex()
    quote = await get_quote("0.0.15058", "0.0.1183558", Decimal("100"), pools=await get_pools())
    assert quote.min_amount_out(Decimal("1")) == quote.amount_out * Decimal("0.99")


def test_select_pool_prefers_v1_unless_v2_much_deeper():
    from src.market.pools import _parse_v1, _parse_v2

    v1 = _parse_v1(V1_POOLS[0])
    v2 = _parse_v2(V2_POOLS[0])
    assert select_pool([v1, v2]).version == "v1"
    assert select_pool([v2]).version == "v2"
    assert select_pool([]) is None


@respx.mock
async def test_zero_output_raises_instead_of_returning_worthless_quote():
    """Acting on a silent zero would forfeit the input for nothing."""
    from src.market import NonViableQuoteError

    broken = [dict(V2_POOLS[1], sqrtRatioX96="1")]  # nonsense price
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=[]))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=broken))

    with pytest.raises(NonViableQuoteError):
        await get_quote("0.0.5449", "0.0.5529", Decimal("100"), pools=await get_pools())


@respx.mock
@pytest.mark.parametrize("amount_in", ["0.001", "0.1", "1", "10", "100", "1000", "5000"])
async def test_v1_matches_uniswap_reference_exactly(amount_in):
    """Our V1 output must equal Solidity's integer maths to the raw unit.

    Rounding half-even instead of flooring overstates the output by up to one
    unit, which is enough for an on-chain swap to revert against a
    min_amount_out derived from our own quote.
    """
    mock_dex()
    reserve_in = int(V1_POOLS[0]["tokenReserveA"])
    reserve_out = int(V1_POOLS[0]["tokenReserveB"])

    raw_in = int(Decimal(amount_in) * Decimal(10) ** 8)
    with_fee = raw_in * 997
    expected = (with_fee * reserve_out) // (reserve_in * 1000 + with_fee)

    quote = await get_quote(
        "0.0.15058", "0.0.1183558", Decimal(amount_in), pools=await get_pools()
    )
    assert int(quote.amount_out * Decimal(10) ** 6) == expected


@respx.mock
async def test_v1_quote_never_rounds_in_traders_favour():
    """Every quote must be reproducible by flooring, never by rounding up."""
    mock_dex()
    pools = await get_pools()
    reserve_in = int(V1_POOLS[0]["tokenReserveA"])
    reserve_out = int(V1_POOLS[0]["tokenReserveB"])

    for amount in ("0.7", "3.3", "17.9", "123.456"):
        quote = await get_quote("0.0.15058", "0.0.1183558", Decimal(amount), pools=pools)
        raw_in = int(Decimal(amount) * Decimal(10) ** 8)
        with_fee = raw_in * 997
        ceiling = (with_fee * reserve_out) / (reserve_in * 1000 + with_fee)
        assert int(quote.amount_out * Decimal(10) ** 6) <= ceiling
