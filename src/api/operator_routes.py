"""Configure the agent's own Hedera account from the page.

This is the one credential that controls funds, so it gets stronger handling
than the LLM key:

* **Ownership is proved before the key is accepted.** The account's key type
  and public key are read from the mirror node, the supplied private key is
  parsed with the matching loader, and the derived public key must equal the
  on-chain one. No transaction, no fee, and a wrong key is rejected up front
  rather than failing confusingly at the first swap.
* **Localhost only.** These routes refuse remote callers outright.
* The key is never returned, never logged, and `.env` is written 0600.

Users never touch this: they connect a wallet by QR and sign in it. This is
operator configuration.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from src.api.config_routes import ENV_PATH, _write_env

router = APIRouter(prefix="/api/operator", tags=["operator"])

MIRROR_HOSTS = {
    "testnet": "https://testnet.mirrornode.hedera.com/api/v1",
    "mainnet": "https://mainnet-public.mirrornode.hedera.com/api/v1",
}

LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}


class OperatorRequest(BaseModel):
    account_id: str = Field(..., description="The agent's account, 0.0.x.")
    private_key: str = Field(..., description="DER or raw hex. Never logged or returned.")
    persist: bool = Field(True, description="Write to .env so it survives a restart.")


class OperatorResponse(BaseModel):
    ok: bool
    account_id: str | None = None
    key_type: str | None = None
    evm_address: str | None = None
    balance_hbar: str | None = None
    masked_key: str | None = None
    verified: bool = False
    persisted: bool = False
    warnings: list[str] = Field(default_factory=list)
    detail: str | None = None


def _require_local(request: Request) -> None:
    """Refuse anything but a local caller.

    A private key controlling funds must never be settable across a network,
    even by accident.
    """
    host = (request.client.host if request.client else "") or ""
    if host not in LOCAL_HOSTS:
        raise HTTPException(
            status_code=403,
            detail="The operator key can only be set from the local machine.",
        )


def mask_key(key: str) -> str:
    key = key.strip()
    return f"…{key[-6:]}" if len(key) > 12 else "…"


def _fetch_account(account_id: str, network: str) -> dict:
    host = MIRROR_HOSTS.get(network, MIRROR_HOSTS["testnet"])
    request = urllib.request.Request(
        f"{host}/accounts/{account_id}", headers={"User-Agent": "defi-copilot"}
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except Exception as exc:  # noqa: BLE001 - urllib raises a wide range
        raise HTTPException(
            status_code=404,
            detail=f"Could not find {account_id} on {network}: {exc}",
        ) from exc


def verify_key_controls_account(private_key: str, onchain_key: dict) -> tuple[bool, str | None]:
    """Prove the private key matches the account's on-chain public key.

    The key type must come from the account rather than being guessed:
    `PrivateKey.from_string` cannot reliably tell a 32-byte ECDSA key from an
    Ed25519 seed, and guessing wrong silently derives the wrong public key.
    """
    from hiero_sdk_python import PrivateKey

    key_type = (onchain_key or {}).get("_type", "")
    expected = ((onchain_key or {}).get("key") or "").lower()
    if not expected:
        return False, "The account has no simple public key to compare against."

    loader = (
        PrivateKey.from_string_ecdsa
        if key_type == "ECDSA_SECP256K1"
        else PrivateKey.from_string_ed25519
    )
    try:
        public_key = loader(private_key.strip()).public_key()
    except Exception:
        return False, (
            f"That key could not be read as {key_type}. "
            "Check you copied the account's own private key."
        )

    # Each accessor is tried separately: asking an ECDSA key for its Ed25519
    # encoding raises rather than returning nothing.
    candidates: set[str] = set()
    for name in ("to_string_raw", "to_string_ecdsa", "to_string_ed25519", "to_string_der"):
        accessor = getattr(public_key, name, None)
        if accessor is None:
            continue
        try:
            candidates.add(str(accessor()).lower())
        except Exception:
            continue
    if expected in candidates:
        return True, None
    return False, "That key does not control this account."


@router.get("", response_model=OperatorResponse)
async def get_operator() -> OperatorResponse:
    """Which agent account is configured, if any."""
    account_id = os.environ.get("HEDERA_OPERATOR_ID")
    key = os.environ.get("HEDERA_OPERATOR_KEY")
    if not (account_id and key):
        return OperatorResponse(ok=False, detail="No agent account configured.")
    return OperatorResponse(
        ok=True,
        account_id=account_id,
        masked_key=mask_key(key),
        evm_address=os.environ.get("HEDERA_OPERATOR_EVM_ADDRESS") or None,
        verified=True,
    )


@router.post("", response_model=OperatorResponse)
async def set_operator(payload: OperatorRequest, request: Request) -> OperatorResponse:
    """Verify and store the agent's account credentials."""
    _require_local(request)

    account_id = payload.account_id.strip()
    private_key = payload.private_key.strip()
    if not account_id or not private_key:
        raise HTTPException(status_code=400, detail="Account id and private key are both required.")

    network = os.environ.get("HEDERA_NETWORK", "testnet")
    account = _fetch_account(account_id, network)
    if "account" not in account:
        raise HTTPException(status_code=404, detail=f"{account_id} does not exist on {network}.")

    onchain_key = account.get("key") or {}
    key_type = onchain_key.get("_type", "unknown")

    verified, error = verify_key_controls_account(private_key, onchain_key)
    if not verified:
        raise HTTPException(status_code=400, detail=error or "Key verification failed.")

    warnings: list[str] = []
    if key_type != "ECDSA_SECP256K1":
        warnings.append(
            f"This account uses {key_type}. Swaps need ECDSA, because "
            "SaucerSwap's router is an EVM contract. Reads and transfers will "
            "still work."
        )

    tinybars = (account.get("balance") or {}).get("balance", 0)
    hbar = tinybars / 100_000_000
    if hbar < 10:
        warnings.append(f"Only {hbar:g} HBAR. Top up at portal.hedera.com.")

    evm_address = account.get("evm_address")

    os.environ["HEDERA_OPERATOR_ID"] = account_id
    os.environ["HEDERA_OPERATOR_KEY"] = private_key
    if evm_address:
        os.environ["HEDERA_OPERATOR_EVM_ADDRESS"] = evm_address

    persisted = False
    if payload.persist:
        try:
            _write_env("HEDERA_OPERATOR_ID", account_id)
            _write_env("HEDERA_OPERATOR_KEY", private_key)
            if evm_address:
                _write_env("HEDERA_OPERATOR_EVM_ADDRESS", evm_address)
            # Owner-only: this file now holds a key that controls funds.
            Path(ENV_PATH).chmod(0o600)
            persisted = True
        except OSError as exc:
            warnings.append(f"Active, but could not save to .env: {exc}")

    return OperatorResponse(
        ok=True,
        account_id=account_id,
        key_type=key_type,
        evm_address=evm_address,
        balance_hbar=f"{hbar:g}",
        masked_key=mask_key(private_key),
        verified=True,
        persisted=persisted,
        warnings=warnings,
        detail="Verified against the account's on-chain public key.",
    )


@router.delete("", response_model=OperatorResponse)
async def clear_operator(request: Request) -> OperatorResponse:
    """Forget the agent account for this process. Does not touch .env."""
    _require_local(request)
    for name in (
        "HEDERA_OPERATOR_ID",
        "HEDERA_OPERATOR_KEY",
        "HEDERA_OPERATOR_EVM_ADDRESS",
    ):
        os.environ.pop(name, None)
    return OperatorResponse(ok=True, detail="Cleared for this session.")
