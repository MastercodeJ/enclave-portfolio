"""Turn a user's sentence into a StrategyDraft.

The only module that talks to a language model, and it does so lazily: the
import happens inside the call, so the rest of the strategy layer -- and every
test of it -- runs without langchain installed or an API key present.

Extraction is a thin shell by design. The model fills in a schema; all the
judgement lives in validate.py, where it can be tested.
"""

from __future__ import annotations

import os
from typing import Any, Awaitable, Callable

from src.config import known_symbols
from src.strategy.errors import ExtractionError
from src.strategy.models import StrategyDraft

#: Overridable via the LLM_MODEL environment variable. Any tool-calling model
#: works -- Claude, GPT and the larger Groq-hosted models are interchangeable,
#: because the schema does the work rather than the prompt.
DEFAULT_MODEL = "claude-opus-5"

Extractor = Callable[[str], StrategyDraft | Awaitable[StrategyDraft]]


def build_system_prompt(network: str = "testnet") -> str:
    """Instructions paired with the StrategyDraft schema.

    Kept short on purpose: the field descriptions in StrategyDraft carry most
    of the meaning, and duplicating them here would let the two drift apart.
    """
    symbols = ", ".join(known_symbols(network))
    return (
        "You turn a person's description of how they want their crypto "
        "portfolio managed into a structured strategy.\n\n"
        f"Tradable tokens on {network}: {symbols}. "
        "If the user names anything else, still record it as they said it -- "
        "it will be checked separately and reported back to them.\n\n"
        "Rules:\n"
        "- Allocation percentages must total exactly 100.\n"
        "- Only fill in a limit or cadence if the user actually stated one. "
        "Leave it null otherwise; sensible defaults are applied later.\n"
        "- Do not invent tokens the user did not mention.\n"
        "- Interpret plain phrasing: 'half and half' is 50/50, "
        "'a third each' across three tokens is 33.34/33.33/33.33 so it totals 100."
    )


async def extract_strategy(
    prompt: str,
    *,
    llm: Any = None,
    extractor: Extractor | None = None,
    model: str | None = None,
    network: str = "testnet",
) -> StrategyDraft:
    """Extract an untrusted draft from a natural-language prompt.

    Args:
        prompt: what the user typed.
        llm: a langchain chat model. Built from `model` if omitted.
        extractor: bypasses the model entirely. This is the test seam -- pass
            a callable returning a StrategyDraft and no LLM is involved.
        model: model id, defaulting to $LLM_MODEL or DEFAULT_MODEL.

    Raises:
        ExtractionError: the prompt is empty, no credentials are configured,
            or the model returned something unusable.
    """
    if not prompt or not prompt.strip():
        raise ExtractionError("No strategy was given.")

    if extractor is not None:
        result = extractor(prompt)
        if hasattr(result, "__await__"):
            result = await result
        if not isinstance(result, StrategyDraft):
            raise ExtractionError(
                f"Extractor returned {type(result).__name__}, expected StrategyDraft"
            )
        return result

    if llm is None:
        llm = _build_llm(model)

    structured = llm.with_structured_output(StrategyDraft)
    try:
        draft = await structured.ainvoke(
            [
                ("system", build_system_prompt(network)),
                ("human", prompt),
            ]
        )
    except Exception as exc:  # noqa: BLE001 - provider errors are open-ended
        raise ExtractionError(f"The model could not parse that strategy: {exc}") from exc

    if not isinstance(draft, StrategyDraft):
        raise ExtractionError(f"Model returned {type(draft).__name__}, expected StrategyDraft")
    return draft


def _build_llm(model: str | None) -> Any:
    """Construct a chat model, failing with a useful message if unconfigured."""
    try:
        from langchain.chat_models import init_chat_model
    except ImportError as exc:
        raise ExtractionError(
            "langchain is required to extract strategies from natural language. "
            'Install it with: pip install -e ".[agent]"'
        ) from exc

    name = model or os.environ.get("LLM_MODEL") or DEFAULT_MODEL

    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")):
        raise ExtractionError(
            "No LLM credentials found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY "
            "in .env, or pass an `extractor` to bypass the model."
        )

    try:
        return init_chat_model(name)
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(f"Could not initialise model {name!r}: {exc}") from exc
