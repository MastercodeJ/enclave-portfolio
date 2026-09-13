"""Unit tests for get_account_balance — fully mocked, no network."""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest
import respx

from src.portfolio import AccountNotFoundError, get_account_balance

HOST = "https://testnet.mirrornode.hedera.com"

# Shapes below mirror real testnet responses captured during planning.
ACCOUNT = {
    "account": "0.0.1027",
    "evm_address": "0x0000000000000000000000000000000000000403",
    "balance": {
        "balance": 3646199249,  # tinybars
        "timestamp": "1729114693.552030631",
        "tokens": [{"token_id": "0.0.2240242", "balance": 45610999}],
    },
    "max_automatic_token_associations": 0,
}

# decimals is an int on the account sub-resource...
TOKEN_ROWS_PAGE_1 = {
    "tokens": [
        {
            "token_id": "0.0.2240242",
            "balance": 45610999,
            "decimals": 6,
            "freeze_status": "NOT_APPLICABLE",
            "kyc_status": "NOT_APPLICABLE",
            "automatic_association": False,
        },
        {
            "token_id": "0.0.3678227",
            "balance": 0,  # zero — filtered out by default
            "decimals": 0,
            "freeze_status": "NOT_APPLICABLE",
            "kyc_status": "NOT_APPLICABLE",
            "automatic_association": False,
        },
    ],
    "links": {"next": "/api/v1/accounts/0.0.1027/tokens?limit=100&token.id=gt:0.0.3678227"},
}

TOKEN_ROWS_PAGE_2 = {
    "tokens": [
        {
            "token_id": "0.0.2212736",
            "balance": 16,
            "decimals": 0,
            "freeze_status": "NOT_APPLICABLE",
            "kyc_status": "NOT_APPLICABLE",
            "automatic_association": False,
        },
        {
            "token_id": "0.0.9999001",
            "balance": 500,
            "decimals": 2,
            "freeze_status": "FROZEN",
            "kyc_status": "REVOKED",
            "automatic_association": True,
        },
    ],
    "links": {"next": None},
}

# ...but a string on token metadata. Both paths must be coerced to int.
TOKEN_META = {
    "0.0.2240242": {"token_id": "0.0.2240242", "symbol": "USDC", "name": "USDC",
                    "decimals": "6", "type": "FUNGIBLE_COMMON"},
    "0.0.2212736": {"token_id": "0.0.2212736", "symbol": "NFTX", "name": "Some NFT",
                    "decimals": "0", "type": "NON_FUNGIBLE_UNIQUE"},
    "0.0.9999001": {"token_id": "0.0.9999001", "symbol": "GATED", "name": "Gated Token",
                    "decimals": "2", "type": "FUNGIBLE_COMMON"},
    # Zero-balance position — only fetched when include_zero=True.
    "0.0.3678227": {"token_id": "0.0.3678227", "symbol": "EMPTY", "name": "Empty Token",
                    "decimals": "0", "type": "FUNGIBLE_COMMON"},
}


def mock_mirror_node(account: dict | None = None) -> None:
    """Register the standard three-endpoint mock set.

    The tokens route is registered before the account route because the account
    route is end-anchored and must not swallow sub-resource URLs.
    """
    respx.get(url__regex=rf"{HOST}/api/v1/accounts/[^/]+/tokens.*").mock(
        side_effect=[
            httpx.Response(200, json=TOKEN_ROWS_PAGE_1),
            httpx.Response(200, json=TOKEN_ROWS_PAGE_2),
        ]
    )
    respx.get(url__regex=rf"{HOST}/api/v1/accounts/[^/]+$").mock(
        return_value=httpx.Response(200, json=account or ACCOUNT)
    )

    def token_meta(request: httpx.Request) -> httpx.Response:
        token_id = str(request.url).rsplit("/", 1)[-1]
        return httpx.Response(200, json=TOKEN_META[token_id])

    respx.get(url__regex=rf"{HOST}/api/v1/tokens/.*").mock(side_effect=token_meta)


@respx.mock
async def test_returns_hbar_balance():
    mock_mirror_node()
    balance = await get_account_balance("0.0.1027")

    assert balance.account_id == "0.0.1027"
    assert balance.network == "testnet"
    assert balance.evm_address == "0x0000000000000000000000000000000000000403"
    # 3646199249 tinybars = 36.46199249 HBAR
    assert balance.hbar_tinybars == 3646199249
    assert balance.hbar == Decimal("36.46199249")


@respx.mock
async def test_scales_decimals_without_losing_precision():
    mock_mirror_node()
    usdc = (await get_account_balance("0.0.1027")).token("0.0.2240242")

    assert usdc is not None
    assert usdc.symbol == "USDC"
    assert usdc.raw_balance == 45610999
    assert usdc.decimals == 6
    assert usdc.amount == Decimal("45.610999")
    assert isinstance(usdc.amount, Decimal)  # exact arithmetic, never float


@respx.mock
async def test_filters_nfts_by_type_not_by_decimals():
    mock_mirror_node()
    token_ids = {t.token_id for t in (await get_account_balance("0.0.1027")).tokens}

    # 0.0.2212736 is NON_FUNGIBLE_UNIQUE and must be dropped...
    assert "0.0.2212736" not in token_ids
    # ...while 0.0.9999001 is fungible and kept despite having few decimals.
    assert "0.0.9999001" in token_ids


@respx.mock
async def test_filters_zero_balances_by_default():
    mock_mirror_node()
    balance = await get_account_balance("0.0.1027")

    assert all(t.raw_balance != 0 for t in balance.tokens)
    assert balance.token("0.0.3678227") is None


@respx.mock
async def test_include_zero_keeps_empty_positions():
    mock_mirror_node()
    balance = await get_account_balance("0.0.1027", include_zero=True)
    assert balance.token("0.0.3678227") is not None


@respx.mock
async def test_surfaces_compliance_flags():
    mock_mirror_node()
    gated = (await get_account_balance("0.0.1027")).token("0.0.9999001")

    assert gated is not None
    assert gated.frozen is True
    assert gated.kyc_revoked is True
    assert gated.transferable is False
    assert gated.auto_associated is True


@respx.mock
async def test_decimals_is_always_int():
    """Metadata returns decimals as a string; the model must never leak that."""
    mock_mirror_node()
    tokens = (await get_account_balance("0.0.1027")).tokens

    assert tokens, "expected at least one token position"
    assert all(isinstance(t.decimals, int) for t in tokens)


@respx.mock
async def test_follows_pagination_to_exhaustion():
    mock_mirror_node()
    balance = await get_account_balance("0.0.1027")
    # 0.0.9999001 only exists on page 2 — absent unless the cursor was followed.
    assert balance.token("0.0.9999001") is not None


@respx.mock
async def test_accepts_evm_address():
    mock_mirror_node()
    balance = await get_account_balance("0x0000000000000000000000000000000000000403")
    # The mirror node resolves the alias; we always report the 0.0.x form.
    assert balance.account_id == "0.0.1027"


@respx.mock
async def test_sorted_by_amount_descending():
    mock_mirror_node()
    amounts = [t.amount for t in (await get_account_balance("0.0.1027")).tokens]
    assert amounts == sorted(amounts, reverse=True)


@respx.mock
async def test_unknown_account_raises_typed_error():
    respx.get(url__regex=rf"{HOST}/api/v1/accounts/.*").mock(
        return_value=httpx.Response(404, json={"_status": {"messages": [{"message": "Not found"}]}})
    )

    with pytest.raises(AccountNotFoundError) as exc:
        await get_account_balance("0.0.999999999")

    assert exc.value.address == "0.0.999999999"
    assert exc.value.network == "testnet"


@respx.mock
async def test_retries_then_succeeds_on_rate_limit():
    """429 is transient — the client should back off and retry, not fail."""
    respx.get(url__regex=rf"{HOST}/api/v1/accounts/[^/]+/tokens.*").mock(
        side_effect=[
            httpx.Response(200, json=TOKEN_ROWS_PAGE_1),
            httpx.Response(200, json=TOKEN_ROWS_PAGE_2),
        ]
    )
    respx.get(url__regex=rf"{HOST}/api/v1/accounts/[^/]+$").mock(
        side_effect=[
            httpx.Response(429),
            httpx.Response(200, json=ACCOUNT),
        ]
    )
    respx.get(url__regex=rf"{HOST}/api/v1/tokens/.*").mock(
        side_effect=lambda r: httpx.Response(200, json=TOKEN_META[str(r.url).rsplit("/", 1)[-1]])
    )

    balance = await get_account_balance("0.0.1027")
    assert balance.account_id == "0.0.1027"
