"""Thin async wrapper over the SaucerSwap REST API.

Mirrors src/portfolio/mirror_client.py: async context manager, injectable
httpx client, exponential backoff on transient failures, typed errors. The
differences are that these endpoints return whole lists (no pagination) and
that responses are cached briefly, because a rebalance cycle asks for pool
state several times in a row.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from src.config import POOLS_CACHE_TTL_SECONDS, saucerswap_host
from src.market.errors import SaucerSwapRequestError, SaucerSwapUnavailableError

RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

USER_AGENT = "defi-copilot/0.1"

# Shared across instances, keyed by (host, path). get_pools() constructs a
# fresh client per call, so a per-instance cache could never register a hit --
# and the two endpoints it fetches would drift apart between calls, breaking
# the guarantee that a price and a quote describe the same pool snapshot.
_RESPONSE_CACHE: dict[tuple[str, str], tuple[float, Any]] = {}


class SaucerSwapClient:
    """Async client for one network's SaucerSwap API.

        async with SaucerSwapClient("testnet") as dex:
            pools = await dex.get_json("/pools")
    """

    def __init__(
        self,
        network: str = "testnet",
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 15.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        cache_ttl: float = POOLS_CACHE_TTL_SECONDS,
    ):
        self.network = network
        self.host = saucerswap_host(network)
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.cache_ttl = cache_ttl
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> "SaucerSwapClient":
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self.timeout, headers={"User-Agent": USER_AGENT}
            )
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("SaucerSwapClient used outside an async context manager")
        return self._client

    async def get_json(self, path: str, *, use_cache: bool = True) -> Any:
        """GET a SaucerSwap path, retrying transient failures.

        Args:
            path: API path such as "/pools" or "/v2/pools".
            use_cache: serve from the short TTL cache when fresh. Pool state
                moves slowly relative to a rebalance cycle, and the API's rate
                limit is effectively unmetered, so this is about consistency
                within one decision rather than about saving requests.

        Raises:
            SaucerSwapUnavailableError: still failing after max_retries.
        """
        cache_key = (self.host, path)
        if use_cache and self.cache_ttl > 0:
            cached = _RESPONSE_CACHE.get(cache_key)
            if cached is not None and (time.monotonic() - cached[0]) < self.cache_ttl:
                return cached[1]

        url = f"{self.host}{path}"
        last_error: Exception | None = None

        for attempt in range(self.max_retries):
            try:
                response = await self.client.get(url)
            except httpx.RequestError as exc:
                last_error = exc
            else:
                if response.status_code not in RETRYABLE_STATUS:
                    # Typed, for the same reason as the mirror node client:
                    # callers catch MarketDataError, not httpx exceptions.
                    if response.status_code >= 400:
                        raise SaucerSwapRequestError(path, self.network, response.status_code)
                    payload = response.json()
                    if use_cache and self.cache_ttl > 0:
                        _RESPONSE_CACHE[cache_key] = (time.monotonic(), payload)
                    return payload
                last_error = httpx.HTTPStatusError(
                    f"{response.status_code} from SaucerSwap",
                    request=response.request,
                    response=response,
                )

            if attempt < self.max_retries - 1:
                await asyncio.sleep(self.backoff_base * (2**attempt))

        raise SaucerSwapUnavailableError(
            f"SaucerSwap API failed after {self.max_retries} attempts: {path}"
        ) from last_error

    @staticmethod
    def clear_cache() -> None:
        """Drop cached payloads, forcing the next call to hit the network."""
        _RESPONSE_CACHE.clear()
