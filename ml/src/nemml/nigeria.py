"""Synthetic Nigerian transfer behaviour and fraud patterns.

PaySim has no devices, no account age and no sense of how Nigerians move
money, so this generator adds them. Nothing here is real customer data.

Honest customers: salary-driven spend, a handful of regular beneficiaries,
one phone (sometimes replaced), daytime-heavy hours with some night owls, and
the occasional large honest transfer (rent, school fees, owambe) to a new
person. Those honest outliers are what stop the problem being trivial.

Fraud scenarios (each labelled in `scenario`):
  ato          Account takeover: attacker on a new device, a burst of transfers
               to shared mule accounts, mostly at night, draining the balance.
  apush        Authorised push payment (romance, fake-investment or "your
               nephew is stuck" scams): the real owner on their own device
               sends one large transfer to a new beneficiary in the daytime.
               Hardest to catch, so the model is not expected to be perfect.
  mule_cashout A young account that receives and immediately forwards money:
               a burst of mid-sized transfers to several new beneficiaries.
"""

import numpy as np
import pandas as pd

from nemml.schema import finalise

WARMUP_DAYS = 30


def simulate_nigeria(
    *,
    n_customers: int = 4000,
    days: int = 90,
    attack_rate_per_customer: float = 0.003,
    seed: int = 11,
) -> pd.DataFrame:
    """Simulate Nem-style transfers. Deterministic for a given seed.

    The first `WARMUP_DAYS` are honest-only history so that "new beneficiary"
    and "amount vs usual" mean something when fraud starts.
    """
    rng = np.random.default_rng(seed)
    hours = days * 24
    warmup_h = WARMUP_DAYS * 24
    rows: list[pd.DataFrame] = []

    income = rng.lognormal(mean=12.2, sigma=0.9, size=n_customers)  # median ~200k/month
    typical = np.clip(income * rng.uniform(0.01, 0.05, size=n_customers), 500, None)
    rate_per_day = rng.lognormal(mean=-0.3, sigma=0.6, size=n_customers)
    pool_size = rng.integers(3, 12, size=n_customers)
    night_owl = rng.random(n_customers) < 0.12
    # Most customers are existing; a slice opened during the simulation.
    young = rng.random(n_customers) < 0.15
    age_at_start_days = np.where(young, rng.uniform(1, 25, n_customers), rng.uniform(60, 2000, n_customers))
    open_ts = -age_at_start_days * 24.0

    mule_pool = [f"ng:mule{m}" for m in range(max(20, n_customers // 100))]
    hour_profile_day = np.array(
        [1, 1, 1, 1, 1, 2, 4, 7, 9, 10, 10, 10, 10, 10, 10, 10, 10, 11, 12, 11, 8, 5, 3, 2], float
    )
    hour_profile_day /= hour_profile_day.sum()
    hour_profile_owl = np.roll(hour_profile_day, 6)

    for i in range(n_customers):
        cid = f"ng:C{i}"
        profile = hour_profile_owl if night_owl[i] else hour_profile_day
        pool = [f"ng:B{i}_{b}" for b in range(pool_size[i])]
        weights = 1.0 / np.arange(1, pool_size[i] + 1)
        weights /= weights.sum()
        device_a, device_b = f"ng:D{i}_a", f"ng:D{i}_b"
        swap_day = rng.uniform(warmup_h / 24, days) if rng.random() < 0.06 else None

        # Honest events -----------------------------------------------------
        n = int(rng.poisson(rate_per_day[i] * days))
        if n:
            day = rng.integers(0, days, size=n)
            hour = rng.choice(24, size=n, p=profile)
            ts = np.sort(day * 24.0 + hour + rng.random(n))
            amount = rng.lognormal(np.log(typical[i]), 0.6, size=n)
            big = rng.random(n) < 0.02  # rent, school fees, owambe
            amount = np.where(big, amount * rng.uniform(5, 15, size=n), amount)
            new_ben = (rng.random(n) < 0.03) | (big & (rng.random(n) < 0.5))
            ben_idx = rng.choice(pool_size[i], size=n, p=weights)
            ben = [f"ng:N{i}_{k}" if new_ben[k] else pool[ben_idx[k]] for k in range(n)]
            swapped = ts / 24 >= swap_day if swap_day is not None else np.zeros(n, bool)
            dev = np.where(swapped, device_b, device_a)
            # Honest people also use a borrowed phone, a browser or a new SIM now and then.
            odd = rng.random(n) < 0.02
            dev = np.where(odd, [f"ng:D{i}_x{k}" for k in range(n)], dev)
            balance = income[i] * rng.uniform(0.15, 1.6, size=n)
            amount = np.minimum(amount, balance * 0.95)
            rows.append(
                pd.DataFrame(
                    {
                        "source": "nigeria",
                        "customer_id": cid,
                        "ts_hours": ts,
                        "amount_ngn": np.maximum(np.round(amount, 2), 100.0),
                        "balance_before_ngn": balance,
                        "beneficiary_id": ben,
                        "device_id": dev,
                        "account_open_ts_hours": open_ts[i],
                        "is_fraud": 0,
                        "scenario": "benign",
                    }
                )
            )

        # Honest bursts: paying staff, ajo members or several vendors in one go.
        if rng.random() < 0.06:
            for _ in range(int(rng.integers(1, 4))):
                k = int(rng.integers(4, 9))
                t = rng.uniform(warmup_h, hours - 2) + np.sort(rng.uniform(0, 0.9, size=k))
                bal = income[i] * rng.uniform(0.6, 1.6)
                rows.append(
                    pd.DataFrame(
                        {
                            "source": "nigeria",
                            "customer_id": cid,
                            "ts_hours": t,
                            "amount_ngn": np.round(rng.lognormal(np.log(typical[i]), 0.5, size=k), 2),
                            "balance_before_ngn": bal,
                            "beneficiary_id": rng.choice(pool, size=k),
                            "device_id": device_a,
                            "account_open_ts_hours": open_ts[i],
                            "is_fraud": 0,
                            "scenario": "benign",
                        }
                    )
                )

        # Attacks -----------------------------------------------------------
        if rng.random() < attack_rate_per_customer * (days - WARMUP_DAYS):
            kind = rng.choice(["ato", "apush", "mule_cashout"], p=[0.40, 0.40, 0.20])
            t0 = rng.uniform(warmup_h, hours - 6)
            balance = income[i] * rng.uniform(0.3, 1.6)
            if kind == "ato":
                slow = rng.random() < 0.25  # low and slow: a couple of daytime transfers
                k = int(rng.integers(1, 3)) if slow else int(rng.integers(1, 7))
                at_night = rng.random() < 0.6 and not slow
                if slow:
                    t0 = np.floor(t0 / 24) * 24 + rng.uniform(9, 19)
                if at_night:
                    t0 = np.floor(t0 / 24) * 24 + rng.uniform(0, 5)
                t = t0 + np.sort(rng.uniform(0, 1.0, size=k))
                share = rng.uniform(0.08, 0.3) if slow else rng.uniform(0.4, 0.95)
                amt = np.full(k, balance * share / k)
                frame = _attack_frame(
                    cid,
                    t,
                    amt,
                    balance,
                    rng.choice(mule_pool, size=k).tolist(),
                    # 80% on a device never seen before; 20% got the victim to approve on theirs.
                    [f"ng:ATTACKER{i}" if rng.random() < 0.8 else device_a] * k,
                    open_ts[i],
                    "ato",
                )
            elif kind == "apush":
                amt = max(typical[i] * rng.uniform(2, 20), 20_000.0)
                amt = min(amt, balance * 0.95)
                hour_of_day = rng.choice(np.arange(8, 21))
                t = np.array([np.floor(t0 / 24) * 24 + hour_of_day + rng.random()])
                frame = _attack_frame(
                    cid,
                    t,
                    np.array([amt]),
                    balance,
                    [f"ng:SCAMMER{i}"],
                    [device_a],
                    open_ts[i],
                    "apush",
                )
            else:  # mule_cashout
                k = int(rng.integers(4, 11))
                t = t0 + np.sort(rng.uniform(0, 2.0, size=k))
                amt = np.round(rng.uniform(0.1, 0.3, size=k) * balance, -2) + 5_000
                # A mule has no honest history; most are weeks-old accounts, some are older.
                frame = _attack_frame(
                    f"ng:MULE{i}",
                    t,
                    amt,
                    amt.sum() * 1.1,
                    [f"ng:CASH{i}_{j}" for j in range(k)],
                    [f"ng:D{i}_m"] * k,
                    t0 - 24 * (rng.uniform(15, 120) if rng.random() < 0.3 else rng.uniform(1, 12)),
                    "mule_cashout",
                )
            rows.append(frame)

    return finalise(pd.concat(rows, ignore_index=True))


def _attack_frame(cid, t, amt, balance, ben, dev, open_ts, scenario) -> pd.DataFrame:
    k = len(t)
    return pd.DataFrame(
        {
            "source": "nigeria",
            "customer_id": cid,
            "ts_hours": t,
            "amount_ngn": np.maximum(np.round(amt, 2), 100.0),
            "balance_before_ngn": np.full(k, balance),
            "beneficiary_id": ben,
            "device_id": dev,
            "account_open_ts_hours": open_ts,
            "is_fraud": 1,
            "scenario": scenario,
        }
    )
