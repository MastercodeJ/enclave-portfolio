"""Runtime LLM configuration.

Lets the key be pasted into the page instead of edited into .env and the server
restarted. Handled carefully because it is a credential:

* it is never returned by any endpoint -- only a masked suffix
* it is never written to a log
* it lives in process memory unless the caller explicitly asks to persist it
* persisting rewrites only the matching line in .env, leaving the rest alone

This is a local development tool bound to 127.0.0.1. Do not expose it publicly
with these routes enabled.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/config", tags=["config"])

ENV_PATH = Path(".env")

PROVIDERS = {
    "anthropic": {
        "env_var": "ANTHROPIC_API_KEY",
        "prefix": "sk-ant-",
        "default_model": "claude-opus-5",
        "label": "Anthropic (Claude)",
    },
    "openai": {
        "env_var": "OPENAI_API_KEY",
        "prefix": "sk-",
        "default_model": "gpt-5",
        "label": "OpenAI (GPT)",
    },
}


def detect_provider(api_key: str) -> str | None:
    """Infer the provider from the key's prefix.

    Anthropic is checked first because "sk-ant-" also starts with "sk-".
    """
    key = api_key.strip()
    if key.startswith("sk-ant-"):
        return "anthropic"
    if key.startswith("sk-"):
        return "openai"
    return None


def mask(api_key: str) -> str:
    """Show only enough to confirm which key is loaded."""
    key = api_key.strip()
    if len(key) <= 12:
        return "…"
    return f"{key[:7]}…{key[-4:]}"


class LlmConfigRequest(BaseModel):
    api_key: str = Field(..., description="Provider API key. Never stored in logs.")
    provider: str | None = Field(None, description="anthropic or openai; inferred if omitted.")
    model: str | None = Field(None, description="Model id; the provider default if omitted.")
    verify: bool = Field(True, description="Make one small call to prove the key works.")
    persist: bool = Field(False, description="Also write it to .env for next time.")


class LlmConfigResponse(BaseModel):
    ok: bool
    provider: str | None = None
    model: str | None = None
    masked_key: str | None = None
    verified: bool = False
    persisted: bool = False
    detail: str | None = None


def _write_env(env_var: str, value: str) -> None:
    """Set one variable in .env, preserving every other line and comment."""
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    pattern = re.compile(rf"^{re.escape(env_var)}=")
    replaced = False
    for index, line in enumerate(lines):
        if pattern.match(line.strip()):
            lines[index] = f"{env_var}={value}"
            replaced = True
            break
    if not replaced:
        lines.append(f"{env_var}={value}")
    ENV_PATH.write_text("\n".join(lines) + "\n")


async def _verify(model: str) -> tuple[bool, str | None]:
    """Prove the key works by running a real extraction.

    Exercising the actual path is more useful than a generic ping: it also
    confirms the model supports the structured output the strategy layer needs.
    """
    from src.strategy import extract_strategy

    try:
        draft = await extract_strategy("put everything in HBAR", model=model)
    except Exception as exc:  # noqa: BLE001 - provider errors are open-ended
        return False, str(exc)[:200]
    if not draft.allocations:
        return False, "The model replied but produced no allocation."
    return True, None


@router.get("/llm", response_model=LlmConfigResponse)
async def get_llm_config() -> LlmConfigResponse:
    """Which provider is currently configured, if any."""
    for name, spec in PROVIDERS.items():
        key = os.environ.get(spec["env_var"])
        if key:
            return LlmConfigResponse(
                ok=True,
                provider=name,
                model=os.environ.get("LLM_MODEL") or spec["default_model"],
                masked_key=mask(key),
            )
    return LlmConfigResponse(ok=False, detail="No LLM key configured.")


@router.post("/llm", response_model=LlmConfigResponse)
async def set_llm_config(request: LlmConfigRequest) -> LlmConfigResponse:
    """Configure the LLM for this server process."""
    api_key = request.api_key.strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="No API key given.")

    provider = request.provider or detect_provider(api_key)
    if provider not in PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Could not tell which provider this key belongs to. Anthropic keys "
                "start with 'sk-ant-' and OpenAI keys with 'sk-'."
            ),
        )

    spec = PROVIDERS[provider]
    model = request.model or spec["default_model"]

    # Applied before verification so the extraction path can see it, and rolled
    # back if verification fails -- a bad key should not leave the server in a
    # state where prompts appear enabled but always error.
    previous_key = os.environ.get(spec["env_var"])
    previous_model = os.environ.get("LLM_MODEL")
    os.environ[spec["env_var"]] = api_key
    os.environ["LLM_MODEL"] = model

    verified = False
    if request.verify:
        verified, error = await _verify(model)
        if not verified:
            if previous_key is None:
                os.environ.pop(spec["env_var"], None)
            else:
                os.environ[spec["env_var"]] = previous_key
            if previous_model is None:
                os.environ.pop("LLM_MODEL", None)
            else:
                os.environ["LLM_MODEL"] = previous_model
            raise HTTPException(status_code=400, detail=f"That key did not work: {error}")

    persisted = False
    if request.persist:
        try:
            _write_env(spec["env_var"], api_key)
            _write_env("LLM_MODEL", model)
            persisted = True
        except OSError as exc:
            return LlmConfigResponse(
                ok=True,
                provider=provider,
                model=model,
                masked_key=mask(api_key),
                verified=verified,
                persisted=False,
                detail=f"Key is active but could not be saved to .env: {exc}",
            )

    return LlmConfigResponse(
        ok=True,
        provider=provider,
        model=model,
        masked_key=mask(api_key),
        verified=verified,
        persisted=persisted,
        detail=(
            "Saved to .env." if persisted else "Active for this server session only."
        ),
    )


@router.delete("/llm", response_model=LlmConfigResponse)
async def clear_llm_config() -> LlmConfigResponse:
    """Forget the key for this process. Does not touch .env."""
    for spec in PROVIDERS.values():
        os.environ.pop(spec["env_var"], None)
    os.environ.pop("LLM_MODEL", None)
    return LlmConfigResponse(ok=True, detail="Cleared for this session.")


class ProjectIdRequest(BaseModel):
    project_id: str = Field(..., description="WalletConnect project id from cloud.reown.com")
    persist: bool = Field(False, description="Also write it to .env.")


class ProjectIdResponse(BaseModel):
    ok: bool
    project_id: str | None = None
    persisted: bool = False
    detail: str | None = None


@router.get("/walletconnect", response_model=ProjectIdResponse)
async def get_project_id() -> ProjectIdResponse:
    """The WalletConnect project id, needed before a QR can be generated.

    Unlike an API key this is not a secret -- it ships to every browser that
    loads the page -- so it is returned in full.
    """
    project_id = os.environ.get("WALLETCONNECT_PROJECT_ID")
    if not project_id:
        return ProjectIdResponse(ok=False, detail="No WalletConnect project id set.")
    return ProjectIdResponse(ok=True, project_id=project_id)


@router.post("/walletconnect", response_model=ProjectIdResponse)
async def set_project_id(request: ProjectIdRequest) -> ProjectIdResponse:
    project_id = request.project_id.strip()
    # Project ids are 32-character hex strings; catching the shape early beats
    # a confusing relay handshake failure in the browser.
    if not re.fullmatch(r"[0-9a-fA-F]{32}", project_id):
        raise HTTPException(
            status_code=400,
            detail=(
                "That does not look like a WalletConnect project id. They are "
                "32 hexadecimal characters, from cloud.reown.com."
            ),
        )

    os.environ["WALLETCONNECT_PROJECT_ID"] = project_id
    persisted = False
    if request.persist:
        try:
            _write_env("WALLETCONNECT_PROJECT_ID", project_id)
            persisted = True
        except OSError as exc:
            return ProjectIdResponse(
                ok=True, project_id=project_id, persisted=False,
                detail=f"Active, but could not save to .env: {exc}",
            )

    return ProjectIdResponse(
        ok=True, project_id=project_id, persisted=persisted,
        detail="Saved to .env." if persisted else "Active for this session only.",
    )
