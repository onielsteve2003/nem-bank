import json

import lightgbm as lgb
import numpy as np
import pandas as pd
import pytest

from nemml.dataset import DatasetConfig
from nemml.features import FEATURES
from nemml.fraud import precision_at_k, recall_at_alert_rate, run, threshold_for_precision, time_split


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    out = tmp_path_factory.mktemp("fraud")
    result = run(DatasetConfig(seed=5, paysim_customers=800, nigeria_customers=1500), out)
    return result, out


def test_model_beats_rules_baseline(trained):
    result, _ = trained
    s = result["metrics"]["summary"]
    assert s["beats_baseline"]
    assert s["pr_auc_model"] > s["pr_auc_rules"] + 0.1


def test_artifacts_written(trained):
    _, out = trained
    for name in ("model.txt", "export.json", "metrics.json", "golden.json", "model_card.md"):
        assert (out / name).stat().st_size > 0
    export = json.loads((out / "export.json").read_text())
    assert export["features"] == FEATURES
    t = export["thresholds"]
    assert 0 < t["step_up"] <= t["hold"] < 1
    card = (out / "model_card.md").read_text()
    for heading in ("## Intended use", "## Data", "## Results", "## Limitations"):
        assert heading in card


def test_exported_model_reproduces_golden_scores(trained):
    _, out = trained
    booster = lgb.Booster(model_file=str(out / "model.txt"))
    golden = json.loads((out / "golden.json").read_text())
    frame = pd.DataFrame([c["features"] for c in golden["cases"]])[FEATURES].astype("float64")
    expected = np.array([c["score"] for c in golden["cases"]])
    # Features are rounded to 6 dp in the file, so allow a little slack.
    np.testing.assert_allclose(booster.predict(frame), expected, atol=1e-3)


def test_split_is_chronological_per_source():
    rows = pd.DataFrame(
        {"source": ["a"] * 10 + ["b"] * 10, "ts_hours": list(range(10)) + list(range(100, 110))}
    )
    label = time_split(rows)
    for _, g in rows.groupby("source"):
        order = {"train": 0, "val": 1, "test": 2}
        ranks = label.loc[g.index].map(order).to_numpy()
        assert (np.diff(ranks) >= 0).all()
    assert set(label) == {"train", "val", "test"}


def test_metric_helpers():
    y = np.array([1, 0, 1, 0, 0, 0, 0, 0, 0, 0])
    score = np.array([0.9, 0.8, 0.7, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])
    assert precision_at_k(y, score, 2) == 0.5
    assert recall_at_alert_rate(y, score, 0.2) == 0.5
    assert threshold_for_precision(y, score, 1.0) == pytest.approx(0.9)
