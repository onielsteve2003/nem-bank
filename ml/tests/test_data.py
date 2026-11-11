import pandas as pd

from nemml.dataset import DatasetConfig, build_dataset
from nemml.features import FEATURES, build_features
from nemml.nigeria import simulate_nigeria
from nemml.paysim import simulate_paysim
from nemml.rules import RULES, rule_hits, rules_score
from nemml.schema import EVENT_COLUMNS

SMALL = DatasetConfig(seed=3, paysim_customers=400, nigeria_customers=300)


def test_generators_are_reproducible():
    a = simulate_nigeria(n_customers=120, seed=5)
    b = simulate_nigeria(n_customers=120, seed=5)
    c = simulate_nigeria(n_customers=120, seed=6)
    pd.testing.assert_frame_equal(a, b)
    assert len(a) != len(c) or not a.equals(c)
    pd.testing.assert_frame_equal(
        simulate_paysim(n_customers=200, seed=5), simulate_paysim(n_customers=200, seed=5)
    )


def test_schema_and_labels():
    ev = simulate_nigeria(n_customers=300, seed=1)
    assert list(ev.columns) == EVENT_COLUMNS
    assert (ev["amount_ngn"] > 0).all()
    assert set(ev["scenario"]) <= {"benign", "ato", "apush", "mule_cashout"}
    assert (ev.loc[ev["scenario"] != "benign", "is_fraud"] == 1).all()
    assert (ev.loc[ev["scenario"] == "benign", "is_fraud"] == 0).all()


def test_paysim_fraud_is_a_drain_to_a_fresh_mule():
    ev = simulate_paysim(n_customers=500, seed=2)
    fraud = ev[ev["is_fraud"] == 1]
    assert len(fraud) > 0 and len(fraud) % 2 == 0
    victim_legs = fraud[fraud["customer_id"].str.startswith("ps:C")]
    assert (victim_legs["amount_ngn"] / victim_legs["balance_before_ngn"]).min() >= 0.84


def test_dataset_is_deterministic_and_has_both_sources():
    rows1, m1 = build_dataset(SMALL)
    rows2, m2 = build_dataset(SMALL)
    assert m1["fingerprint"] == m2["fingerprint"]
    pd.testing.assert_frame_equal(rows1, rows2)
    assert set(rows1["source"]) == {"paysim", "nigeria"}
    assert 0 < m1["fraud_rate_after_warmup"] < 0.05


def test_features_use_only_the_past():
    ev = simulate_nigeria(n_customers=150, seed=4)
    full = build_features(ev)
    cut = float(ev["ts_hours"].quantile(0.6))
    past = ev[ev["ts_hours"] <= cut]
    truncated = build_features(past)
    # Dropping every row after `cut` must not change any feature of the rows before it.
    a = (
        full.loc[full["ts_hours"] <= cut]
        .sort_values(["customer_id", "ts_hours", "amount_ngn"])
        .reset_index(drop=True)
    )
    b = truncated.sort_values(["customer_id", "ts_hours", "amount_ngn"]).reset_index(drop=True)
    pd.testing.assert_frame_equal(a[FEATURES], b[FEATURES])


def test_feature_values():
    ev = pd.DataFrame(
        {
            "source": "nigeria",
            "customer_id": "c",
            "ts_hours": [50.0, 60.0, 100.0, 100.2, 100.4, 101.0, 130.0],
            "amount_ngn": [1000.0] * 6 + [90000.0],
            "balance_before_ngn": [100000.0] * 7,
            "beneficiary_id": ["a", "a", "a", "a", "b", "a", "z"],
            "device_id": ["d1"] * 6 + ["d2"],
            "account_open_ts_hours": 0.0,
            "is_fraud": 0,
            "scenario": "benign",
        }
    )
    f = build_features(ev)
    assert list(f["velocity_1h"]) == [0, 0, 0, 1, 2, 3, 0]
    assert list(f["new_beneficiary"]) == [1, 0, 0, 0, 1, 0, 1]
    assert list(f["new_device"]) == [0, 0, 0, 0, 0, 0, 1]
    assert f["amount_zscore"].iloc[6] > 3
    assert f["hour_of_day"].iloc[2] == 4
    assert f["account_age_days"].iloc[6] == 130 / 24


def test_rules_score_ranks_attacks_above_honest_traffic():
    rows, _ = build_dataset(SMALL)
    live = rows[~rows["warmup"]]
    score = rules_score(live)
    assert (
        score[live["is_fraud"].to_numpy() == 1].mean() > score[live["is_fraud"].to_numpy() == 0].mean() + 10
    )
    assert set(rule_hits(live).columns) == {r.code for r in RULES}
