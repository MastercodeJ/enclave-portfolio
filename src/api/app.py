"""HTTP API for DeFi Copilot.

A thin adapter over the existing modules -- it holds no business logic of its
own, mirroring how src/plugins wraps them for an LLM. Everything here is
read-only: nothing signs a transaction or moves value.
"""

from __future__ import annotations

import os
from decimal import Decimal
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from src.config import CANONICAL_TESTNET_TOKENS, DEFAULT_NETWORK
from src.market import get_pools, get_prices
from src.portfolio import AccountNotFoundError, MirrorNodeError, get_account_balance
from src.strategy import (
    ExtractionError,
    StrategyDraft,
    parse_strategy,
    validate_draft,
)
from src.api.config_routes import router as config_router
from src.api.operator_routes import router as operator_router
from src.api.wallet_routes import router as wallet_router
from src.api.models import (
    HealthOut,
    ParseRequest,
    PortfolioOut,
    PositionOut,
    ProblemOut,
    StrategyOut,
    StrategyResponse,
    TokenOut,
    ValidateRequest,
)

WEB_DIR = Path(__file__).resolve().parent.parent.parent / "web"

app = FastAPI(
    title="DeFi Copilot",
    description="Autonomous HTS portfolio rebalancing on Hedera.",
    version="0.1.0",
)

app.include_router(config_router)
app.include_router(operator_router)
app.include_router(wallet_router)


def _network() -> str:
    return os.environ.get("HEDERA_NETWORK", DEFAULT_NETWORK)


def _respond(strategy, problems) -> StrategyResponse:
    """Uniform shape for both strategy endpoints."""
    if strategy is None:
        return StrategyResponse(
            ok=False, problems=[ProblemOut.of(p) for p in problems]
        )
    return StrategyResponse(ok=True, strategy=StrategyOut.of(strategy))


@app.get("/api/health", response_model=HealthOut)
async def health() -> HealthOut:
    """Configuration status, so the page can adapt to what is available.

    Notably whether an LLM is configured: without one the prompt box cannot
    work, and the page falls back to manual allocation entry.
    """
    llm = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY"))
    return HealthOut(
        ok=True,
        network=_network(),
        llm_configured=llm,
        operator_account=os.environ.get("HEDERA_OPERATOR_ID") or None,
        detail={
            "model": os.environ.get("LLM_MODEL", "claude-opus-5"),
            "tradableTokens": len(CANONICAL_TESTNET_TOKENS),
        },
    )


@app.get("/api/tokens", response_model=list[TokenOut])
async def tokens() -> list[TokenOut]:
    """The tradable universe with current prices.

    Pinned by id: six testnet tokens are called USDC, so symbol lookup
    anywhere but src/config.resolve_symbol would pick an arbitrary one.
    """
    network = _network()
    prices = await get_prices(list(CANONICAL_TESTNET_TOKENS.values()), network)
    return [
        TokenOut(
            symbol=symbol,
            token_id=token_id,
            price_hbar=str(prices[token_id].hbar) if prices.get(token_id) else None,
            price_usd=(
                str(prices[token_id].usd)
                if prices.get(token_id) and prices[token_id].usd is not None
                else None
            ),
            tradable=prices.get(token_id) is not None,
        )
        for symbol, token_id in CANONICAL_TESTNET_TOKENS.items()
    ]


@app.post("/api/strategy/parse", response_model=StrategyResponse)
async def parse(request: ParseRequest) -> StrategyResponse:
    """Natural language into a validated strategy.

    Requires an LLM. Extraction failing is a 400 rather than a problem list:
    it is a different kind of failure from a strategy being invalid.
    """
    try:
        strategy, problems = await parse_strategy(
            request.prompt,
            network=_network(),
            check_tradable=request.check_tradable,
        )
    except ExtractionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _respond(strategy, problems)


@app.post("/api/strategy/validate", response_model=StrategyResponse)
async def validate(request: ValidateRequest) -> StrategyResponse:
    """Validate a manually entered allocation.

    The same validation the LLM path uses, without the model -- so the page
    remains usable before any credentials are configured.
    """
    draft = StrategyDraft(
        allocations=request.allocations,
        drift_threshold_pct=request.drift_threshold_pct,
        max_trade_pct=request.max_trade_pct,
        max_price_impact_pct=request.max_price_impact_pct,
        rebalance_cadence=request.rebalance_cadence,
    )
    described = ", ".join(f"{a.percent}% {a.symbol}" for a in request.allocations)
    strategy, problems = await validate_draft(
        draft,
        source_prompt=f"manual entry: {described}",
        network=_network(),
        check_tradable=request.check_tradable,
    )
    return _respond(strategy, problems)


@app.get("/api/portfolio/{address}", response_model=PortfolioOut)
async def portfolio(
    address: str,
    include_zero: bool = Query(False, description="Include associated-but-empty tokens."),
) -> PortfolioOut:
    """Current holdings for an account. Free, keyless, read-only."""
    try:
        balance = await get_account_balance(
            address, network=_network(), include_zero=include_zero
        )
    except AccountNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except MirrorNodeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return PortfolioOut(
        account_id=balance.account_id,
        evm_address=balance.evm_address,
        network=balance.network,
        hbar=str(balance.hbar),
        positions=[
            PositionOut(
                token_id=token.token_id,
                symbol=token.symbol,
                amount=str(token.amount),
                raw_balance=token.raw_balance,
                decimals=token.decimals,
                transferable=token.transferable,
            )
            for token in balance.tokens
        ],
        fetched_at=balance.fetched_at.isoformat(),
    )


@app.get("/api/pools")
async def pools(limit: int = Query(10, ge=1, le=100)) -> list[dict]:
    """Quality-filtered pools, deepest first. Useful for showing liquidity."""
    found = await get_pools(_network())
    return [
        {
            "contractId": pool.contract_id,
            "version": pool.version,
            "pair": f"{pool.token_a.symbol}/{pool.token_b.symbol}",
            "feeBps": pool.fee_bps,
            "tvlUsd": str(pool.tvl_usd.quantize(Decimal("0.01"))),
        }
        for pool in found[:limit]
    ]


# The single-page UI. Mounted last so it never shadows an /api route.
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")
