"""PaySim data: the real Kaggle file if you have it, a PaySim-style simulator if not.

PaySim (Lopez-Rojas et al., 2016, "PaySim: a financial mobile money simulator
for fraud detection") is published on Kaggle as `ealaxi/paysim1` under
CC BY-SA 4.0. Kaggle needs a login to download, so the file is optional:
drop `PS_20174392719_1491204439457_log.csv` at `ml/data/raw/paysim.csv` and
`load_paysim` reads it. Without the file `simulate_paysim` produces rows with
the same structure and the same fraud pattern (a victim account is drained by
a TRANSFER to a fresh mule account, which then CASH_OUTs), so the pipeline is
reproducible from a clean checkout.

Only outgoing money movements (TRANSFER, CASH_OUT, PAYMENT, DEBIT) become
events. CASH_IN is money arriving, which the risk engine never scores.
"""

from pathlib import Path

import numpy as np
import pandas as pd

from nemml.schema import finalise

OUTGOING = ("TRANSFER", "CASH_OUT", "PAYMENT", "DEBIT")


def load_paysim(path: Path, *, max_customers: int | None = None, seed: int = 7) -> pd.DataFrame:
    """Read the real PaySim CSV into the shared event schema."""
    raw = pd.read_csv(
        path,
        usecols=["step", "type", "amount", "nameOrig", "oldbalanceOrg", "nameDest", "isFraud"],
    )
    raw = raw[raw["type"].isin(OUTGOING)]
    if max_customers is not None:
        rng = np.random.default_rng(seed)
        fraud_customers = set(raw.loc[raw["isFraud"] == 1, "nameOrig"])
        others = raw.loc[~raw["nameOrig"].isin(fraud_customers), "nameOrig"].unique()
        keep = set(rng.choice(others, size=min(max_customers, len(others)), replace=False))
        raw = raw[raw["nameOrig"].isin(keep | fraud_customers)]
    frame = pd.DataFrame(
        {
            "source": "paysim",
            "customer_id": "ps:" + raw["nameOrig"].astype(str),
            "ts_hours": raw["step"].astype("float64"),
            "amount_ngn": raw["amount"].clip(lower=0.01),
            "balance_before_ngn": raw["oldbalanceOrg"],
            "beneficiary_id": "ps:" + raw["nameDest"].astype(str),
            "device_id": None,
            "account_open_ts_hours": np.nan,
            "is_fraud": raw["isFraud"],
            "scenario": np.where(raw["isFraud"] == 1, "paysim_drain", "benign"),
        }
    )
    return finalise(frame)


def simulate_paysim(
    *,
    n_customers: int = 5000,
    hours: int = 720,
    fraud_victim_rate: float = 0.02,
    seed: int = 7,
) -> pd.DataFrame:
    """Simulate PaySim-style rows. Deterministic for a given seed."""
    rng = np.random.default_rng(seed)
    rows: list[pd.DataFrame] = []

    # Each customer has an activity rate, a typical spend and a small pool of
    # counterparties (merchants and friends), like PaySim's agent population.
    rate_per_day = rng.lognormal(mean=0.2, sigma=0.7, size=n_customers)
    typical = rng.lognormal(mean=9.0, sigma=0.8, size=n_customers)  # median ~8k
    balance_scale = typical * rng.uniform(8, 40, size=n_customers)
    pool_size = rng.integers(3, 15, size=n_customers)

    for i in range(n_customers):
        n = int(rng.poisson(rate_per_day[i] * hours / 24))
        if n == 0:
            continue
        ts = np.sort(rng.integers(0, hours, size=n)).astype("float64")
        amounts = rng.lognormal(np.log(typical[i]), 0.7, size=n)
        balance = balance_scale[i] * rng.uniform(0.5, 1.5, size=n)
        amounts = np.minimum(amounts, balance * 0.9)
        dest = rng.integers(0, pool_size[i], size=n)
        rows.append(
            pd.DataFrame(
                {
                    "source": "paysim",
                    "customer_id": f"ps:C{i}",
                    "ts_hours": ts,
                    "amount_ngn": np.maximum(amounts, 1.0),
                    "balance_before_ngn": balance,
                    "beneficiary_id": [f"ps:D{i}_{d}" for d in dest],
                    "device_id": None,
                    "account_open_ts_hours": np.nan,
                    "is_fraud": 0,
                    "scenario": "benign",
                }
            )
        )

    # Fraud: after a warm-up, a victim's balance is drained to a new mule, who
    # cashes it out a few hours later. Both legs carry the fraud label, as in
    # PaySim.
    victims = rng.choice(n_customers, size=int(n_customers * fraud_victim_rate), replace=False)
    for k, v in enumerate(victims):
        t0 = float(rng.integers(168, hours - 12))
        balance = float(balance_scale[v] * rng.uniform(0.6, 1.4))
        amount = balance * rng.uniform(0.85, 1.0)
        mule = f"ps:M{k}"
        rows.append(
            pd.DataFrame(
                {
                    "source": "paysim",
                    "customer_id": [f"ps:C{v}", mule],
                    "ts_hours": [t0, t0 + float(rng.integers(1, 8))],
                    "amount_ngn": [amount, amount],
                    "balance_before_ngn": [balance, amount],
                    "beneficiary_id": [mule, f"ps:X{k}"],
                    "device_id": None,
                    "account_open_ts_hours": np.nan,
                    "is_fraud": 1,
                    "scenario": "paysim_drain",
                }
            )
        )
    return finalise(pd.concat(rows, ignore_index=True))
