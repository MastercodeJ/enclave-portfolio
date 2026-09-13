"""Read an account's HBAR and fungible HTS token balances."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import httpx

from src.config import API_PREFIX, DEFAULT_NETWORK, TINYBARS_PER_HBAR
from src.portfolio.errors import AccountNotFoundError, ResourceNotFoundError
from src.portfolio.mirror_client import MirrorNodeClient
from src.portfolio.models import AccountBalance, TokenBalance

# Mirror node caps page size at 100 for these collections.
PAGE_SIZE = 100

# Bound on concurrent token-metadata lookups, to stay polite with the
# public mirror node while still collapsing the N+1 into one round of fanout.
METADATA_CONCURRENCY = 10

NON_FUNGIBLE = "NON_FUNGIBLE_UNIQUE"


async def get_account_balance(
    address: str,
    network: str = DEFAULT_NETWORK,
    *,
    include_zero: bool = False,
    resolve_symbols: bool = True,
    client: httpx.AsyncClient | None = None,
) -> AccountBalance:
    """Return HBAR plus every fungible HTS token held by `address`.

    Args:
        address: Hedera account id ("0.0.1027") or EVM address ("0x...").
            The mirror node resolves both, so no client-side parsing is needed.
        network: testnet (default), mainnet, or previewnet.
        include_zero: keep positions whose balance is 0. Off by default —
            associated-but-empty tokens are noise for a rebalancer.
        resolve_symbols: fetch token metadata for symbol/name. Required to
            filter NFTs reliably; see the note below.
        client: optional httpx client to reuse.

    Raises:
        AccountNotFoundError: no such account on this network.
        MirrorNodeUnavailableError: mirror node failed after retries.

    Note:
        A token's `type` only comes from its metadata. Where metadata is
        unavailable -- either because resolve_symbols is off, or because the
        token was deleted after this account associated with it -- NFTs are
        filtered by the weaker `decimals == 0` heuristic, which also drops the
        rare zero-decimal fungible token. Prefer the default unless you only
        need raw amounts on a hot path.
    """
    async with MirrorNodeClient(network, client=client) as mirror:
        try:
            account = await mirror.get_json(f"{API_PREFIX}/accounts/{address}")
        except ResourceNotFoundError:
            raise AccountNotFoundError(address, network) from None

        # The account payload also carries a `balance.tokens` list, but it has
        # no `decimals` and reflects a lagging snapshot, so the /tokens
        # sub-resource is used for positions instead.
        account_id = account["account"]
        tinybars = int((account.get("balance") or {}).get("balance") or 0)

        rows = [
            row
            async for row in mirror.paginate(
                f"{API_PREFIX}/accounts/{address}/tokens?limit={PAGE_SIZE}",
                key="tokens",
            )
        ]

        if not include_zero:
            rows = [r for r in rows if int(r.get("balance") or 0) != 0]

        metadata: dict[str, dict[str, Any]] = {}
        if resolve_symbols and rows:
            metadata = await _fetch_token_metadata(
                mirror, {r["token_id"] for r in rows}
            )

    tokens = [
        token
        for row in rows
        if (token := _build_token(row, metadata.get(row["token_id"])))
        is not None
    ]
    tokens.sort(key=lambda t: t.amount, reverse=True)

    return AccountBalance(
        account_id=account_id,
        evm_address=account.get("evm_address"),
        hbar_tinybars=tinybars,
        hbar=Decimal(tinybars) / Decimal(TINYBARS_PER_HBAR),
        tokens=tokens,
        network=network,
        fetched_at=datetime.now(timezone.utc),
    )


async def _fetch_token_metadata(
    mirror: MirrorNodeClient, token_ids: set[str]
) -> dict[str, dict[str, Any]]:
    """Fetch /tokens/{id} for each distinct token, concurrently.

    Token metadata is what supplies `symbol`, `name` and — critically — `type`,
    none of which appear on the account's token sub-resource.
    """
    semaphore = asyncio.Semaphore(METADATA_CONCURRENCY)

    async def fetch(token_id: str) -> tuple[str, dict[str, Any] | None]:
        async with semaphore:
            try:
                return token_id, await mirror.get_json(f"{API_PREFIX}/tokens/{token_id}")
            except ResourceNotFoundError:
                # A deleted token can still appear in an account's list.
                return token_id, None

    results = await asyncio.gather(*(fetch(tid) for tid in token_ids))
    return {tid: meta for tid, meta in results if meta is not None}


def _build_token(
    row: dict[str, Any],
    meta: dict[str, Any] | None,
) -> TokenBalance | None:
    """Turn one balance row plus its metadata into a TokenBalance.

    Returns None for non-fungible tokens, which a portfolio rebalancer has no
    use for, and for any token whose type cannot be established.
    """
    if meta is not None:
        if meta.get("type") == NON_FUNGIBLE:
            return None
    elif int(row.get("decimals") or 0) == 0:
        # No metadata, so the token type is unknown -- either resolve_symbols
        # is off, or the token was deleted after this account associated with
        # it. NFTs always carry zero decimals, so that is the only signal left.
        # This also drops the rare zero-decimal fungible token, which is the
        # safer error: a rebalancer treating an NFT as a tradable position is
        # worse than ignoring one obscure asset.
        return None

    # `decimals` arrives as an int on the account sub-resource but as a string
    # on token metadata, so both paths are coerced. Metadata is legitimately
    # absent for deleted tokens, so it is never dereferenced blindly.
    row_decimals = row.get("decimals")
    meta_decimals = (meta or {}).get("decimals")
    if row_decimals is not None:
        decimals = int(row_decimals)
    elif meta_decimals is not None:
        decimals = int(meta_decimals)
    else:
        decimals = 0
    raw = int(row.get("balance") or 0)

    return TokenBalance(
        token_id=row["token_id"],
        raw_balance=raw,
        decimals=decimals,
        amount=Decimal(raw).scaleb(-decimals),
        symbol=(meta or {}).get("symbol"),
        name=(meta or {}).get("name"),
        frozen=row.get("freeze_status") == "FROZEN",
        kyc_revoked=row.get("kyc_status") == "REVOKED",
        auto_associated=bool(row.get("automatic_association")),
    )
