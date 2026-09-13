"""Market data from SaucerSwap: pool state, spot prices and swap quotes.

Read-only and credential-free, like src/portfolio. Prices and quotes are both
derived from the same pool snapshot, so they can never disagree.

    from src.market import get_pools, get_price, get_quote

    pools = await get_pools()                      # quality-filtered
    price = await get_price("0.0.1183558", pools=pools)
    quote = await get_quote("0.0.15058", "0.0.1183558", Decimal("100"), pools=pools)
"""

from src.market.errors import (
    InsufficientLiquidityError,
    MarketDataError,
    NonViableQuoteError,
    PoolNotFoundError,
    SaucerSwapRequestError,
    SaucerSwapUnavailableError,
    TokenNotPricedError,
)
from src.market.models import Pool, PoolToken, Price, PoolVersion, Quote
from src.market.pools import (
    find_pools_for_pair,
    find_pools_for_token,
    get_pools,
    is_quality_pool,
    rank_pools,
    select_pool,
)
from src.market.prices import get_price, get_prices, pool_spot_price
from src.market.quotes import get_quote, quote_v1, quote_v2

__all__ = [
    # data
    "get_pools",
    "get_price",
    "get_prices",
    "get_quote",
    # models
    "Pool",
    "PoolToken",
    "PoolVersion",
    "Price",
    "Quote",
    # helpers
    "find_pools_for_pair",
    "find_pools_for_token",
    "is_quality_pool",
    "rank_pools",
    "select_pool",
    "pool_spot_price",
    "quote_v1",
    "quote_v2",
    # errors
    "InsufficientLiquidityError",
    "MarketDataError",
    "NonViableQuoteError",
    "PoolNotFoundError",
    "SaucerSwapRequestError",
    "SaucerSwapUnavailableError",
    "TokenNotPricedError",
]
