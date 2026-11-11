"""The rules-only baseline the model must beat.

These are the rules a sensible bank would write by hand: points for each risk
signal, summed. The same table seeds the Go rules engine (T29.3), which is why
each rule has a stable reason code. A NaN feature scores nothing.
"""

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Rule:
    code: str
    points: int
    description: str
    fires: Callable[[pd.DataFrame], pd.Series]


def _gt(col: str, value: float) -> Callable[[pd.DataFrame], pd.Series]:
    return lambda f: f[col].gt(value).fillna(False)


RULES: list[Rule] = [
    Rule("velocity_burst", 30, "4 or more transfers in the last hour", _gt("velocity_1h", 2)),
    Rule("velocity_day", 15, "15 or more transfers in 24 hours", _gt("velocity_24h", 14)),
    Rule(
        "unusual_amount",
        25,
        "Amount far above this customer's usual (z-score > 3)",
        _gt("amount_zscore", 3.0),
    ),
    Rule("drains_balance", 25, "Moves more than 50% of the balance", _gt("amount_to_balance", 0.5)),
    Rule(
        "new_beneficiary_large",
        20,
        "First payment to this person and over NGN 50,000",
        lambda f: f["new_beneficiary"].eq(1) & f["amount_ngn"].gt(50_000),
    ),
    Rule(
        "new_beneficiary_young_account",
        20,
        "First payment to this person from an account under 90 days old",
        lambda f: f["new_beneficiary"].eq(1) & f["account_age_days"].lt(90),
    ),
    Rule("new_device", 20, "First transfer from a new device", lambda f: f["new_device"].eq(1)),
    Rule(
        "night_large",
        15,
        "Over NGN 50,000 between midnight and 5am",
        lambda f: f["hour_of_day"].lt(5) & f["amount_ngn"].gt(50_000),
    ),
    Rule(
        "young_account",
        15,
        "Account under 30 days old and over NGN 10,000",
        lambda f: f["account_age_days"].lt(30) & f["amount_ngn"].gt(10_000),
    ),
]


def rule_hits(frame: pd.DataFrame) -> pd.DataFrame:
    """One boolean column per rule code."""
    return pd.DataFrame({r.code: r.fires(frame).astype(bool) for r in RULES}, index=frame.index)


def rules_score(frame: pd.DataFrame) -> np.ndarray:
    """Sum of points. Higher is riskier."""
    hits = rule_hits(frame)
    points = np.array([r.points for r in RULES])
    return hits.to_numpy().astype(int) @ points
