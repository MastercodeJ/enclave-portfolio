"""Value objects describing an account's holdings on Hedera."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal


@dataclass(frozen=True)
class TokenBalance:
    """A single fungible HTS token position.

    Both `raw_balance` and `amount` are kept: write paths (transfers, swaps)
    need the raw integer in the token's smallest unit, while display and
    strategy maths want the scaled Decimal. Recomputing one from the other
    invites off-by-one errors, so we carry both.
    """

    token_id: str
    raw_balance: int
    decimals: int
    amount: Decimal
    symbol: str | None = None
    name: str | None = None
    frozen: bool = False
    kyc_revoked: bool = False
    auto_associated: bool = False

    @property
    def transferable(self) -> bool:
        """False when HTS compliance controls would reject a transfer."""
        return not self.frozen and not self.kyc_revoked


@dataclass(frozen=True)
class AccountBalance:
    """HBAR plus every fungible HTS token held by one account."""

    account_id: str
    hbar_tinybars: int
    hbar: Decimal
    network: str
    fetched_at: datetime
    evm_address: str | None = None
    tokens: list[TokenBalance] = field(default_factory=list)

    def token(self, token_id: str) -> TokenBalance | None:
        """Look up a single position by token id, or None if not held."""
        return next((t for t in self.tokens if t.token_id == token_id), None)

    def __str__(self) -> str:
        lines = [f"{self.account_id} on {self.network} — {self.hbar} HBAR"]
        for t in self.tokens:
            label = t.symbol or t.token_id
            flags = "" if t.transferable else "  [BLOCKED]"
            lines.append(f"  {label:<12} {t.amount}{flags}")
        if not self.tokens:
            lines.append("  (no fungible token balances)")
        return "\n".join(lines)
