#!/usr/bin/env python
"""Start the DeFi Copilot web app.

    python run.py

Loads .env first so the API sees HEDERA_NETWORK and any LLM credentials.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def load_env(path: Path = Path(".env")) -> None:
    """Minimal .env loader, so the app has no hard dependency on python-dotenv.

    Existing environment variables win, which keeps `LLM_MODEL=x python run.py`
    working as expected.
    """
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def main() -> int:
    load_env()
    try:
        import uvicorn
    except ImportError:
        print('uvicorn is not installed. Run: pip install -e ".[web]"', file=sys.stderr)
        return 1

    port = int(os.environ.get("PORT", "8000"))
    print(f"DeFi Copilot -> http://localhost:{port}")
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")):
        print("  no LLM key set: prompts are disabled, manual entry still works")
    uvicorn.run("src.api.app:app", host="127.0.0.1", port=port, reload=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
