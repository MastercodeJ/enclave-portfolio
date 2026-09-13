#!/usr/bin/env python
"""Interactive setup for the agent's own Hedera account.

    python scripts/setup.py

Two accounts are involved in DeFi Copilot and only one of them needs a key:

  * The **user's** wallet connects by QR and signs in HashPack. They never
    give us a key, and nothing in the web UI asks for one.
  * The **agent's** account signs autonomously with nobody present, so its key
    must live on this machine. That is what this script configures.

The key is read without echoing, validated, checked against the network, and
written to .env with owner-only permissions. It is never printed, never sent
anywhere, and never handled by the browser.
"""

from __future__ import annotations

import getpass
import json
import re
import urllib.request
from pathlib import Path

ENV_PATH = Path(".env")
MIRROR = "https://testnet.mirrornode.hedera.com/api/v1"

ACCOUNT_RE = re.compile(r"^\d+\.\d+\.\d+$")


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def fetch_account(account_id: str) -> dict | None:
    """Look the account up on the mirror node. Public data, no key needed."""
    try:
        with urllib.request.urlopen(f"{MIRROR}/accounts/{account_id}", timeout=15) as res:
            return json.load(res)
    except Exception:
        return None


def write_env(values: dict[str, str]) -> None:
    """Update .env in place, preserving comments and unrelated settings."""
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    for key, value in values.items():
        pattern = re.compile(rf"^{re.escape(key)}=")
        for index, line in enumerate(lines):
            if pattern.match(line.strip()):
                lines[index] = f"{key}={value}"
                break
        else:
            lines.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(lines) + "\n")
    # Keys live here: keep it readable only by the owner.
    ENV_PATH.chmod(0o600)


def main() -> int:
    print("\nDeFi Copilot — agent account setup")
    print("=" * 52)
    print(
        "\nThis configures the account the AGENT signs with.\n"
        "Users connect their own wallets by QR and never give a key.\n"
    )
    print("Need an account? https://portal.hedera.com -> CREATE ECDSA ACCOUNT")
    print("It must be ECDSA: ED25519 accounts cannot sign the EVM transactions")
    print("SaucerSwap's router requires.\n")

    account_id = ask("Agent account ID (0.0.x)")
    if not ACCOUNT_RE.match(account_id):
        print(f"\n  {account_id!r} is not an account id. Expected 0.0.x")
        return 1

    print("\nChecking the network…")
    account = fetch_account(account_id)
    if account is None or "account" not in account:
        print(f"  {account_id} was not found on testnet.")
        return 1

    key_type = (account.get("key") or {}).get("_type", "unknown")
    tinybars = (account.get("balance") or {}).get("balance", 0)
    hbar = tinybars / 100_000_000

    print(f"  found      : {account['account']}")
    print(f"  key type   : {key_type}")
    print(f"  balance    : {hbar:g} HBAR")
    print(f"  evm address: {account.get('evm_address')}")

    if key_type != "ECDSA_SECP256K1":
        print(
            f"\n  This account uses {key_type}. SaucerSwap swaps need ECDSA.\n"
            "  Create a new one with CREATE ECDSA ACCOUNT in the portal."
        )
        if ask("Continue anyway? (y/N)", "n").lower() != "y":
            return 1

    if hbar < 10:
        print(f"\n  Only {hbar:g} HBAR. Top up at https://portal.hedera.com")

    # getpass so the key never appears on screen or in shell history.
    print("\nPaste the agent's DER-encoded private key (input is hidden).")
    private_key = getpass.getpass("  Private key: ").strip()
    if not private_key:
        print("  No key given.")
        return 1

    # Prove the key controls the account by deriving its public key and
    # comparing with the on-chain record. No transaction, no fee.
    #
    # The key type must come from the account: PrivateKey.from_string cannot
    # reliably tell a 32-byte ECDSA key from an Ed25519 seed, and guessing
    # wrong silently derives a public key that matches nothing.
    try:
        from src.api.operator_routes import verify_key_controls_account

        verified, error = verify_key_controls_account(private_key, account.get("key") or {})
        if not verified:
            print(f"\n  {error}")
            return 1
        print("  key verified against the account's on-chain public key")
    except ImportError:
        print("  (SDK unavailable, skipping key verification)")

    write_env(
        {
            "HEDERA_NETWORK": "testnet",
            "HEDERA_OPERATOR_ID": account_id,
            "HEDERA_OPERATOR_KEY": private_key,
            "HEDERA_OPERATOR_EVM_ADDRESS": account.get("evm_address", ""),
        }
    )

    print(f"\n  Written to {ENV_PATH} (permissions 600, owner only)")
    print("  .env is gitignored, so the key will not be committed.\n")
    print("Next:")
    print("  python run.py            start the app")
    print("  then paste an LLM key and a WalletConnect project id in the page")
    print("  — neither of those needs this file.\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\ncancelled")
        raise SystemExit(130) from None
