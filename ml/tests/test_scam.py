"""Scam checker: rules, split hygiene and the exported scorer."""

import json

import numpy as np

from nemml import scam_data, scam_rules
from nemml.categories import score_text
from nemml.scam import run


def test_a_banks_do_not_share_notice_is_not_a_request_for_the_otp():
    assert "asks_for_secret" not in scam_rules.fired(
        "Your Nem Bank OTP is 482913. Do not share it with anyone."
    )
    assert "asks_for_secret" in scam_rules.fired("Please send me your OTP right now")


def test_rules_fire_on_the_known_tricks():
    assert "bvn_update" in scam_rules.fired("Your BVN needs an update today")
    assert "wrong_transfer" in scam_rules.fired("I mistakenly sent N20,000 to you, please send am back")
    assert "family_emergency" in scam_rules.fired("This is my new number, my phone got spoilt")
    assert scam_rules.fired("See you at church on Sunday") == []


def test_score_and_verdict_follow_the_apps_thresholds():
    assert scam_rules.verdict(scam_rules.score([])) == "looks_safe"
    assert scam_rules.verdict(scam_rules.score(["threat", "urgency"])) == "suspicious"
    assert scam_rules.verdict(scam_rules.score(["asks_for_secret", "threat"])) == "likely_scam"


def test_generation_is_reproducible_and_split_by_template():
    a, b = scam_data.nigeria(3), scam_data.nigeria(3)
    assert a.equals(b)
    a["split"] = scam_data.split(a, 3)
    train = set(a.loc[a["split"] == "train", "template"])
    test = set(a.loc[a["split"] == "test", "template"])
    assert train and test and not (train & test)


def test_export_scores_like_python_and_the_system_beats_the_rules(tmp_path):
    result = run(seed=5, out_dir=tmp_path)
    assert result["metrics"]["beats_baseline"]
    model = json.loads((tmp_path / "model.json").read_text(encoding="utf-8"))
    golden = json.loads((tmp_path / "golden.json").read_text(encoding="utf-8"))
    assert len(golden["cases"]) >= 60
    for case in golden["cases"]:
        got = score_text(model, case["text"])
        assert abs(sum(got) - 1) < 1e-9
        assert np.allclose(got, case["probabilities"], atol=1e-5)
        assert case["rules"] == scam_rules.fired(case["text"])
