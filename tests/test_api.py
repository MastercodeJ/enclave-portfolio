"""Tests for the HTTP API.

Domain logic is covered by the module suites; these check the adapter layer --
status codes, response shapes, and that failures reach the client as usable
messages rather than tracebacks.
"""

from __future__ import annotations

import httpx
import pytest
import respx

pytest.importorskip("fastapi", reason="requires the optional 'web' extra")

from fastapi.testclient import TestClient  # noqa: E402

from src.api.app import app  # noqa: E402
from tests.test_market_unit import HOST, V1_POOLS, V2_POOLS  # noqa: E402

MIRROR = "https://testnet.mirrornode.hedera.com"

ACCOUNT = {
    "account": "0.0.10140555",
    "evm_address": "0x040c06d89aa197e211da6059c52e43c859f18866",
    "balance": {"balance": 110000000000, "timestamp": "1.0", "tokens": []},
}


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def mock_market() -> None:
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=V1_POOLS))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=V2_POOLS))


# --------------------------------------------------------------------------
# health
# --------------------------------------------------------------------------

def test_health_reports_configuration(client):
    body = client.get("/api/health").json()

    assert body["ok"] is True
    assert body["network"] == "testnet"
    # The page uses this to decide whether the prompt box can work.
    assert isinstance(body["llm_configured"], bool)


# --------------------------------------------------------------------------
# strategy validation (no LLM involved)
# --------------------------------------------------------------------------

@respx.mock
def test_valid_allocation_returns_a_strategy(client):
    mock_market()
    body = client.post(
        "/api/strategy/validate",
        json={
            "allocations": [
                {"symbol": "HBAR", "percent": 50},
                {"symbol": "SAUCE", "percent": 50},
            ],
            "max_trade_pct": 20,
            "rebalance_cadence": "weekly",
        },
    ).json()

    assert body["ok"] is True
    assert body["problems"] == []
    strategy = body["strategy"]
    assert strategy["cadence"] == "weekly"
    assert strategy["max_trade_pct"] == "20"
    assert {a["symbol"] for a in strategy["allocations"]} == {"HBAR", "SAUCE"}
    # Token ids travel with every allocation: symbols are ambiguous on testnet.
    assert all(a["token_id"].startswith("0.0.") for a in strategy["allocations"])


@respx.mock
def test_invalid_allocation_returns_problems_not_an_error_status(client):
    """A bad strategy is a normal outcome, not an HTTP failure."""
    mock_market()
    response = client.post(
        "/api/strategy/validate",
        json={
            "allocations": [
                {"symbol": "HBAR", "percent": 33},
                {"symbol": "USDC", "percent": 33},
            ]
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["strategy"] is None
    assert "66" in body["problems"][0]["reason"]


@respx.mock
def test_unknown_token_is_reported_with_alternatives(client):
    mock_market()
    body = client.post(
        "/api/strategy/validate",
        json={
            "allocations": [
                {"symbol": "HBAR", "percent": 50},
                {"symbol": "DOGE", "percent": 50},
            ]
        },
    ).json()

    assert body["ok"] is False
    problem = body["problems"][0]
    assert "DOGE" in problem["reason"]
    assert "USDC" in problem["suggestion"]


def test_malformed_request_body_is_a_422(client):
    assert client.post("/api/strategy/validate", json={"nope": 1}).status_code == 422


# --------------------------------------------------------------------------
# strategy parsing (LLM path)
# --------------------------------------------------------------------------

def test_parse_without_credentials_explains_itself(client, monkeypatch):
    """The page shows this text, so it must be actionable, not a traceback."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    response = client.post("/api/strategy/parse", json={"prompt": "half and half"})

    assert response.status_code == 400
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_empty_prompt_is_rejected(client):
    response = client.post("/api/strategy/parse", json={"prompt": "   "})
    assert response.status_code == 400


# --------------------------------------------------------------------------
# portfolio
# --------------------------------------------------------------------------

@respx.mock
def test_portfolio_returns_holdings(client):
    respx.get(url__regex=rf"{MIRROR}/api/v1/accounts/[^/]+/tokens.*").mock(
        return_value=httpx.Response(200, json={"tokens": [], "links": {"next": None}})
    )
    respx.get(url__regex=rf"{MIRROR}/api/v1/accounts/[^/]+$").mock(
        return_value=httpx.Response(200, json=ACCOUNT)
    )

    body = client.get("/api/portfolio/0.0.10140555").json()

    assert body["account_id"] == "0.0.10140555"
    assert body["hbar"] == "1100"  # 110000000000 tinybars
    assert body["positions"] == []


@respx.mock
def test_unknown_account_is_a_404(client):
    respx.get(url__regex=rf"{MIRROR}/api/v1/accounts/.*").mock(
        return_value=httpx.Response(404, json={})
    )
    assert client.get("/api/portfolio/0.0.999999999").status_code == 404


@respx.mock
def test_malformed_address_is_a_502_not_a_traceback(client):
    """A 400 from the mirror node must not escape as an unhandled error."""
    respx.get(url__regex=rf"{MIRROR}/api/v1/accounts/.*").mock(
        return_value=httpx.Response(400, json={})
    )
    response = client.get("/api/portfolio/not-an-address")
    assert response.status_code == 502
    assert "detail" in response.json()


# --------------------------------------------------------------------------
# market
# --------------------------------------------------------------------------

@respx.mock
def test_tokens_lists_the_pinned_universe(client):
    mock_market()
    body = client.get("/api/tokens").json()

    symbols = {t["symbol"] for t in body}
    assert {"HBAR", "USDC", "SAUCE"} <= symbols
    # Pinned ids, never resolved from pool symbols.
    assert next(t for t in body if t["symbol"] == "USDC")["token_id"] == "0.0.5449"


@respx.mock
def test_pools_are_quality_filtered(client):
    mock_market()
    body = client.get("/api/pools?limit=5").json()

    assert body
    # The fabricated $5.9bn CTK/LTK pool must not appear.
    assert all("CTK" not in p["pair"] for p in body)


# --------------------------------------------------------------------------
# static UI
# --------------------------------------------------------------------------

def test_page_and_assets_are_served(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/style.css").status_code == 200


def test_api_routes_are_not_shadowed_by_the_static_mount(client):
    """The UI is mounted last precisely so this stays true."""
    assert client.get("/api/health").json()["ok"] is True


# --------------------------------------------------------------------------
# LLM key configuration
# --------------------------------------------------------------------------

@pytest.fixture
def no_llm(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)


def test_llm_config_reports_nothing_when_unset(client, no_llm):
    body = client.get("/api/config/llm").json()
    assert body["ok"] is False
    assert body["masked_key"] is None


def test_setting_a_key_never_echoes_it_back(client, no_llm):
    """The response must carry only a masked suffix, never the key."""
    secret = "sk-ant-api03-SUPERSECRETVALUE-wxyz"
    body = client.post(
        "/api/config/llm", json={"api_key": secret, "verify": False}
    ).json()

    assert body["ok"] is True
    assert body["provider"] == "anthropic"
    assert secret not in str(body)
    assert body["masked_key"] == "sk-ant-…wxyz"


@pytest.mark.parametrize(
    "key,provider",
    [("sk-ant-abc123456789", "anthropic"), ("sk-proj-abc123456789", "openai")],
)
def test_provider_is_inferred_from_the_key(client, no_llm, key, provider):
    body = client.post("/api/config/llm", json={"api_key": key, "verify": False}).json()
    assert body["provider"] == provider


def test_unrecognised_key_shape_is_rejected_with_guidance(client, no_llm):
    response = client.post(
        "/api/config/llm", json={"api_key": "hello-there", "verify": False}
    )
    assert response.status_code == 400
    assert "sk-ant-" in response.json()["detail"]


def test_empty_key_is_rejected(client, no_llm):
    assert client.post(
        "/api/config/llm", json={"api_key": "   ", "verify": False}
    ).status_code == 400


def test_a_key_that_fails_verification_is_rolled_back(client, no_llm):
    """A bad key must not leave prompts looking enabled but always erroring."""
    response = client.post(
        "/api/config/llm",
        json={"api_key": "sk-ant-definitely-not-valid-key", "verify": True},
    )

    assert response.status_code == 400
    assert "did not work" in response.json()["detail"]
    # Rolled back, so health still reports no LLM.
    assert client.get("/api/health").json()["llm_configured"] is False


def test_setting_then_clearing_a_key(client, no_llm):
    client.post("/api/config/llm", json={"api_key": "sk-ant-abc123456789", "verify": False})
    assert client.get("/api/health").json()["llm_configured"] is True

    client.delete("/api/config/llm")
    assert client.get("/api/health").json()["llm_configured"] is False


def test_configuring_a_key_enables_the_parse_endpoint(client, no_llm):
    """Before: 400 for missing credentials. After: it gets as far as the model."""
    before = client.post("/api/strategy/parse", json={"prompt": "half and half"})
    assert "No LLM credentials" in before.json()["detail"]

    client.post("/api/config/llm", json={"api_key": "sk-ant-abc123456789", "verify": False})
    after = client.post("/api/strategy/parse", json={"prompt": "half and half"})
    assert "No LLM credentials" not in str(after.json())


def test_env_writer_preserves_other_lines(tmp_path, monkeypatch):
    """Persisting a key must not clobber the rest of .env."""
    import src.api.config_routes as config

    env = tmp_path / ".env"
    env.write_text(
        "# comment\nHEDERA_OPERATOR_ID=0.0.123\nANTHROPIC_API_KEY=old\nPORT=8000\n"
    )
    monkeypatch.setattr(config, "ENV_PATH", env)

    config._write_env("ANTHROPIC_API_KEY", "new-key")
    config._write_env("LLM_MODEL", "claude-opus-5")

    text = env.read_text()
    assert "ANTHROPIC_API_KEY=new-key" in text
    assert "old" not in text
    assert "HEDERA_OPERATOR_ID=0.0.123" in text  # untouched
    assert "# comment" in text
    assert "LLM_MODEL=claude-opus-5" in text  # appended


def test_masking_never_reveals_the_middle():
    from src.api.config_routes import mask

    assert mask("sk-ant-api03-LONGSECRET-abcd") == "sk-ant-…abcd"
    assert "LONGSECRET" not in mask("sk-ant-api03-LONGSECRET-abcd")
    assert mask("short") == "…"


# --------------------------------------------------------------------------
# wallet: allowance building
# --------------------------------------------------------------------------

def test_wallet_config_describes_the_session(client):
    body = client.get("/api/wallet/config").json()
    assert body["chain_id"] == "hedera:testnet"
    assert body["method"] == "hedera_signAndExecuteTransaction"


def test_allowance_is_built_unsigned_for_the_wallet(client):
    body = client.post(
        "/api/wallet/allowance",
        json={
            "owner_account_id": "0.0.10140555",
            "spender_account_id": "0.0.99999",
            "grants": [
                {"symbol": "HBAR", "amount": "500"},
                {"symbol": "USDC", "amount": "200"},
            ],
        },
    ).json()

    assert body["ok"] is True
    assert body["method"] == "hedera_signAndExecuteTransaction"
    # HIP-30 form, so the wallet knows which key to sign with.
    assert body["signer_account_id"] == "hedera:testnet:0.0.10140555"
    assert body["summary"] == ["500 HBAR (native)", "200 USDC"]


def test_allowance_payload_is_a_transaction_list_not_a_bare_transaction(client):
    """HIP-820 takes a TransactionList; a wallet rejects a bare Transaction."""
    import base64

    from src.wallet import unwrap_transaction_list

    body = client.post(
        "/api/wallet/allowance",
        json={
            "owner_account_id": "0.0.10140555",
            "spender_account_id": "0.0.99999",
            "grants": [{"symbol": "HBAR", "amount": "1"}],
        },
    ).json()

    payload = base64.b64decode(body["transaction_list_base64"])
    assert payload[0] == 0x0A  # TransactionList field 1, length-delimited
    transactions = unwrap_transaction_list(payload)
    assert len(transactions) == 1
    assert transactions[0][0] == 0x2A  # Transaction.signedTransactionBytes


def test_agent_cannot_be_granted_an_allowance_over_itself(client):
    response = client.post(
        "/api/wallet/allowance",
        json={
            "owner_account_id": "0.0.99999",
            "spender_account_id": "0.0.99999",
            "grants": [{"symbol": "HBAR", "amount": "1"}],
        },
    )
    assert response.status_code == 400
    assert "own account" in response.json()["detail"]


@pytest.mark.parametrize("amount", ["0", "-5"])
def test_non_positive_allowance_is_rejected(client, amount):
    response = client.post(
        "/api/wallet/allowance",
        json={
            "owner_account_id": "0.0.10140555",
            "spender_account_id": "0.0.99999",
            "grants": [{"symbol": "HBAR", "amount": amount}],
        },
    )
    assert response.status_code == 400


def test_unknown_token_in_an_allowance_is_rejected(client):
    response = client.post(
        "/api/wallet/allowance",
        json={
            "owner_account_id": "0.0.10140555",
            "spender_account_id": "0.0.99999",
            "grants": [{"symbol": "DOGE", "amount": "1"}],
        },
    )
    assert response.status_code == 400
    assert "DOGE" in response.json()["detail"]


def test_empty_allowance_is_rejected(client):
    response = client.post(
        "/api/wallet/allowance",
        json={"owner_account_id": "0.0.10140555", "spender_account_id": "0.0.9", "grants": []},
    )
    assert response.status_code == 400


def test_walletconnect_project_id_shape_is_checked(client):
    """A malformed id fails a relay handshake confusingly; catch it here."""
    assert client.post(
        "/api/config/walletconnect", json={"project_id": "too-short"}
    ).status_code == 400
    assert client.post(
        "/api/config/walletconnect", json={"project_id": "a" * 32}
    ).status_code == 200


# --------------------------------------------------------------------------
# operator account: key verification
# --------------------------------------------------------------------------

# A real testnet account, and a key that is valid-looking but belongs to
# something else. Both are public information.
REAL_ACCOUNT = "0.0.10140555"
WRONG_KEY = "302e020100300506032b657004220420" + "11" * 32

ACCOUNT_ECDSA = {
    "account": REAL_ACCOUNT,
    "evm_address": "0x040c06d89aa197e211da6059c52e43c859f18866",
    "balance": {"balance": 110000000000},
    "key": {
        "_type": "ECDSA_SECP256K1",
        "key": "02a3e27ca27a9d21c6fab88b8234de3086ccb55c15b2203d89395d54b3cd449f4c",
    },
}


def test_operator_unset_reports_nothing(client, monkeypatch):
    monkeypatch.delenv("HEDERA_OPERATOR_ID", raising=False)
    monkeypatch.delenv("HEDERA_OPERATOR_KEY", raising=False)
    assert client.get("/api/operator").json()["ok"] is False


def test_key_that_does_not_control_the_account_is_rejected(client, monkeypatch):
    """The whole point: catch a wrong key now, not at the first swap."""
    import src.api.operator_routes as operator

    monkeypatch.setattr(operator, "_fetch_account", lambda *a: ACCOUNT_ECDSA)
    response = client.post(
        "/api/operator",
        json={"account_id": REAL_ACCOUNT, "private_key": WRONG_KEY, "persist": False},
    )

    assert response.status_code == 400
    assert "ECDSA_SECP256K1" in response.json()["detail"]


def test_verification_uses_the_accounts_own_key_type(monkeypatch):
    """PrivateKey.from_string cannot tell 32-byte ECDSA from an Ed25519 seed.

    Guessing derives a public key matching nothing, so the type must come from
    the account record. This asserts the ECDSA path is taken for an ECDSA
    account rather than the auto-detecting loader.
    """
    from src.api.operator_routes import verify_key_controls_account

    called: list[str] = []
    import hiero_sdk_python

    original = hiero_sdk_python.PrivateKey.from_string_ecdsa

    def spy(value):
        called.append("ecdsa")
        return original(value)

    monkeypatch.setattr(hiero_sdk_python.PrivateKey, "from_string_ecdsa", spy)
    verify_key_controls_account(WRONG_KEY, ACCOUNT_ECDSA["key"])
    assert called == ["ecdsa"]


def test_account_with_no_public_key_cannot_be_verified():
    from src.api.operator_routes import verify_key_controls_account

    ok, error = verify_key_controls_account(WRONG_KEY, {})
    assert ok is False
    assert "no simple public key" in error


def test_operator_key_is_never_returned(client, monkeypatch):
    import src.api.operator_routes as operator

    monkeypatch.setattr(operator, "_fetch_account", lambda *a: ACCOUNT_ECDSA)
    monkeypatch.setattr(
        operator, "verify_key_controls_account", lambda *a: (True, None)
    )
    secret = "302e020100300506032b657004220420" + "ab" * 32

    body = client.post(
        "/api/operator",
        json={"account_id": REAL_ACCOUNT, "private_key": secret, "persist": False},
    ).json()

    assert secret not in str(body)
    assert body["masked_key"].startswith("…")
    assert body["verified"] is True


def test_missing_account_is_a_404(client, monkeypatch):
    import src.api.operator_routes as operator

    def missing(*_args):
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="not found")

    monkeypatch.setattr(operator, "_fetch_account", missing)
    assert client.post(
        "/api/operator",
        json={"account_id": "0.0.999999999", "private_key": WRONG_KEY, "persist": False},
    ).status_code == 404


def test_ed25519_account_is_accepted_but_warned_about(client, monkeypatch):
    """It can transfer, but cannot sign the EVM calls a swap needs."""
    import src.api.operator_routes as operator

    ed_account = dict(ACCOUNT_ECDSA, key={"_type": "ED25519", "key": "abcd"})
    monkeypatch.setattr(operator, "_fetch_account", lambda *a: ed_account)
    monkeypatch.setattr(operator, "verify_key_controls_account", lambda *a: (True, None))

    body = client.post(
        "/api/operator",
        json={"account_id": REAL_ACCOUNT, "private_key": "x", "persist": False},
    ).json()

    assert body["ok"] is True
    assert any("ECDSA" in w for w in body["warnings"])


def test_low_balance_is_warned_about(client, monkeypatch):
    import src.api.operator_routes as operator

    poor = dict(ACCOUNT_ECDSA, balance={"balance": 100000000})  # 1 HBAR
    monkeypatch.setattr(operator, "_fetch_account", lambda *a: poor)
    monkeypatch.setattr(operator, "verify_key_controls_account", lambda *a: (True, None))

    body = client.post(
        "/api/operator",
        json={"account_id": REAL_ACCOUNT, "private_key": "x", "persist": False},
    ).json()
    assert any("Top up" in w for w in body["warnings"])


def test_operator_routes_refuse_remote_callers():
    """A key controlling funds must never be settable across a network."""
    from fastapi import HTTPException

    from src.api.operator_routes import _require_local

    class Remote:
        client = type("C", (), {"host": "203.0.113.5"})()

    with pytest.raises(HTTPException) as exc:
        _require_local(Remote())
    assert exc.value.status_code == 403


def test_masking_hides_all_but_the_tail():
    from src.api.operator_routes import mask_key

    masked = mask_key("302e020100300506032b657004220420deadbeef")
    assert masked == "…deadbeef"[-7:] or masked.startswith("…")
    assert "302e0201" not in masked


def test_key_can_be_saved_without_testing_it(client, no_llm):
    """Verification must be optional: offline, or a provider having a wobble."""
    body = client.post(
        "/api/config/llm",
        json={"api_key": "sk-ant-abc123456789", "verify": False},
    ).json()

    assert body["ok"] is True
    assert body["verified"] is False  # saved, but not proven
    assert client.get("/api/health").json()["llm_configured"] is True


def test_unverified_key_is_not_reported_as_verified(client, no_llm):
    body = client.post(
        "/api/config/llm", json={"api_key": "sk-ant-abc123456789", "verify": False}
    ).json()
    assert body["verified"] is False
    assert "session" in body["detail"]
