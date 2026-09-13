"""Thin async wrapper over the Hedera mirror node REST API.

Reads are free and unauthenticated — no operator key, no gas, no SDK. That is
why the whole portfolio layer sits on this rather than on AccountBalanceQuery.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

import httpx

from src.config import DEFAULT_NETWORK, mirror_node_host
from src.portfolio.errors import (
    MirrorNodeRequestError,
    MirrorNodeUnavailableError,
    ResourceNotFoundError,
)

# Status codes worth retrying: rate limiting and transient server faults.
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


class MirrorNodeClient:
    """Async client for one Hedera network's mirror node.

    Usable as an async context manager, or with an injected httpx client when
    the caller wants to control connection pooling:

        async with MirrorNodeClient("testnet") as mn:
            account = await mn.get_json("/api/v1/accounts/0.0.1027")
    """

    def __init__(
        self,
        network: str = DEFAULT_NETWORK,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 10.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
    ):
        self.network = network
        self.host = mirror_node_host(network)
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> "MirrorNodeClient":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("MirrorNodeClient used outside an async context manager")
        return self._client

    async def get_json(self, path: str) -> dict[str, Any]:
        """GET a mirror node path, retrying transient failures.

        Args:
            path: absolute API path including the /api/v1 prefix, e.g.
                "/api/v1/accounts/0.0.1027". Pagination cursors from
                `links.next` are already in this form and can be passed
                straight through.

        Raises:
            ResourceNotFoundError: the mirror node returned 404.
            MirrorNodeUnavailableError: still failing after max_retries.
        """
        url = f"{self.host}{path}"
        last_error: Exception | None = None

        for attempt in range(self.max_retries):
            try:
                response = await self.client.get(url)
            except httpx.RequestError as exc:  # DNS, connect, read timeouts
                last_error = exc
            else:
                if response.status_code == 404:
                    raise ResourceNotFoundError(path, self.network)
                if response.status_code not in RETRYABLE_STATUS:
                    # Every failure leaves as a typed MirrorNodeError. A raw
                    # httpx.HTTPStatusError would escape callers that catch the
                    # documented base class -- including the Agent Kit tool,
                    # which would surface a traceback to the LLM instead of a
                    # usable message. A 400 is what the mirror node returns for
                    # a malformed address, which an LLM can easily produce.
                    if response.status_code >= 400:
                        raise MirrorNodeRequestError(
                            path, self.network, response.status_code
                        )
                    return response.json()
                last_error = httpx.HTTPStatusError(
                    f"{response.status_code} from mirror node",
                    request=response.request,
                    response=response,
                )

            # Exponential backoff, skipped after the final attempt.
            if attempt < self.max_retries - 1:
                await asyncio.sleep(self.backoff_base * (2**attempt))

        raise MirrorNodeUnavailableError(
            f"Mirror node failed after {self.max_retries} attempts: {path}"
        ) from last_error

    async def paginate(self, path: str, key: str) -> AsyncIterator[dict[str, Any]]:
        """Yield every item under `key`, following `links.next` to exhaustion.

        The mirror node returns cursors like
        "/api/v1/accounts/0.0.1027/tokens?limit=2&token.id=gt:0.0.2240242",
        so each page's next link is fetched verbatim.
        """
        next_path: str | None = path
        while next_path:
            payload = await self.get_json(next_path)
            for item in payload.get(key, []):
                yield item
            next_path = (payload.get("links") or {}).get("next")
