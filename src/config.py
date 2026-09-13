"""Network configuration for Hedera mirror nodes."""

from __future__ import annotations

# Base hosts, without the /api/v1 prefix.
#
# The prefix is deliberately excluded because mirror node pagination returns
# `links.next` as an absolute path that already includes it, e.g.
#   "/api/v1/accounts/0.0.1027/tokens?limit=2&token.id=gt:0.0.2240242"
# Keeping the host bare lets us append that path directly.
MIRROR_NODE_HOSTS = {
    "testnet": "https://testnet.mirrornode.hedera.com",
    "mainnet": "https://mainnet-public.mirrornode.hedera.com",
    "previewnet": "https://previewnet.mirrornode.hedera.com",
}

API_PREFIX = "/api/v1"

DEFAULT_NETWORK = "testnet"

# HBAR is denominated in tinybars: 1 ℏ = 100,000,000 tℏ
TINYBARS_PER_HBAR = 100_000_000


def mirror_node_host(network: str) -> str:
    """Return the mirror node host for a network name.

    Raises:
        ValueError: if the network is not one of testnet/mainnet/previewnet.
    """
    try:
        return MIRROR_NODE_HOSTS[network]
    except KeyError:
        known = ", ".join(sorted(MIRROR_NODE_HOSTS))
        raise ValueError(f"Unknown network {network!r}. Expected one of: {known}") from None


# --------------------------------------------------------------------------
# SaucerSwap (DEX) — price and pool data
# --------------------------------------------------------------------------

SAUCERSWAP_HOSTS = {
    "testnet": "https://test-api.saucerswap.finance",
    "mainnet": "https://api.saucerswap.finance",
}

# There is no websocket (all wss:// variants 404) and no quote endpoint, so
# prices are polled and quotes computed locally from pool state. The API
# reports a rate limit of 10,000,000, so polling is effectively unmetered.
POOLS_CACHE_TTL_SECONDS = 10.0

# Four testnet tokens carry the symbol "HBAR". These three are the same asset
# (identical priceUsd) and must collapse into one position, or every portfolio
# weight double-counts HBAR:
#
#   0.0.0        native HBAR sentinel
#   0.0.15058    WHBAR[new] — what the pools actually trade
#   0.0.2230359  older WHBAR
#
# 0.0.8647814 also calls itself "HBAR" but prices differently: NOT an alias.
HBAR_ALIASES = frozenset({"0.0.0", "0.0.15058", "0.0.2230359"})

#: Canonical id for HBAR in pool data.
WHBAR_TOKEN_ID = "0.0.15058"


def saucerswap_host(network: str) -> str:
    """Return the SaucerSwap API host for a network name.

    Raises:
        ValueError: if the network has no SaucerSwap deployment.
    """
    try:
        return SAUCERSWAP_HOSTS[network]
    except KeyError:
        known = ", ".join(sorted(SAUCERSWAP_HOSTS))
        raise ValueError(
            f"SaucerSwap has no {network!r} deployment. Expected one of: {known}"
        ) from None


def is_hbar(token_id: str) -> bool:
    """True if this token id is native HBAR or one of its wrapped forms."""
    return token_id in HBAR_ALIASES


# Tokens pinned by ID, never by symbol: six testnet tokens are called "USDC",
# three "HBARX", four "HBAR". Symbols are not identifiers here.
CANONICAL_TESTNET_TOKENS = {
    "HBAR": WHBAR_TOKEN_ID,
    "USDC": "0.0.5449",
    "DAI": "0.0.5529",
    "SAUCE": "0.0.1183558",
    "CLXY": "0.0.5365",
    "HBARX": "0.0.2231533",
}


def resolve_symbol(symbol: str, network: str = DEFAULT_NETWORK) -> str | None:
    """Map a user-facing symbol to its pinned token id, or None if unknown.

    This is the only sanctioned symbol lookup in the codebase. Six testnet
    tokens call themselves "USDC" and four "HBAR", so resolving a symbol
    anywhere else -- against pool data, say -- would pick an arbitrary one.
    Users speak in symbols; everything past this boundary uses ids.
    """
    if network != "testnet":
        return None
    return CANONICAL_TESTNET_TOKENS.get(symbol.strip().upper())


def known_symbols(network: str = DEFAULT_NETWORK) -> list[str]:
    """Symbols a user may name in a strategy, for prompts and error messages."""
    if network != "testnet":
        return []
    return sorted(CANONICAL_TESTNET_TOKENS)
