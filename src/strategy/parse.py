"""The front door: a sentence in, a validated Strategy or reasons out."""

from __future__ import annotations

from typing import Any

import httpx

from src.config import DEFAULT_NETWORK
from src.market.models import Pool
from src.strategy.extract import Extractor, extract_strategy
from src.strategy.models import Strategy, StrategyProblem
from src.strategy.validate import validate_draft


async def parse_strategy(
    prompt: str,
    network: str = DEFAULT_NETWORK,
    *,
    llm: Any = None,
    extractor: Extractor | None = None,
    model: str | None = None,
    pools: list[Pool] | None = None,
    check_tradable: bool = True,
    client: httpx.AsyncClient | None = None,
) -> tuple[Strategy | None, list[StrategyProblem]]:
    """Parse a natural-language strategy into a validated Strategy.

    Two stages: extract an untrusted draft from the prompt, then validate it
    against the rules and live market data.

    Args:
        prompt: what the user typed.
        extractor: bypasses the language model. Tests pass a stub here.
        pools: pre-fetched market pools, to avoid refetching.
        check_tradable: set False to validate shape without network access.

    Returns:
        (strategy, []) when valid, or (None, problems). Problems accumulate,
        so a repair prompt can address every one in a single round trip.

    Raises:
        ExtractionError: the prompt was empty or the model failed. Extraction
            failing is a different kind of problem from a strategy being
            invalid, so it raises rather than joining the problem list.
    """
    draft = await extract_strategy(
        prompt, llm=llm, extractor=extractor, model=model, network=network
    )
    return await validate_draft(
        draft,
        source_prompt=prompt,
        network=network,
        pools=pools,
        check_tradable=check_tradable,
        client=client,
    )
