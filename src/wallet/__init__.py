"""Wallet delegation: letting a user authorise the agent without giving it keys.

The user grants a capped, revocable spending allowance from their own wallet.
The agent builds the transaction; the user signs it in HashPack over
WalletConnect.
"""

from src.wallet.allowance import (
    AllowanceGrant,
    build_allowance_transaction,
    unwrap_transaction_list,
    wrap_transaction_list,
)

__all__ = [
    "AllowanceGrant",
    "build_allowance_transaction",
    "wrap_transaction_list",
    "unwrap_transaction_list",
]
