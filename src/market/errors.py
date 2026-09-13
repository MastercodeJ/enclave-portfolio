"""Typed errors for market data access."""

from __future__ import annotations


class MarketDataError(RuntimeError):
    """Base class for all SaucerSwap data failures."""


class SaucerSwapUnavailableError(MarketDataError):
    """The SaucerSwap API kept failing after the configured retries."""


class PoolNotFoundError(MarketDataError):
    """No qualifying pool exists for the requested pair."""

    def __init__(self, token_in: str, token_out: str, network: str):
        self.token_in = token_in
        self.token_out = token_out
        self.network = network
        super().__init__(
            f"No qualifying pool for {token_in} -> {token_out} on {network}"
        )


class TokenNotPricedError(MarketDataError):
    """A token has no pool with liquidity, so no price can be derived.

    Callers should treat an unpriceable token as excluded from portfolio
    weights rather than valuing it at zero.
    """

    def __init__(self, token_id: str, network: str):
        self.token_id = token_id
        self.network = network
        super().__init__(f"No priceable pool for token {token_id} on {network}")


class NonViableQuoteError(MarketDataError):
    """A pool with liquidity produced a zero output.

    Signals corrupt pool data or an input so small it rounds away. Either way
    the swap would forfeit the input for nothing, so it is raised rather than
    returned as a zero-valued quote.
    """

    def __init__(self, token_in: str, token_out: str, amount_in, pool_contract_id: str):
        self.token_in = token_in
        self.token_out = token_out
        self.amount_in = amount_in
        self.pool_contract_id = pool_contract_id
        super().__init__(
            f"Pool {pool_contract_id} returned zero output for "
            f"{amount_in} {token_in} -> {token_out}"
        )


class InsufficientLiquidityError(MarketDataError):
    """The trade would take more of the output token than the pool holds.

    Raised mainly for V2 pools: without tick data the single-tick
    approximation assumes liquidity continues indefinitely, so it will happily
    quote more than exists while still reporting a small price impact.
    """

    def __init__(
        self,
        token_in: str,
        token_out: str,
        amount_in,
        amount_out,
        available,
        pool_contract_id: str,
    ):
        self.token_in = token_in
        self.token_out = token_out
        self.amount_in = amount_in
        self.amount_out = amount_out
        self.available = available
        self.pool_contract_id = pool_contract_id
        super().__init__(
            f"Pool {pool_contract_id} holds {available} {token_out} but the quote "
            f"for {amount_in} {token_in} needs {amount_out}"
        )


class SaucerSwapRequestError(MarketDataError):
    """SaucerSwap rejected the request (a 4xx)."""

    def __init__(self, path: str, network: str, status_code: int):
        self.path = path
        self.network = network
        self.status_code = status_code
        super().__init__(f"SaucerSwap returned {status_code} for {path} on {network}")
