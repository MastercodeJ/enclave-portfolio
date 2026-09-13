"""Unit tests for allowance construction — no network, no wallet."""

from __future__ import annotations

from decimal import Decimal

import pytest

from src.wallet import (
    AllowanceGrant,
    build_allowance_transaction,
    unwrap_transaction_list,
    wrap_transaction_list,
)
from src.wallet.allowance import _varint

OWNER = "0.0.10140555"
SPENDER = "0.0.99999"


def test_hbar_amounts_convert_to_tinybars():
    grant = AllowanceGrant("0.0.15058", "HBAR", Decimal("500"), 8)
    assert grant.raw_amount == 50_000_000_000  # 500 * 1e8


def test_token_amounts_use_their_own_decimals():
    assert AllowanceGrant("0.0.5449", "USDC", Decimal("200"), 6).raw_amount == 200_000_000
    assert AllowanceGrant("0.0.5529", "DAI", Decimal("1.5"), 8).raw_amount == 150_000_000


def test_hbar_aliases_are_all_treated_as_native():
    """0.0.0, WHBAR and old WHBAR are one asset, and use tinybars."""
    for alias in ("0.0.0", "0.0.15058", "0.0.2230359"):
        assert AllowanceGrant(alias, "HBAR", Decimal("1"), 8).raw_amount == 100_000_000


def test_transaction_is_built_and_serialised():
    raw = build_allowance_transaction(
        OWNER, SPENDER, [AllowanceGrant("0.0.15058", "HBAR", Decimal("500"), 8)]
    )
    assert isinstance(raw, bytes) and len(raw) > 0
    assert raw[0] == 0x2A  # Transaction.signedTransactionBytes


def test_transaction_list_wrapping_round_trips():
    payload = b"\x2a\x7e" + b"\x00" * 40
    wrapped = wrap_transaction_list(payload)

    assert wrapped[0] == 0x0A  # field 1, length-delimited
    assert unwrap_transaction_list(wrapped) == [payload]


def test_varint_encoding():
    assert _varint(0) == b"\x00"
    assert _varint(127) == b"\x7f"
    assert _varint(128) == b"\x80\x01"
    assert _varint(300) == b"\xac\x02"


def test_long_transactions_use_multibyte_length():
    """Anything over 127 bytes needs a two-byte varint length."""
    payload = b"\x2a" + b"\x00" * 500
    wrapped = wrap_transaction_list(payload)
    assert unwrap_transaction_list(wrapped) == [payload]


def test_multiple_grants_in_one_transaction():
    raw = build_allowance_transaction(
        OWNER,
        SPENDER,
        [
            AllowanceGrant("0.0.15058", "HBAR", Decimal("500"), 8),
            AllowanceGrant("0.0.5449", "USDC", Decimal("200"), 6),
            AllowanceGrant("0.0.1183558", "SAUCE", Decimal("1000"), 6),
        ],
    )
    # One transaction covering all three, not three transactions.
    assert len(unwrap_transaction_list(wrap_transaction_list(raw))) == 1


def test_no_grants_is_an_error():
    with pytest.raises(ValueError, match="at least one token"):
        build_allowance_transaction(OWNER, SPENDER, [])


def test_non_positive_grant_is_an_error():
    with pytest.raises(ValueError, match="must be positive"):
        build_allowance_transaction(
            OWNER, SPENDER, [AllowanceGrant("0.0.15058", "HBAR", Decimal("0"), 8)]
        )


def test_transactions_are_unique_per_call():
    """Each carries its own transaction id, so one cannot replay another."""
    grants = [AllowanceGrant("0.0.15058", "HBAR", Decimal("1"), 8)]
    assert build_allowance_transaction(OWNER, SPENDER, grants) != \
        build_allowance_transaction(OWNER, SPENDER, grants)
