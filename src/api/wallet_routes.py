"""Endpoints supporting the wallet-approval flow.

The server only ever builds *unsigned* transactions. Signing happens in the
user's wallet, reached from the browser over WalletConnect, so no private key
ever touches this process.
"""

from __future__ import annotations

import base64
import os
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.config import CANONICAL_TESTNET_TOKENS, DEFAULT_NETWORK, is_hbar
from src.wallet import AllowanceGrant, build_allowance_transaction, wrap_transaction_list

router = APIRouter(prefix="/api/wallet", tags=["wallet"])

# HIP-820 CAIP-2 identifiers.
CHAIN_IDS = {"testnet": "hedera:testnet", "mainnet": "hedera:mainnet"}

DECIMALS = {"HBAR": 8, "USDC": 6, "DAI": 8, "SAUCE": 6, "CLXY": 6, "HBARX": 8}


class GrantIn(BaseModel):
    symbol: str = Field(..., description="Token symbol, e.g. HBAR or USDC.")
    amount: str = Field(..., description="Cap in whole units, as a decimal string.")


class AllowanceRequest(BaseModel):
    owner_account_id: str = Field(..., description="The user's account, 0.0.x.")
    grants: list[GrantIn] = Field(..., description="What the agent may spend.")
    spender_account_id: str | None = Field(
        None, description="The agent. Defaults to the configured operator."
    )


class AllowanceResponse(BaseModel):
    ok: bool
    transaction_list_base64: str
    signer_account_id: str
    chain_id: str
    method: str
    spender_account_id: str
    summary: list[str]
    bytes_length: int


class WalletConfigResponse(BaseModel):
    network: str
    chain_id: str
    project_id_configured: bool
    spender_account_id: str | None
    method: str


@router.get("/config", response_model=WalletConfigResponse)
async def wallet_config() -> WalletConfigResponse:
    """What the browser needs to open a WalletConnect session."""
    network = os.environ.get("HEDERA_NETWORK", DEFAULT_NETWORK)
    return WalletConfigResponse(
        network=network,
        chain_id=CHAIN_IDS.get(network, "hedera:testnet"),
        project_id_configured=bool(os.environ.get("WALLETCONNECT_PROJECT_ID")),
        spender_account_id=os.environ.get("HEDERA_OPERATOR_ID"),
        method="hedera_signAndExecuteTransaction",
    )


@router.post("/allowance", response_model=AllowanceResponse)
async def build_allowance(request: AllowanceRequest) -> AllowanceResponse:
    """Build the unsigned allowance transaction for the wallet to sign.

    Returns a base64 TransactionList, which is what HIP-820's
    `hedera_signAndExecuteTransaction` expects -- the SDK's own `to_bytes()`
    produces a bare Transaction, which a wallet would reject.
    """
    network = os.environ.get("HEDERA_NETWORK", DEFAULT_NETWORK)
    spender = request.spender_account_id or os.environ.get("HEDERA_OPERATOR_ID")
    if not spender:
        raise HTTPException(
            status_code=400,
            detail=(
                "No agent account to grant the allowance to. Set "
                "HEDERA_OPERATOR_ID or pass spender_account_id."
            ),
        )
    if spender == request.owner_account_id:
        raise HTTPException(
            status_code=400,
            detail="The agent cannot be granted an allowance over its own account.",
        )
    if not request.grants:
        raise HTTPException(status_code=400, detail="An allowance needs at least one token.")

    grants: list[AllowanceGrant] = []
    for grant in request.grants:
        symbol = grant.symbol.strip().upper()
        token_id = CANONICAL_TESTNET_TOKENS.get(symbol)
        if token_id is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{symbol} is not a token we can trade. Available: "
                    f"{', '.join(sorted(CANONICAL_TESTNET_TOKENS))}."
                ),
            )
        try:
            amount = Decimal(grant.amount)
        except (InvalidOperation, ValueError):
            raise HTTPException(
                status_code=400, detail=f"{grant.amount!r} is not a valid amount."
            ) from None
        if amount <= 0:
            raise HTTPException(
                status_code=400, detail=f"The {symbol} allowance must be positive."
            )
        grants.append(
            AllowanceGrant(
                token_id=token_id,
                symbol=symbol,
                amount=amount,
                decimals=DECIMALS.get(symbol, 8),
            )
        )

    try:
        transaction = build_allowance_transaction(
            owner_account_id=request.owner_account_id,
            spender_account_id=spender,
            grants=grants,
            network=network,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - SDK errors on malformed ids
        raise HTTPException(
            status_code=400, detail=f"Could not build the transaction: {exc}"
        ) from exc

    wrapped = wrap_transaction_list(transaction)

    return AllowanceResponse(
        ok=True,
        transaction_list_base64=base64.b64encode(wrapped).decode(),
        # HIP-30 form: the wallet uses this to pick the signing key.
        signer_account_id=f"{CHAIN_IDS.get(network, 'hedera:testnet')}:{request.owner_account_id}",
        chain_id=CHAIN_IDS.get(network, "hedera:testnet"),
        method="hedera_signAndExecuteTransaction",
        spender_account_id=spender,
        summary=[
            f"{g.amount} {g.symbol}" + (" (native)" if is_hbar(g.token_id) else "")
            for g in grants
        ],
        bytes_length=len(wrapped),
    )
