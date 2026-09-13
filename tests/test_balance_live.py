"""Integration tests against the real Hedera testnet mirror node.

Run with:  pytest tests/test_balance_live.py -m live

Excluded from default runs because testnet resets quarterly — account 0.0.1027
and token 0.0.2240242 will eventually vanish. Assertions deliberately avoid
hardcoding balances, which change; only structural invariants are checked.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from src.portfolio import AccountNotFoundError, get_account_balance

pytestmark = pytest.mark.live

ACCOUNT_ID = "0.0.1027"
EVM_ADDRESS = "0x0000000000000000000000000000000000000403"
USDC_TOKEN_ID = "0.0.2240242"


async def test_reads_a_real_account():
    balance = await get_account_balance(ACCOUNT_ID)

    assert balance.account_id == ACCOUNT_ID
    assert balance.network == "testnet"
    assert balance.hbar > 0
    assert balance.hbar_tinybars > 0
    assert balance.tokens, "expected this account to hold fungible tokens"


async def test_evm_address_resolves_to_same_account():
    by_id = await get_account_balance(ACCOUNT_ID)
    by_evm = await get_account_balance(EVM_ADDRESS)

    assert by_evm.account_id == by_id.account_id == ACCOUNT_ID


async def test_resolves_token_symbol_and_decimals():
    usdc = (await get_account_balance(ACCOUNT_ID)).token(USDC_TOKEN_ID)

    assert usdc is not None, f"{USDC_TOKEN_ID} not held — testnet may have reset"
    assert usdc.symbol == "USDC"
    assert usdc.decimals == 6


async def test_amount_is_raw_balance_scaled_by_decimals():
    """The invariant that matters, checked against whatever the live balance is."""
    balance = await get_account_balance(ACCOUNT_ID)

    for token in balance.tokens:
        assert token.amount == Decimal(token.raw_balance).scaleb(-token.decimals)


async def test_decimals_never_leaks_as_string():
    balance = await get_account_balance(ACCOUNT_ID)
    assert all(isinstance(t.decimals, int) for t in balance.tokens)


async def test_no_nfts_in_results():
    """NFTs share the account's token list and must be filtered out."""
    balance = await get_account_balance(ACCOUNT_ID)
    # Known NFT held by this account during planning.
    assert balance.token("0.0.2212736") is None


async def test_unknown_account_raises():
    with pytest.raises(AccountNotFoundError):
        await get_account_balance("0.0.999999999")


async def test_hbar_matches_tinybars():
    balance = await get_account_balance(ACCOUNT_ID)
    assert balance.hbar == Decimal(balance.hbar_tinybars) / Decimal(100_000_000)
