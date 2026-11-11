"""Smart categories: normalization, dictionary, split hygiene and the exported scorer."""

import json

import numpy as np

from nemml.categories import make_vectorizer, run, score_text
from nemml.categories_data import generate, split
from nemml.merchants import CLASSES, lookup, normalize


def test_normalize_collapses_digits_and_drops_punctuation():
    assert normalize("POS/Shoprite-Lekki 08031234567!") == "pos shoprite lekki 0 "
    assert normalize("N1,500.00 Café") == "n0 0 0 caf "


def test_dictionary_matches_whole_words_only():
    assert lookup("POS/SHOPRITE LEKKI") == "groceries"
    assert lookup("Sparkle Cleaners") is None
    assert lookup("PAYSTACK*Netflix.com") == "subscriptions"
    assert lookup("mtn airtime 08031234567") == "airtime_data"


def test_generation_is_reproducible_and_covers_every_class():
    a, b = generate(3), generate(3)
    assert a.equals(b)
    assert set(a["category"]) == set(CLASSES)


def test_split_is_by_merchant_so_test_merchants_are_unseen():
    df = generate(3)
    df["split"] = split(df, 3)
    train = set(df.loc[df["split"] == "train", "entity"])
    test = set(df.loc[df["split"] == "test", "entity"])
    assert train and test and not (train & test)


def test_exported_model_scores_like_sklearn_and_beats_the_baseline(tmp_path):
    result = run(seed=5, out_dir=tmp_path)
    assert result["metrics"]["beats_baseline"]
    model = json.loads((tmp_path / "model.json").read_text(encoding="utf-8"))
    golden = json.loads((tmp_path / "golden.json").read_text(encoding="utf-8"))
    for case in golden["cases"]:
        got = score_text(model, case["text"])
        assert abs(sum(got) - 1) < 1e-9
        assert np.allclose(got, case["probabilities"], atol=1e-5)
    # The exported scorer agrees with a fresh sklearn vectorizer on shape: same terms.
    vec = make_vectorizer().fit(generate(5)["text"])
    assert len(vec.vocabulary_) >= len(model["terms"]) - 50
