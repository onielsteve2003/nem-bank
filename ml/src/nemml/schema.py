"""The one event table every generator produces and every feature reads.

One row is one outgoing money movement by a customer. Keeping a single schema
means PaySim-style rows and Nigerian-pattern rows train one model.
"""

import numpy as np
import pandas as pd

EVENT_COLUMNS = [
    "source",  # "paysim" or "nigeria"
    "customer_id",
    "ts_hours",  # hours since the start of the simulation (float)
    "amount_ngn",
    "balance_before_ngn",
    "beneficiary_id",
    "device_id",  # None where the source has no device concept (PaySim)
    "account_open_ts_hours",  # NaN where unknown (PaySim)
    "is_fraud",
    "scenario",  # label for analysis only, never a model input
]


def finalise(frame: pd.DataFrame) -> pd.DataFrame:
    """Order, type and validate an events frame."""
    missing = set(EVENT_COLUMNS) - set(frame.columns)
    if missing:
        raise ValueError(f"events frame is missing columns: {sorted(missing)}")
    out = frame[EVENT_COLUMNS].copy()
    out["ts_hours"] = out["ts_hours"].astype("float64")
    out["amount_ngn"] = out["amount_ngn"].astype("float64")
    out["balance_before_ngn"] = out["balance_before_ngn"].astype("float64")
    out["account_open_ts_hours"] = out["account_open_ts_hours"].astype("float64")
    out["is_fraud"] = out["is_fraud"].astype("int8")
    if (out["amount_ngn"] <= 0).any():
        raise ValueError("amounts must be positive")
    if out["ts_hours"].lt(0).any():
        raise ValueError("timestamps must not be negative")
    out = out.sort_values(["ts_hours", "customer_id"], kind="stable")
    return out.reset_index(drop=True)


def fraud_rate(frame: pd.DataFrame) -> float:
    return float(np.mean(frame["is_fraud"])) if len(frame) else 0.0
