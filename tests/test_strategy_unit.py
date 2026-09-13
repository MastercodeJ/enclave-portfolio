"""Unit tests for src/strategy — no LLM, no network.

Extraction is bypassed with a stub extractor, and tradability checks are
either disabled or run against mocked pools, so nothing here needs an API key.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
import respx

from src.strategy import (
    Allocation,
    Cadence,
    ExtractionError,
    Strategy,
    StrategyDraft,
    StrategyError,
    list_strategies,
    load_strategy,
    parse_strategy,
    save_strategy,
    validate_draft,
)
from tests.test_market_unit import HOST, V1_POOLS, V2_POOLS


def draft(allocations: list[tuple[str, float]], **kw) -> StrategyDraft:
    return StrategyDraft(
        allocations=[Allocation(symbol=s, percent=p) for s, p in allocations], **kw
    )


def stub(d: StrategyDraft):
    """An extractor that ignores the prompt and returns a fixed draft."""
    return lambda _prompt: d


async def check(d: StrategyDraft, **kw):
    return await validate_draft(d, check_tradable=False, **kw)


def problem_fields(problems) -> set[str]:
    return {p.field for p in problems}


# --------------------------------------------------------------------------
# symbol resolution — the six-USDC trap
# --------------------------------------------------------------------------

async def test_symbols_resolve_to_pinned_token_ids():
    strategy, problems = await check(draft([("HBAR", 50), ("USDC", 50)]))

    assert problems == []
    # Six testnet tokens are called USDC and four HBAR; these are the pinned ones.
    assert strategy.targets == {
        "0.0.15058": Decimal("0.5"),
        "0.0.5449": Decimal("0.5"),
    }
    assert strategy.symbols["0.0.5449"] == "USDC"


async def test_symbol_matching_is_case_and_space_insensitive():
    strategy, problems = await check(draft([(" hbar ", 50), ("usdc", 50)]))
    assert problems == []
    assert set(strategy.targets) == {"0.0.15058", "0.0.5449"}


async def test_unknown_symbol_is_rejected_with_the_alternatives():
    _, problems = await check(draft([("HBAR", 50), ("DOGE", 50)]))

    assert len(problems) == 1
    assert "DOGE" in problems[0].reason
    assert "USDC" in problems[0].suggestion  # lists what is available


# --------------------------------------------------------------------------
# weights
# --------------------------------------------------------------------------

async def test_weights_must_total_one_hundred():
    """33/33/33 is rejected, and told the actual total, not silently rescaled."""
    _, problems = await check(draft([("HBAR", 33), ("USDC", 33), ("SAUCE", 33)]))

    assert len(problems) == 1
    assert "99" in problems[0].reason
    assert problems[0].field == "allocations"


async def test_weights_totalling_over_one_hundred_rejected():
    _, problems = await check(draft([("HBAR", 70), ("USDC", 50)]))
    assert "120" in problems[0].reason


@pytest.mark.parametrize("percent", [-10, 101, 150])
async def test_out_of_range_percentages_rejected(percent):
    _, problems = await check(draft([("HBAR", percent), ("USDC", 10)]))
    assert any("between 0 and 100" in p.reason for p in problems)


async def test_duplicate_token_is_ambiguous_not_additive():
    """'50% USDC and 30% USDC' could mean 80% or a correction."""
    _, problems = await check(draft([("USDC", 50), ("USDC", 30), ("HBAR", 20)]))

    assert any("more than once" in p.reason for p in problems)


async def test_hbar_aliases_collapse_to_one_position():
    """A user saying HBAR and a pool quoting WHBAR must be one asset."""
    strategy, problems = await check(draft([("HBAR", 100)]))
    assert problems == []
    assert list(strategy.targets) == ["0.0.15058"]


async def test_percentages_convert_without_float_artefacts():
    strategy, _ = await check(draft([("HBAR", 33.34), ("USDC", 33.33), ("SAUCE", 33.33)]))
    assert strategy is not None
    assert strategy.targets["0.0.5449"] == Decimal("0.3333")
    assert sum(strategy.targets.values()) == Decimal("1.0000")


async def test_empty_allocation_is_rejected():
    _, problems = await check(draft([]))
    assert "no target allocation" in problems[0].reason


# --------------------------------------------------------------------------
# limits: defaults vs stated
# --------------------------------------------------------------------------

async def test_defaults_apply_only_where_the_user_was_silent():
    strategy, _ = await check(draft([("HBAR", 50), ("USDC", 50)]))

    assert strategy.drift_threshold_pct == Decimal("5")
    assert strategy.max_trade_pct == Decimal("20")
    assert strategy.max_price_impact_pct == Decimal("1")
    assert strategy.cadence is Cadence.MANUAL


async def test_stated_limits_override_defaults():
    strategy, _ = await check(
        draft(
            [("HBAR", 50), ("USDC", 50)],
            drift_threshold_pct=2.5,
            max_trade_pct=10,
            max_price_impact_pct=0.5,
            rebalance_cadence="daily",
        )
    )

    assert strategy.drift_threshold_pct == Decimal("2.5")
    assert strategy.max_trade_pct == Decimal("10")
    assert strategy.max_price_impact_pct == Decimal("0.5")
    assert strategy.cadence is Cadence.DAILY


@pytest.mark.parametrize(
    "field,value",
    [
        ("drift_threshold_pct", 0.001),
        ("drift_threshold_pct", 80),
        ("max_trade_pct", 0.5),
        ("max_price_impact_pct", 50),
    ],
)
async def test_limits_outside_sensible_ranges_are_rejected(field, value):
    _, problems = await check(draft([("HBAR", 50), ("USDC", 50)], **{field: value}))
    assert field in problem_fields(problems)


@pytest.mark.parametrize(
    "phrasing,expected",
    [
        ("weekly", Cadence.WEEKLY),
        ("every day", Cadence.DAILY),
        ("once a month", Cadence.MONTHLY),
        ("hourly", Cadence.HOURLY),
        (None, Cadence.MANUAL),
        ("whenever I feel like it", Cadence.MANUAL),
    ],
)
async def test_cadence_phrasings(phrasing, expected):
    strategy, _ = await check(
        draft([("HBAR", 50), ("USDC", 50)], rebalance_cadence=phrasing)
    )
    assert strategy.cadence is expected


# --------------------------------------------------------------------------
# problem reporting
# --------------------------------------------------------------------------

async def test_all_limit_problems_reported_together():
    """A repair prompt should be able to fix everything in one round trip."""
    _, problems = await check(
        draft([("HBAR", 50), ("USDC", 50)], drift_threshold_pct=99, max_trade_pct=0.1)
    )
    assert problem_fields(problems) == {"drift_threshold_pct", "max_trade_pct"}


async def test_sum_not_reported_when_a_symbol_failed_to_resolve():
    """An unresolvable line makes the total meaningless; one clear error is better."""
    _, problems = await check(draft([("HBAR", 50), ("DOGE", 50)]))
    assert len(problems) == 1
    assert "DOGE" in problems[0].reason


# --------------------------------------------------------------------------
# tradability, against mocked pools
# --------------------------------------------------------------------------

@respx.mock
async def test_tradable_tokens_pass_against_pool_data():
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=V1_POOLS))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=V2_POOLS))

    strategy, problems = await validate_draft(draft([("HBAR", 50), ("SAUCE", 50)]))
    assert problems == []
    assert strategy is not None


@respx.mock
async def test_token_without_a_pool_is_rejected_as_untradable():
    """Guards against a model naming a real-sounding token with no market."""
    respx.get(f"{HOST}/pools").mock(return_value=httpx.Response(200, json=[]))
    respx.get(f"{HOST}/v2/pools").mock(return_value=httpx.Response(200, json=[]))

    _, problems = await validate_draft(draft([("HBAR", 50), ("SAUCE", 50)]))
    assert any("cannot be priced" in p.reason for p in problems)


# --------------------------------------------------------------------------
# parse_strategy front door
# --------------------------------------------------------------------------

async def test_parse_strategy_uses_the_injected_extractor():
    strategy, problems = await parse_strategy(
        "half and half",
        extractor=stub(draft([("HBAR", 50), ("USDC", 50)])),
        check_tradable=False,
    )
    assert problems == []
    assert strategy.source_prompt == "half and half"


async def test_parse_strategy_returns_problems_not_a_strategy():
    strategy, problems = await parse_strategy(
        "bad", extractor=stub(draft([("HBAR", 10)])), check_tradable=False
    )
    assert strategy is None
    assert problems


async def test_empty_prompt_raises_rather_than_returning_problems():
    """Extraction failing is a different kind of problem from an invalid strategy."""
    with pytest.raises(ExtractionError):
        await parse_strategy("   ", extractor=stub(draft([])), check_tradable=False)


async def test_extractor_returning_the_wrong_type_is_caught():
    with pytest.raises(ExtractionError, match="expected StrategyDraft"):
        await parse_strategy("x", extractor=lambda _p: {"allocations": []})


async def test_extraction_needs_no_langchain_when_an_extractor_is_given():
    """The LLM import is lazy, so the layer works without the agent extra."""
    import src.strategy.extract as extract_module

    assert "langchain" not in extract_module.__dict__


# --------------------------------------------------------------------------
# persistence
# --------------------------------------------------------------------------

async def test_strategy_round_trips_through_disk_exactly(tmp_path: Path):
    original, _ = await check(
        draft(
            [("HBAR", 33.34), ("USDC", 33.33), ("SAUCE", 33.33)],
            max_trade_pct=12.5,
            rebalance_cadence="weekly",
        )
    )
    save_strategy(original, "demo", tmp_path)
    restored = load_strategy("demo", tmp_path)

    assert restored.targets == original.targets  # exact Decimals, not floats
    assert restored.max_trade_pct == Decimal("12.5")
    assert restored.cadence is Cadence.WEEKLY
    assert restored.source_prompt == original.source_prompt


def test_stored_weights_are_strings_not_floats(tmp_path: Path):
    strategy = Strategy(
        targets={"0.0.15058": Decimal("0.3333")},
        symbols={"0.0.15058": "HBAR"},
        source_prompt="x",
        created_at=datetime.now(timezone.utc),
    )
    payload = json.loads(save_strategy(strategy, "s", tmp_path).read_text())
    assert payload["targets"]["0.0.15058"] == "0.3333"
    assert isinstance(payload["targets"]["0.0.15058"], str)


def test_loading_a_missing_strategy_names_the_path(tmp_path: Path):
    with pytest.raises(StrategyError, match="No stored strategy"):
        load_strategy("nope", tmp_path)


def test_loading_malformed_json_is_reported(tmp_path: Path):
    (tmp_path / "broken.json").write_text("{not json")
    with pytest.raises(StrategyError, match="not valid JSON"):
        load_strategy("broken", tmp_path)


def test_listing_strategies(tmp_path: Path):
    assert list_strategies(tmp_path) == []
    strategy = Strategy(
        targets={"0.0.15058": Decimal("1")},
        symbols={"0.0.15058": "HBAR"},
        source_prompt="all in",
        created_at=datetime.now(timezone.utc),
    )
    save_strategy(strategy, "b", tmp_path)
    save_strategy(strategy, "a", tmp_path)
    assert list_strategies(tmp_path) == ["a", "b"]


# --------------------------------------------------------------------------
# model helpers
# --------------------------------------------------------------------------

async def test_strategy_summary_is_readable():
    strategy, _ = await check(draft([("HBAR", 50), ("USDC", 30), ("SAUCE", 20)]))
    text = str(strategy)

    assert "HBAR" in text and "50%" in text
    assert "5E+1" not in text  # no scientific notation
    assert "20.00%" not in text  # no trailing zeros


async def test_weight_lookup_defaults_to_zero_for_unheld_tokens():
    strategy, _ = await check(draft([("HBAR", 100)]))
    assert strategy.weight("0.0.15058") == Decimal("1")
    assert strategy.weight("0.0.5449") == Decimal("0")


def test_system_prompt_lists_the_tradable_symbols():
    from src.strategy import build_system_prompt

    prompt = build_system_prompt("testnet")
    assert "USDC" in prompt and "SAUCE" in prompt
    assert "total" in prompt.lower()


async def test_small_out_of_range_limit_is_shown_not_rounded_to_zero():
    """'0% is outside the range 0.1%-50%' would read as nonsense."""
    _, problems = await check(
        draft([("HBAR", 100)], drift_threshold_pct=0.001)
    )
    assert "0.001%" in problems[0].reason
