"""Tests for the Agent Kit wrapper.

Skipped entirely when the kit is not installed, so the core test suite stays
runnable without its ~150-package dependency tree.
"""

from __future__ import annotations

import httpx
import pytest
import respx

pytest.importorskip("hedera_agent_kit", reason="requires the optional 'agent' extra")

from src.plugins.portfolio_plugin import (  # noqa: E402
    GetPortfolioBalanceInput,
    GetPortfolioBalanceTool,
    build_portfolio_plugin,
)
from tests.test_balance_unit import HOST, mock_mirror_node  # noqa: E402


@respx.mock
async def test_tool_returns_human_readable_summary():
    mock_mirror_node()
    tool = GetPortfolioBalanceTool(network="testnet")
    params = GetPortfolioBalanceInput(address="0.0.1027")

    response = await tool.execute(client=None, context=None, params=params)

    assert response.error is None
    assert "0.0.1027" in response.human_message
    assert "36.46199249 HBAR" in response.human_message
    assert "USDC" in response.human_message


@respx.mock
async def test_tool_extra_payload_is_json_safe():
    mock_mirror_node()
    tool = GetPortfolioBalanceTool(network="testnet")

    response = await tool.execute(
        client=None, context=None, params=GetPortfolioBalanceInput(address="0.0.1027")
    )
    payload = response.extra

    assert payload["accountId"] == "0.0.1027"
    # Decimals are serialised as strings so exactness survives JSON.
    assert payload["hbar"] == "36.46199249"
    assert isinstance(payload["hbar"], str)
    usdc = next(t for t in payload["tokens"] if t["symbol"] == "USDC")
    assert usdc["amount"] == "45.610999"
    assert usdc["rawBalance"] == 45610999


@respx.mock
async def test_tool_reports_missing_account_as_error_not_exception():
    respx.get(url__regex=rf"{HOST}/api/v1/accounts/.*").mock(
        return_value=httpx.Response(404, json={})
    )
    tool = GetPortfolioBalanceTool(network="testnet")

    response = await tool.execute(
        client=None, context=None, params=GetPortfolioBalanceInput(address="0.0.999999999")
    )

    # The LLM should get a usable message, not a traceback.
    assert response.error == "account_not_found"
    assert "0.0.999999999" in response.human_message


def test_plugin_exposes_the_tool():
    plugin = build_portfolio_plugin(network="testnet")
    tools = plugin.tools(None)

    assert len(tools) == 1
    assert tools[0].method == "get_portfolio_balance_tool"
    # Parameter schema must be introspectable — the LLM prompt is built from it.
    schema = tools[0].parameters.model_json_schema()
    assert "address" in schema["properties"]
    assert "0.0.x" in schema["properties"]["address"]["description"]
