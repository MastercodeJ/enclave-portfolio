"""Hedera Agent Kit plugin exposing portfolio reads to an LLM.

A thin wrapper over `src.portfolio.get_account_balance` — all logic lives in
the core module, which has no Agent Kit dependency. This file only translates
between the kit's Tool interface and that function.

Requires the optional extra:  pip install -e ".[agent]"
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from src.config import DEFAULT_NETWORK
from src.portfolio import (
    AccountNotFoundError,
    MirrorNodeError,
    MirrorNodeRequestError,
    get_account_balance,
)
from src.portfolio.models import AccountBalance

try:
    from hedera_agent_kit import Plugin
    from hedera_agent_kit.shared.configuration import Context
    from hedera_agent_kit.shared.models import ToolResponse
    from hedera_agent_kit.shared.tool import Tool
except ImportError as exc:  # pragma: no cover - import guard
    raise ImportError(
        "The Hedera Agent Kit is required for src.plugins. "
        'Install it with: pip install -e ".[agent]"'
    ) from exc


class GetPortfolioBalanceInput(BaseModel):
    """Parameters for the portfolio balance tool.

    Field descriptions are deliberately verbose: the Agent Kit docs note that
    some frameworks build the LLM's prompt directly from these strings, so any
    ambiguity here becomes a malformed tool call at runtime.
    """

    address: str = Field(
        ...,
        description=(
            "The Hedera account to read. Accepts either a Hedera account ID in "
            "0.0.x form (for example '0.0.1027') or a 0x-prefixed EVM address "
            "(for example '0x0000000000000000000000000000000000000403'). "
            "Both refer to the same account and either is valid."
        ),
    )
    include_zero: bool = Field(
        False,
        description=(
            "Whether to include tokens the account is associated with but holds "
            "none of. Defaults to false. Set true only when the user explicitly "
            "asks about empty or associated-but-unheld token positions."
        ),
    )


class GetPortfolioBalanceTool(Tool):
    """Read HBAR and all fungible HTS token balances for an account.

    Read-only: performs no transaction and needs no operator key, so it is safe
    in every AgentMode, including RETURN_BYTES.
    """

    def __init__(self, network: str = DEFAULT_NETWORK):
        self.method = "get_portfolio_balance_tool"
        self.name = "Get Portfolio Balance"
        self.description = (
            "Returns the HBAR balance and every fungible HTS token balance held "
            "by a Hedera account, with token symbols resolved and amounts scaled "
            "by their decimals. Non-fungible tokens (NFTs) are excluded. Use this "
            "to answer questions about what an account holds, or before deciding "
            "whether a portfolio needs rebalancing."
        )
        self.parameters = GetPortfolioBalanceInput
        # The kit's Context carries account_id, mode, hooks and a mirrornode
        # service, but no network name — so the network is bound per tool
        # instance at construction time rather than read from the context.
        self.network = network

    async def execute(self, client: Any, context: Context, params: Any) -> ToolResponse:
        try:
            balance = await get_account_balance(
                params.address,
                network=self.network,
                include_zero=params.include_zero,
            )
        except AccountNotFoundError:
            return ToolResponse(
                human_message=f"No account {params.address!r} exists on {self.network}.",
                error="account_not_found",
                extra={"address": params.address, "network": self.network},
            )
        except MirrorNodeRequestError as exc:
            # Usually a malformed address, which an LLM passing something
            # conversational produces routinely. Say that, rather than blaming
            # the network: the model can fix a bad address, not an outage.
            return ToolResponse(
                human_message=(
                    f"{params.address!r} is not a valid Hedera address. Use an "
                    f"account ID like '0.0.1027' or an EVM address like '0x...'."
                ),
                error="invalid_address",
                extra={"address": params.address, "statusCode": exc.status_code},
            )
        except MirrorNodeError as exc:
            return ToolResponse(
                human_message=f"Could not reach the {self.network} mirror node: {exc}",
                error="mirror_node_unavailable",
                extra={"detail": str(exc)},
            )

        return ToolResponse(
            human_message=_summarise(balance),
            extra=_serialise(balance),
        )


def _summarise(balance: AccountBalance) -> str:
    """Human-readable summary for the LLM to relay."""
    lines = [f"Account {balance.account_id} on {balance.network} holds {balance.hbar} HBAR."]
    if balance.tokens:
        lines.append(f"It also holds {len(balance.tokens)} fungible token(s):")
        for token in balance.tokens:
            label = token.symbol or token.token_id
            note = "" if token.transferable else " (transfers blocked: frozen or KYC revoked)"
            lines.append(f"  - {token.amount} {label} [{token.token_id}]{note}")
    else:
        lines.append("It holds no fungible tokens.")
    return "\n".join(lines)


def _serialise(balance: AccountBalance) -> dict[str, Any]:
    """JSON-safe structure. Decimals become strings to preserve exactness."""
    return {
        "accountId": balance.account_id,
        "evmAddress": balance.evm_address,
        "network": balance.network,
        "fetchedAt": balance.fetched_at.isoformat(),
        "hbar": str(balance.hbar),
        "hbarTinybars": balance.hbar_tinybars,
        "tokens": [
            {
                "tokenId": t.token_id,
                "symbol": t.symbol,
                "name": t.name,
                "amount": str(t.amount),
                "rawBalance": t.raw_balance,
                "decimals": t.decimals,
                "frozen": t.frozen,
                "kycRevoked": t.kyc_revoked,
                "transferable": t.transferable,
            }
            for t in balance.tokens
        ],
    }


def build_portfolio_plugin(network: str = DEFAULT_NETWORK) -> Plugin:
    """Build the portfolio plugin bound to a network.

    Plugin takes a `tools` factory called with the agent's Context.
    """
    return Plugin(
        name="portfolio",
        version="0.1.0",
        description="Read HBAR and fungible HTS token balances for any Hedera account.",
        tools=lambda _context: [GetPortfolioBalanceTool(network=network)],
    )


#: Ready-to-use testnet plugin for the common case.
portfolio_plugin = build_portfolio_plugin()
