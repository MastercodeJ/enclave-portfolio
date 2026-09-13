"""Typed errors for strategy parsing."""

from __future__ import annotations


class StrategyError(RuntimeError):
    """Base class for all strategy failures."""


class ExtractionError(StrategyError):
    """The model could not produce a draft from the prompt."""


class InvalidStrategyError(StrategyError):
    """A draft failed validation.

    Carries every problem found, not just the first, so a repair prompt can
    fix them all in one round trip.
    """

    def __init__(self, problems: list):
        self.problems = problems
        detail = "; ".join(str(p) for p in problems)
        super().__init__(f"Strategy is not valid: {detail}")
