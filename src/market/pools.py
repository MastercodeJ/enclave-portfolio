"""Fetch, parse and filter SaucerSwap pools."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import httpx

from src.config import DEFAULT_NETWORK, is_hbar
from src.market.client import SaucerSwapClient
from src.market.errors import MarketDataError
from src.market.models import Pool, PoolToken

# V1 is a fixed-fee constant product AMM: 0.30% on every pool.
V1_FEE_BPS = 30

# V2 quotes fees in hundredths of a basis point (1e-6), so 3000 -> 30 bps.
V2_FEE_DIVISOR = 100

# Above this share of unparseable pools, assume the feed is broken rather than
# the individual entries.
MAX_PARSE_FAILURE_RATIO = 0.5


def _parse_token(raw: dict[str, Any]) -> PoolToken:
    """Parse one side of a pool.

    `dueDiligenceComplete` arrives as 1/0 from /pools but true/false from
    /tokens, and `priceUsd` is sometimes a float and sometimes a string, so
    both are coerced here rather than at every call site.
    """
    price_usd = raw.get("priceUsd")
    try:
        parsed_price = Decimal(str(price_usd)) if price_usd is not None else None
    except Exception:
        parsed_price = None  # "NaN" appears on dead LP tokens

    return PoolToken(
        token_id=str(raw["id"]),
        symbol=str(raw.get("symbol") or ""),
        name=str(raw.get("name") or ""),
        decimals=int(raw.get("decimals") or 0),
        price_usd=parsed_price,
        due_diligence_complete=bool(raw.get("dueDiligenceComplete")),
        fee_on_transfer=bool(raw.get("isFeeOnTransferToken")),
    )


def _parse_v1(raw: dict[str, Any]) -> Pool:
    return Pool(
        contract_id=str(raw["contractId"]),
        version="v1",
        token_a=_parse_token(raw["tokenA"]),
        token_b=_parse_token(raw["tokenB"]),
        reserve_a=int(raw.get("tokenReserveA") or 0),
        reserve_b=int(raw.get("tokenReserveB") or 0),
        fee_bps=V1_FEE_BPS,
    )


def _parse_v2(raw: dict[str, Any]) -> Pool:
    return Pool(
        contract_id=str(raw["contractId"]),
        version="v2",
        token_a=_parse_token(raw["tokenA"]),
        token_b=_parse_token(raw["tokenB"]),
        reserve_a=int(raw.get("amountA") or 0),
        reserve_b=int(raw.get("amountB") or 0),
        fee_bps=int(raw.get("fee") or 0) // V2_FEE_DIVISOR,
        sqrt_ratio_x96=int(raw["sqrtRatioX96"]) if raw.get("sqrtRatioX96") else None,
        tick_current=raw.get("tickCurrent"),
        liquidity=int(raw["liquidity"]) if raw.get("liquidity") else None,
    )


def is_quality_pool(pool: Pool) -> bool:
    """Whether a pool is safe for an agent to price or trade against.

    Testnet is full of fabricated tokens. The largest pool by computed TVL is
    a "CTK/LTK" pair claiming $5.9 billion, while SaucerSwap's own /stats puts
    the entire network at roughly $683,000. Ranking pools by TVL alone would
    point the agent straight at it.

    Four conditions, all necessary:
      - both sides pass SaucerSwap's due diligence flag
      - both sides have a non-zero price (a zero price means a dead market)
      - the pool actually holds liquidity
      - neither side charges a transfer fee

    That last one matters because a fee-on-transfer token delivers strictly
    less than the AMM computes, so `Quote.min_amount_out()` derived from our
    own quote would be unreachable and the swap would revert -- or, with no
    min-out set, the caller silently receives less than quoted. The pool data
    does not say how large the transfer fee is, so the amount cannot be
    corrected for; excluding the pool is the only honest option.
    """
    if not pool.has_liquidity:
        return False
    for token in (pool.token_a, pool.token_b):
        if not token.due_diligence_complete or not token.priced:
            return False
        if token.fee_on_transfer:
            return False
    return True


async def get_pools(
    network: str = DEFAULT_NETWORK,
    *,
    quality_only: bool = True,
    versions: tuple[str, ...] = ("v1", "v2"),
    client: httpx.AsyncClient | None = None,
) -> list[Pool]:
    """Fetch pools from both AMM versions.

    Args:
        network: testnet or mainnet.
        quality_only: apply `is_quality_pool`. Leave this on for anything the
            agent acts upon; turn it off only to inspect raw market state.
        versions: which AMM versions to include.
        client: optional httpx client to reuse.

    Returns:
        Pools sorted by descending USD TVL.
    """
    pools: list[Pool] = []
    seen = 0
    failed = 0

    async with SaucerSwapClient(network, client=client) as dex:
        for version, path, parse in (
            ("v1", "/pools", _parse_v1),
            ("v2", "/v2/pools", _parse_v2),
        ):
            if version not in versions:
                continue
            for raw in await dex.get_json(path):
                seen += 1
                try:
                    pools.append(parse(raw))
                except (KeyError, TypeError, ValueError):
                    failed += 1  # one malformed entry should not fail the batch

    # A handful of malformed entries is normal on testnet, but losing most of
    # them means the API's shape changed. Left silent, get_pools() would return
    # [] and every token would look untradable rather than the feed looking
    # broken -- a much harder failure to diagnose on a money path.
    if seen and failed / seen > MAX_PARSE_FAILURE_RATIO:
        raise MarketDataError(
            f"Could not parse {failed} of {seen} pools from SaucerSwap "
            f"({network}). The API response shape has likely changed."
        )

    if quality_only:
        pools = [p for p in pools if is_quality_pool(p)]

    pools.sort(key=lambda p: p.tvl_usd, reverse=True)
    return pools


def _matches(pool_token_id: str, wanted: str) -> bool:
    """Match token ids, treating every HBAR/WHBAR alias as the same asset."""
    if pool_token_id == wanted:
        return True
    return is_hbar(pool_token_id) and is_hbar(wanted)


def find_pools_for_pair(pools: list[Pool], token_x: str, token_y: str) -> list[Pool]:
    """Every pool trading this pair, deepest first.

    Order is unimportant: a pool matches whether the pair appears as A/B or
    B/A.
    """
    matched = [
        pool
        for pool in pools
        if (_matches(pool.token_a.token_id, token_x) and _matches(pool.token_b.token_id, token_y))
        or (_matches(pool.token_a.token_id, token_y) and _matches(pool.token_b.token_id, token_x))
    ]
    matched.sort(key=lambda p: p.tvl_usd, reverse=True)
    return matched


def find_pools_for_token(pools: list[Pool], token_id: str) -> list[Pool]:
    """Every pool holding this token, deepest first."""
    matched = [
        pool
        for pool in pools
        if _matches(pool.token_a.token_id, token_id) or _matches(pool.token_b.token_id, token_id)
    ]
    matched.sort(key=lambda p: p.tvl_usd, reverse=True)
    return matched


def rank_pools(pools: list[Pool]) -> list[Pool]:
    """Order candidates by preference, best first.

    V1 is preferred over V2 at comparable depth: SaucerSwap's API never
    returns tick data, so a V2 quote can only approximate. A V2 pool still
    wins if it is more than twice as deep, where the extra liquidity
    outweighs the approximation.

    Callers should walk this list rather than taking only the head, so that a
    single malformed pool does not hide a healthy one behind it.
    """
    # Sorted here rather than assumed: this is exported, and silently
    # depending on the caller having sorted first would make it return the
    # shallower pool without complaint.
    ranked = sorted(pools, key=lambda p: p.tvl_usd, reverse=True)

    v1 = [p for p in ranked if p.version == "v1"]
    v2 = [p for p in ranked if p.version == "v2"]

    if v1 and v2 and v2[0].tvl_usd > v1[0].tvl_usd * 2:
        return v2 + v1
    return v1 + v2


def select_pool(pools: list[Pool]) -> Pool | None:
    """The single best pool from candidates, or None if there are none.

    Prefer `rank_pools` where a fallback is possible.
    """
    ranked = rank_pools(pools)
    return ranked[0] if ranked else None
