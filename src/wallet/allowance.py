"""Build unsigned allowance transactions for a wallet to sign.

The agent never holds the user's keys. It builds an
`AccountAllowanceApproveTransaction` with the *user* as payer, hands the bytes
to their wallet over WalletConnect, and the user approves it there.

What the allowance grants: permission for the agent's account to spend up to a
capped amount of specific tokens. It is revocable at any time, and does not
give away custody of the account.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from hiero_sdk_python import (
    AccountAllowanceApproveTransaction,
    AccountId,
    Client,
    Hbar,
    Network,
    TokenId,
    TransactionId,
)

from src.config import TINYBARS_PER_HBAR, is_hbar

# TransactionList is `repeated Transaction transaction_list = 1;` and the
# Python SDK does not generate it, so the single-element case is encoded by
# hand: field 1, wire type 2 (length-delimited).
_TRANSACTION_LIST_FIELD_1_LEN_DELIM = 0x0A


def _varint(value: int) -> bytes:
    """Protobuf base-128 varint."""
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def wrap_transaction_list(transaction_bytes: bytes) -> bytes:
    """Wrap one serialised Transaction in a TransactionList.

    HIP-820's `hedera_signAndExecuteTransaction` takes a base64 TransactionList,
    but the SDK's `to_bytes()` returns a bare Transaction. Sending the latter
    would be rejected by the wallet.
    """
    return (
        bytes([_TRANSACTION_LIST_FIELD_1_LEN_DELIM])
        + _varint(len(transaction_bytes))
        + transaction_bytes
    )


def unwrap_transaction_list(payload: bytes) -> list[bytes]:
    """Inverse of `wrap_transaction_list`, for tests and verification."""
    transactions: list[bytes] = []
    index = 0
    while index < len(payload):
        if payload[index] != _TRANSACTION_LIST_FIELD_1_LEN_DELIM:
            raise ValueError(f"Unexpected protobuf tag 0x{payload[index]:02x}")
        index += 1
        length = 0
        shift = 0
        while True:
            byte = payload[index]
            index += 1
            length |= (byte & 0x7F) << shift
            if not byte & 0x80:
                break
            shift += 7
        transactions.append(payload[index : index + length])
        index += length
    return transactions


@dataclass(frozen=True)
class AllowanceGrant:
    """One token the agent may spend, and how much of it."""

    token_id: str
    symbol: str
    amount: Decimal  # whole units, as the user would say it
    decimals: int

    @property
    def raw_amount(self) -> int:
        """Smallest units, which is what the network stores."""
        if is_hbar(self.token_id):
            return int(self.amount * Decimal(TINYBARS_PER_HBAR))
        return int(self.amount * (Decimal(10) ** self.decimals))


def build_allowance_transaction(
    owner_account_id: str,
    spender_account_id: str,
    grants: list[AllowanceGrant],
    network: str = "testnet",
    memo: str = "DeFi Copilot rebalancing allowance",
) -> bytes:
    """Build an unsigned, frozen allowance transaction.

    Args:
        owner_account_id: the user. They are both approver and payer, which is
            why the transaction id is generated from their account.
        spender_account_id: the agent, which may then spend within the caps.
        grants: what the agent may spend. HBAR and HTS tokens use different
            SDK calls, so they are dispatched separately.

    Returns:
        Serialised Transaction bytes, unsigned. Wrap with
        `wrap_transaction_list` before sending over WalletConnect.

    Raises:
        ValueError: no grants, or a non-positive amount.
    """
    if not grants:
        raise ValueError("An allowance needs at least one token.")

    owner = AccountId.from_string(owner_account_id)
    spender = AccountId.from_string(spender_account_id)

    transaction = AccountAllowanceApproveTransaction()
    for grant in grants:
        if grant.amount <= 0:
            raise ValueError(f"Allowance for {grant.symbol} must be positive.")
        if is_hbar(grant.token_id):
            transaction = transaction.approve_hbar_allowance(
                owner, spender, Hbar.from_tinybars(grant.raw_amount)
            )
        else:
            transaction = transaction.approve_token_allowance(
                TokenId.from_string(grant.token_id), owner, spender, grant.raw_amount
            )

    # The user pays, so the transaction id must be theirs. Freezing needs a
    # client only to pick node account ids; no key is involved and nothing is
    # submitted here.
    transaction = transaction.set_transaction_id(
        TransactionId.generate(owner)
    ).set_transaction_memo(memo)

    return transaction.freeze_with(Client(Network(network=network))).to_bytes()
