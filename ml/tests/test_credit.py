"""Credit scoring: reproducible data, export parity and a better ranking than the rules."""

import json

from nemml import credit


def test_generation_is_reproducible():
    assert credit.generate(3, 500).equals(credit.generate(3, 500))


def test_model_beats_the_rules_and_is_roughly_calibrated(tmp_path):
    result = credit.run(seed=5, out_dir=tmp_path)
    m = result["metrics"]["test"]
    assert result["metrics"]["beats_baseline"]
    assert m["brier_model"] < m["brier_constant"]
    for band in ("excellent", "good", "fair"):
        b = m["bands"][band]
        assert b["observed"] is None or abs(b["observed"] - b["predicted"]) < 0.04


def test_golden_cases_match_the_reference_scorer_and_directions_make_sense(tmp_path):
    credit.run(seed=5, out_dir=tmp_path)
    model = json.loads((tmp_path / "model.json").read_text(encoding="utf-8"))
    golden = json.loads((tmp_path / "golden.json").read_text(encoding="utf-8"))
    assert len(golden["cases"]) == credit.GOLDEN_CASES
    for c in golden["cases"]:
        got = credit.score(model, c["salary"], c["age_days"], c["goals"], c["repaid"], c["defaulted"])
        assert abs(got - c["p"]) < 1e-7
    w = {f["name"]: f["weight"] for f in model["features"]}
    assert w["log_salary"] < 0 and w["log_age"] < 0 and w["repaid"] < 0 and w["defaulted"] > 0
