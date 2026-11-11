"""Fraud features, computed point-in-time.

Every feature for a row uses only that customer's earlier rows, so the table
looks exactly like what the Go risk engine can know at the moment a transfer
is requested. `tests/test_features.py` proves this by truncating the future.

The Go engine (T29.3) must compute these the same way. The order of
`FEATURES` is the model's input order and is exported next to the model.
"""

import numpy as np
import pandas as pd

FEATURES = [
    "log_amount",
    "amount_zscore",  # (log amount - mean of customer's prior log amounts) / std
    "amount_to_balance",  # amount / balance before the transfer
    "velocity_1h",  # transfers by this customer in the previous hour
    "velocity_24h",  # ... in the previous 24 hours
    "new_beneficiary",  # 1 if this customer never paid this beneficiary before
    "new_device",  # 1 if first time this device is used; NaN when unknown
    "hour_of_day",  # 0-23, Lagos time
    "account_age_days",  # NaN when unknown
    "prior_count",  # how many earlier transfers we have to compare against
]

MIN_HISTORY_FOR_ZSCORE = 5
STD_FLOOR = 0.25  # in log space; stops tiny histories giving absurd z-scores


def build_features(events: pd.DataFrame) -> pd.DataFrame:
    """Return `events` plus the feature columns, in the original row order."""
    ev = events.reset_index(drop=True)
    order = np.lexsort((ev.index.to_numpy(), ev["ts_hours"].to_numpy(), ev["customer_id"].to_numpy()))
    s = ev.iloc[order].copy()

    s["log_amount"] = np.log1p(s["amount_ngn"])
    g = s.groupby("customer_id", sort=False)

    # Amount z-score against the customer's earlier amounts only.
    prior_n = g.cumcount()
    cum = g["log_amount"].cumsum() - s["log_amount"]
    cum2 = (s["log_amount"] ** 2).groupby(s["customer_id"], sort=False).cumsum() - s["log_amount"] ** 2
    mean = cum / prior_n.replace(0, np.nan)
    var = (cum2 / prior_n.replace(0, np.nan)) - mean**2
    std = np.sqrt(var.clip(lower=0)).clip(lower=STD_FLOOR)
    z = (s["log_amount"] - mean) / std
    s["amount_zscore"] = z.where(prior_n >= MIN_HISTORY_FOR_ZSCORE)
    s["prior_count"] = prior_n

    s["amount_to_balance"] = (s["amount_ngn"] / s["balance_before_ngn"].clip(lower=1.0)).clip(upper=5.0)

    # Velocity: earlier transfers inside the window, via binary search per customer.
    v1 = np.zeros(len(s))
    v24 = np.zeros(len(s))
    pos = 0
    for _, ts in s.groupby("customer_id", sort=False)["ts_hours"]:
        t = ts.to_numpy()
        idx = np.arange(len(t))
        v1[pos : pos + len(t)] = idx - np.searchsorted(t, t - 1.0, side="left")
        v24[pos : pos + len(t)] = idx - np.searchsorted(t, t - 24.0, side="left")
        pos += len(t)
    s["velocity_1h"] = v1
    s["velocity_24h"] = v24

    s["new_beneficiary"] = (s.groupby(["customer_id", "beneficiary_id"], sort=False).cumcount() == 0).astype(
        "float64"
    )
    # A customer's very first device is not "new": there is nothing to compare to.
    has_device = s["device_id"].notna()
    first_use = s.groupby(["customer_id", "device_id"], sort=False).cumcount() == 0
    new_dev = (first_use & (prior_n > 0)).astype("float64")
    s["new_device"] = new_dev.where(has_device)

    s["hour_of_day"] = np.floor(s["ts_hours"] % 24).astype("float64")
    age = (s["ts_hours"] - s["account_open_ts_hours"]) / 24.0
    s["account_age_days"] = age

    return s.sort_index().loc[:, list(ev.columns) + [c for c in FEATURES if c not in ev.columns]]


def model_matrix(frame: pd.DataFrame) -> pd.DataFrame:
    return frame[FEATURES].astype("float64")
