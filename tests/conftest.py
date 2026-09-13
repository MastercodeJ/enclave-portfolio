"""Shared test fixtures."""

import pytest

from src.market.client import SaucerSwapClient


@pytest.fixture(autouse=True)
def _clear_market_cache():
    """Drop the SaucerSwap response cache between tests.

    The cache is deliberately shared across client instances, because
    get_pools() builds a fresh client per call and a per-instance cache could
    never register a hit. That sharing also means one test's payload would
    otherwise still be live when the next test installs different mocks.
    """
    SaucerSwapClient.clear_cache()
    yield
    SaucerSwapClient.clear_cache()
