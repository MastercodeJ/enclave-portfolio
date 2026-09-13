"""Value objects for SaucerSwap pools, prices and quotes."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from src.formatting import trim_decimal
from typing import Literal

PoolVersion = Literal["v1", "v2"]


def _round(value: Decimal, places: int) -> Decimal:
    """Trim a Decimal for display only. Never use for arithmetic."""
    return trim_decimal(value, places)


@dataclass(frozen=True)
class PoolToken:
    """One side of a pool, as SaucerSwap describes it."""

    token_id: str
    symbol: str
    name: str
    decimals: int
    price_usd: Decimal | None
    due_diligence_complete: bool
    fee_on_transfer: bool

    @property
    def priced(self) -> bool:
        return self.price_usd is not None and self.price_usd > 0


@dataclass(frozen=True)
class Pool:
    """A liquidity pool, in either AMM version.

    V1 is constant product (Uniswap V2 style): price comes from the reserves.
    V2 is concentrated liquidity (Uniswap V3 style): price comes from
    `sqrt_ratio_x96`, and `liquidity` bounds how much can trade in the
    current tick.
    """

    contract_id: str
    version: PoolVersion
    token_a: PoolToken
    token_b: PoolToken
    reserve_a: int  # raw units
    reserve_b: int  # raw units
    fee_bps: int  # 30 = 0.30%
    # V2 only:
    sqrt_ratio_x96: int | None = None
    tick_current: int | None = None
    liquidity: int | None = None

    @property
    def token_ids(self) -> tuple[str, str]:
        return (self.token_a.token_id, self.token_b.token_id)

    @property
    def has_liquidity(self) -> bool:
        """Whether this pool can actually be priced and traded against.

        A V2 pool needs sqrt_ratio_x96 as well as liquidity: without it both
        the spot price and the quote fall back to zero, so the pool would pass
        the quality filter, outrank real pools by TVL, and then price nothing.
        """
        if self.version == "v2":
            return bool(self.liquidity and self.liquidity > 0 and self.sqrt_ratio_x96)
        return self.reserve_a > 0 and self.reserve_b > 0

    @property
    def tvl_usd(self) -> Decimal:
        """Approximate USD value of both sides. Zero if either side is unpriced."""
        total = Decimal(0)
        for reserve, token in ((self.reserve_a, self.token_a), (self.reserve_b, self.token_b)):
            if token.price_usd is None:
                return Decimal(0)
            amount = Decimal(reserve) / (Decimal(10) ** token.decimals)
            total += amount * token.price_usd
        return total

    def other_side(self, token_id: str) -> PoolToken:
        """Return the token on the opposite side of the given one."""
        if token_id == self.token_a.token_id:
            return self.token_b
        if token_id == self.token_b.token_id:
            return self.token_a
        raise ValueError(f"{token_id} is not in pool {self.contract_id}")

    def __str__(self) -> str:
        return (
            f"{self.token_a.symbol}/{self.token_b.symbol} "
            f"[{self.version}] {self.contract_id} fee={self.fee_bps / 100:.2f}%"
        )


@dataclass(frozen=True)
class Price:
    """A token's spot price, derived from a specific pool.

    `pool_contract_id` and `version` are kept so a price can always be traced
    back to the pool that produced it — spot prices from different pools for
    the same token legitimately differ.
    """

    token_id: str
    symbol: str | None
    hbar: Decimal
    usd: Decimal | None
    pool_contract_id: str
    version: PoolVersion
    fetched_at: datetime

    def __str__(self) -> str:
        usd = f" (${_round(self.usd, 6)})" if self.usd is not None else ""
        return f"{self.symbol or self.token_id} = {_round(self.hbar, 8)} HBAR{usd}"


@dataclass(frozen=True)
class Quote:
    """What a swap would actually return, fee and price impact included.

    `approximate` is True for every V2 quote: SaucerSwap's API never returns
    tick data, so a V2 quote assumes liquidity is constant across the trade.
    That holds for small trades inside the current tick and degrades as the
    trade grows.
    """

    token_in: str
    token_out: str
    amount_in: Decimal
    amount_out: Decimal
    fee_bps: int
    price_impact_pct: Decimal
    pool_contract_id: str
    version: PoolVersion
    approximate: bool
    fetched_at: datetime

    @property
    def effective_price(self) -> Decimal:
        """Units of token_out actually received per unit of token_in."""
        if self.amount_in == 0:
            return Decimal(0)
        return self.amount_out / self.amount_in

    def min_amount_out(self, slippage_pct: Decimal) -> Decimal:
        """Floor for a swap's minimum-out parameter."""
        return self.amount_out * (Decimal(1) - slippage_pct / Decimal(100))

    def __str__(self) -> str:
        approx = " ~approx" if self.approximate else ""
        return (
            f"{_round(self.amount_in, 6)} -> {_round(self.amount_out, 6)} "
            f"(impact {self.price_impact_pct:.3f}%, fee {self.fee_bps / 100:.2f}%, "
            f"{self.version} {self.pool_contract_id}{approx})"
        )
