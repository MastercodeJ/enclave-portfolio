"""HTTP API and single-page UI for DeFi Copilot.

    uvicorn src.api.app:app --reload

Requires the optional `web` extra.
"""

from src.api.app import app

__all__ = ["app"]
