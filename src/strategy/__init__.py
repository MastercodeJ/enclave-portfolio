"""Turn a user's stated intent into a validated, enforceable Strategy.

    from src.strategy import parse_strategy

    strategy, problems = await parse_strategy(
        "Keep me 50/50 HBAR and USDC, rebalance weekly, "
        "never trade more than 20% at once"
    )

Either `strategy` is a validated object safe to execute against, or it is None
and `problems` lists every specific reason why. Nothing is silently repaired:
the strategy belongs to the user, so quietly rescaling their percentages would
change what they asked for without telling them.

The layering mirrors the rest of the codebase. `validate` is pure and fully
tested; `extract` is a thin shell around a language model and can be bypassed
entirely by passing an `extractor`.
"""

from src.strategy.errors import (
    ExtractionError,
    InvalidStrategyError,
    StrategyError,
)
from src.strategy.extract import build_system_prompt, extract_strategy
from src.strategy.models import (
    Allocation,
    Cadence,
    Strategy,
    StrategyDraft,
    StrategyProblem,
)
from src.strategy.parse import parse_strategy
from src.strategy.store import (
    from_dict,
    list_strategies,
    load_strategy,
    save_strategy,
    to_dict,
)
from src.strategy.validate import validate_draft

__all__ = [
    # front door
    "parse_strategy",
    # stages
    "extract_strategy",
    "validate_draft",
    "build_system_prompt",
    # models
    "Strategy",
    "StrategyDraft",
    "StrategyProblem",
    "Allocation",
    "Cadence",
    # persistence
    "save_strategy",
    "load_strategy",
    "list_strategies",
    "to_dict",
    "from_dict",
    # errors
    "StrategyError",
    "ExtractionError",
    "InvalidStrategyError",
]
