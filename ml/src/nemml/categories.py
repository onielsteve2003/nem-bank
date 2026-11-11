"""Train, evaluate and export the smart-categories model (AI-3).

The system the Go service runs is three steps: the customer's own rule (not trained), the
merchant dictionary, then a TF-IDF + logistic regression model that must be confident. This
module trains the model and measures each step on merchants it has never seen, then writes
what Go needs to `ml/artifacts/categories/`: `model.json`, `merchants.json`, `golden.json`
(scores for Go parity), `metrics.json` and `model_card.md`.
"""

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score

from nemml import __version__, paths
from nemml.categories_data import generate, split
from nemml.merchants import CLASSES, export, lookup, normalize

MODEL_NAME = "category-tfidf-lr-v1"
NGRAM = (2, 4)
MAX_FEATURES = 6000
# A prediction is trusted when its probability reaches this. Chosen on validation data as the
# lowest value at which trusted predictions are at least TARGET_ACCURACY right.
TARGET_ACCURACY = 0.92
GOLDEN_CASES = 60


def make_vectorizer() -> TfidfVectorizer:
    return TfidfVectorizer(
        analyzer="char_wb",
        ngram_range=NGRAM,
        preprocessor=normalize,
        sublinear_tf=True,
        min_df=2,
        max_features=MAX_FEATURES,
        dtype=np.float64,
    )


def rules_predict(texts: pd.Series) -> pd.Series:
    """The baseline: the dictionary alone, `other` when nothing matches."""
    return texts.map(lambda t: lookup(t) or "other")


def system_predict(texts: pd.Series, proba: np.ndarray, threshold: float) -> tuple[pd.Series, pd.Series]:
    """Dictionary first, then the model if confident, else `other`. Also returns who decided."""
    cats: list[str] = []
    who: list[str] = []
    for text, p in zip(texts, proba, strict=True):
        hit = lookup(text)
        if hit:
            cats.append(hit)
            who.append("rules")
        elif p.max() >= threshold:
            cats.append(CLASSES[int(p.argmax())])
            who.append("model")
        else:
            cats.append("other")
            who.append("fallback")
    return pd.Series(cats, index=texts.index), pd.Series(who, index=texts.index)


def pick_threshold(y: np.ndarray, proba: np.ndarray) -> float:
    conf = proba.max(axis=1)
    correct = np.array(CLASSES)[proba.argmax(axis=1)] == y
    for t in np.arange(0.30, 0.99, 0.01):
        keep = conf >= t
        if keep.sum() >= 50 and correct[keep].mean() >= TARGET_ACCURACY:
            return round(float(t), 2)
    return 0.9


def scores(y: pd.Series, pred: pd.Series) -> dict[str, float]:
    return {
        "accuracy": round(float(accuracy_score(y, pred)), 4),
        "macro_f1": round(float(f1_score(y, pred, average="macro", labels=CLASSES, zero_division=0)), 4),
    }


def run(seed: int = 7, out_dir: Path | None = None) -> dict:
    out = out_dir or paths.ARTIFACTS / "categories"
    out.mkdir(parents=True, exist_ok=True)

    df = generate(seed)
    df["split"] = split(df, seed)
    parts = {k: df[df["split"] == k] for k in ("train", "val", "test")}

    vec = make_vectorizer()
    x_train = vec.fit_transform(parts["train"]["text"])
    clf = LogisticRegression(C=12.0, max_iter=3000, solver="lbfgs", random_state=seed)
    clf.fit(x_train, parts["train"]["category"])
    if list(clf.classes_) != sorted(CLASSES):
        raise RuntimeError("a class is missing from the training data")
    # Reorder to CLASSES so the Go side and the model card read in one fixed order.
    order = [list(clf.classes_).index(c) for c in CLASSES]

    def proba(texts: pd.Series) -> np.ndarray:
        return clf.predict_proba(vec.transform(texts))[:, order]

    p_val, p_test = proba(parts["val"]["text"]), proba(parts["test"]["text"])
    threshold = pick_threshold(parts["val"]["category"].to_numpy(), p_val)

    test = parts["test"]
    y = test["category"]
    base = rules_predict(test["text"])
    model_only = pd.Series(np.array(CLASSES)[p_test.argmax(axis=1)], index=test.index)
    system, who = system_predict(test["text"], p_test, threshold)
    trusted = p_test.max(axis=1) >= threshold
    unseen = test["kind"] != "dictionary"

    metrics = {
        "model": MODEL_NAME,
        "rows": {k: int(len(v)) for k, v in parts.items()},
        "entities": {k: int(v["entity"].nunique()) for k, v in parts.items()},
        "threshold": threshold,
        "test": {
            "rules_baseline": scores(y, base),
            "model_alone": scores(y, model_only),
            "system": scores(y, system),
        },
        "test_unseen_merchants": {
            "rules_baseline": scores(y[unseen], base[unseen]),
            "model_alone": scores(y[unseen], model_only[unseen]),
            "system": scores(y[unseen], system[unseen]),
        },
        "test_known_merchants": {
            "rules_baseline": scores(y[~unseen], base[~unseen]),
            "model_alone": scores(y[~unseen], model_only[~unseen]),
            "system": scores(y[~unseen], system[~unseen]),
        },
        "decided_by": {k: round(float(v), 4) for k, v in who.value_counts(normalize=True).items()},
        "model_confident_share": round(float(trusted.mean()), 4),
        "model_confident_accuracy": round(float((model_only[trusted] == y[trusted]).mean()), 4),
        "per_class_f1_system": {
            c: round(float(f1_score(y == c, system == c, zero_division=0)), 3) for c in CLASSES
        },
    }
    metrics["beats_baseline"] = bool(
        metrics["test"]["system"]["macro_f1"] > metrics["test"]["rules_baseline"]["macro_f1"]
    )

    # Export. Row i of coef is term i; columns follow CLASSES.
    terms = [t for t, _ in sorted(vec.vocabulary_.items(), key=lambda kv: kv[1])]
    coef = clf.coef_[order].T  # (terms, classes)
    model_json = {
        "model": MODEL_NAME,
        "format": "tfidf-char_wb-logreg",
        "classes": CLASSES,
        "ngram": list(NGRAM),
        "normalize": "lowercase a-z; digit runs become one '0'; everything else is a space (merchants.normalize)",
        "sublinear_tf": True,
        "norm": "l2",
        "terms": terms,
        "idf": [round(float(v), 6) for v in vec.idf_],
        "coef": [[round(float(v), 5) for v in row] for row in coef],
        "intercept": [round(float(v), 5) for v in clf.intercept_[order]],
        "threshold": threshold,
        "tolerance": 1e-3,
        "trained_with": {"nemml": __version__, "seed": seed},
    }
    # The rounded weights are what Go scores with, so golden scores come from the rounded model.
    golden = golden_cases(model_json, df, seed)

    (out / "model.json").write_text(
        json.dumps(model_json, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n"
    )
    (out / "merchants.json").write_text(json.dumps(export(), indent=1) + "\n", encoding="utf-8", newline="\n")
    (out / "golden.json").write_text(json.dumps(golden, indent=1) + "\n", encoding="utf-8", newline="\n")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8", newline="\n")
    sha = hashlib.sha256((out / "model.json").read_bytes()).hexdigest()
    (out / "model_card.md").write_text(
        model_card(metrics, sha, seed, len(terms)), encoding="utf-8", newline="\n"
    )
    return {"metrics": metrics, "out_dir": out}


def score_text(model: dict, text: str) -> list[float]:
    """Probabilities for `text` from the exported model: the algorithm Go implements."""
    index = {t: i for i, t in enumerate(model["terms"])}
    tf: dict[int, int] = {}
    n_lo, n_hi = model["ngram"]

    def add(gram: str) -> None:
        if gram in index:
            tf[index[gram]] = tf.get(index[gram], 0) + 1

    # sklearn's char_wb analyzer, step for step: each word padded with spaces, every n-gram of
    # each size, a word shorter than n counted once and ending the sizes for that word.
    for word in normalize(text).split():
        w = f" {word} "
        for n in range(n_lo, n_hi + 1):
            offset = 0
            add(w[offset : offset + n])
            while offset + n < len(w):
                offset += 1
                add(w[offset : offset + n])
            if offset == 0:
                break
    vals = {i: (1.0 + np.log(c)) * model["idf"][i] for i, c in tf.items()}
    norm = float(np.sqrt(sum(v * v for v in vals.values())))
    z = np.array(model["intercept"], dtype=np.float64)
    if norm > 0:
        for i, v in vals.items():
            z = z + (v / norm) * np.array(model["coef"][i])
    e = np.exp(z - z.max())
    return [float(v) for v in e / e.sum()]


def golden_cases(model: dict, df: pd.DataFrame, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    picks = df.iloc[rng.choice(len(df), GOLDEN_CASES - 6, replace=False)]["text"].tolist()
    # Edge cases Go must agree on: empty, digits only, unicode, very short, no known grams.
    picks += [
        "",
        "12345 67890",
        "Café Zürich ₦500",
        "a",
        "ZZZZ QQQQ XXXX",
        "  POS/SHOPRITE   LEKKI/LAGOS  NG ",
    ]
    return {
        "tolerance": model["tolerance"],
        "cases": [{"text": t, "probabilities": [round(p, 6) for p in score_text(model, t)]} for t in picks],
    }


def model_card(m: dict, sha: str, seed: int, n_terms: int) -> str:
    t, u, k = m["test"], m["test_unseen_merchants"], m["test_known_merchants"]
    classes = ", ".join(f"`{c}`" for c in CLASSES)
    per_class = "\n".join(f"| {c} | {v} |" for c, v in m["per_class_f1_system"].items())
    return f"""# Model card: {MODEL_NAME} (smart categories)

Feature AI-3. Trained in Python (`ml/`), scored in pure Go. Reproduce with `uv run nemml categories`.

## Intended use
Suggest a spending category for card payments from the merchant name and narration. It runs after the customer's own rules and the merchant dictionary, and only when it is confident; otherwise the transaction keeps its rules-based category. Every guess carries a confidence, and a customer correction beats it. It can be switched off in Settings; the dictionary and the customer's rules keep working without it (non-AI fallback).

## Data
- Synthetic: no public dataset has Nigerian bank narrations. Generated by `ml/src/nemml/categories_data.py` from real Nigerian merchants, a long tail of invented small-business names, and free-text narrations, with card-statement wrappers (`POS/...`, `WEB*...`), reference numbers, random case and typos.
- Rows: train {m["rows"]["train"]}, validation {m["rows"]["val"]}, test {m["rows"]["test"]}. Split **by merchant** ({m["entities"]["test"]} test merchants never seen in training), seed {seed}.
- Classes: {classes}.
- No personal data. No licence restrictions: all text is generated here.

## Model
`TfidfVectorizer` (character n-grams {NGRAM[0]} to {NGRAM[1]} inside words, sublinear tf, L2 norm, {n_terms} terms) feeding a multinomial `LogisticRegression`. Exported as JSON (`model.json`, SHA-256 `{sha}`) and scored in Go with the same arithmetic; `golden.json` holds {GOLDEN_CASES} cases Go must reproduce.
Trusted when the top probability is at least **{m["threshold"]}** (chosen on validation data so trusted guesses are at least {TARGET_ACCURACY:.0%} right).

## Results on held-out merchants (test set)
| Step | Accuracy | Macro-F1 |
|---|---|---|
| Rules baseline (dictionary, else `other`) | {t["rules_baseline"]["accuracy"]} | {t["rules_baseline"]["macro_f1"]} |
| Model alone | {t["model_alone"]["accuracy"]} | {t["model_alone"]["macro_f1"]} |
| **System (dictionary, then confident model, else `other`)** | **{t["system"]["accuracy"]}** | **{t["system"]["macro_f1"]}** |

Only merchants that are not in the dictionary (the hard case):

| Step | Accuracy | Macro-F1 |
|---|---|---|
| Rules baseline | {u["rules_baseline"]["accuracy"]} | {u["rules_baseline"]["macro_f1"]} |
| Model alone | {u["model_alone"]["accuracy"]} | {u["model_alone"]["macro_f1"]} |
| System | {u["system"]["accuracy"]} | {u["system"]["macro_f1"]} |

Only merchants that are in the dictionary (the easy, common case; the dictionary handles these, the model is not consulted):

| Step | Accuracy | Macro-F1 |
|---|---|---|
| Rules baseline | {k["rules_baseline"]["accuracy"]} | {k["rules_baseline"]["macro_f1"]} |
| Model alone | {k["model_alone"]["accuracy"]} | {k["model_alone"]["macro_f1"]} |
| System | {k["system"]["accuracy"]} | {k["system"]["macro_f1"]} |

The test set is mostly merchants outside the dictionary (long-tail names outnumber dictionary merchants about 7 to 1), because that is where a model earns its place. Real spending is the other way round: a few big merchants make most of it. So read the baseline's overall accuracy as a statement about the dictionary's reach, not as a typical hit rate.

The model is confident on {m["model_confident_share"]:.0%} of test rows and right on {m["model_confident_accuracy"]:.0%} of those. In the system, rows are decided by: {", ".join(f"{k} {v:.0%}" for k, v in m["decided_by"].items())}.

| Class | System F1 |
|---|---|
{per_class}

## Limitations
- **The data is synthetic.** Merchant names and narrations were written by me, so these numbers show the pipeline works; they do not predict accuracy on real statements. Real narrations are messier.
- The model reads words, not context: "Faith" in a name means nothing, but "Pharmacy" does. A merchant with a misleading name will be miscategorised, which is why the customer's correction always wins.
- Only text is used: no amounts, times or locations, so a chemist that also sells groceries is a coin flip. Confidence shows this.
- Nigerian Pidgin and Yoruba/Igbo/Hausa narrations are only lightly covered by a few phrases.
- The `other` class is a catch-all, not a verdict.
"""
