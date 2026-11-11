"""Train, evaluate and export the scam message classifier (AI-2).

The Go scam checker combines three things: the Nigerian scam rules (`scam_rules.py`), link
checks (Go only), and this text model. The model is the same kind as smart categories: TF-IDF on
character n-grams feeding logistic regression, exported as JSON and scored in plain Go. This
module trains it on the UCI SMS Spam Collection plus generated Nigerian messages, measures the
rules alone against the rules plus the model on held-out messages, and writes what Go needs to
`ml/artifacts/scam/`: `model.json`, `scam_rules.json`, `golden.json`, `metrics.json` and
`model_card.md`.
"""

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_fscore_support

from nemml import __version__, paths, scam_data, scam_rules
from nemml.categories import make_vectorizer, score_text

MODEL_NAME = "scam-tfidf-lr-v1"
CLASSES = ["ham", "spam"]
# The model alone calls a message a likely scam at the lowest score reaching HIGH_PRECISION on
# validation data, and suspicious at the lowest reaching LOW_PRECISION.
HIGH_PRECISION = 0.97
LOW_PRECISION = 0.90
GOLDEN_CASES = 60


def spam_probability(clf, vec, texts: pd.Series) -> np.ndarray:
    return clf.predict_proba(vec.transform(texts))[:, 1]


def pick_threshold(y: np.ndarray, p: np.ndarray, precision: float) -> float:
    for t in np.arange(0.05, 1.0, 0.01):
        flagged = p >= t
        if flagged.sum() >= 10 and y[flagged].mean() >= precision:
            return round(float(t), 2)
    return 0.99


def combined_verdict(rule_value: float, p: float, t_low: float, t_high: float) -> str:
    """The Go service's decision: the stronger of the rules' verdict and the model's."""
    order = {"looks_safe": 0, "suspicious": 1, "likely_scam": 2}
    model = "likely_scam" if p >= t_high else "suspicious" if p >= t_low else "looks_safe"
    rules = scam_rules.verdict(rule_value)
    return model if order[model] > order[rules] else rules


def prf(y: np.ndarray, flagged: np.ndarray) -> dict[str, float]:
    if len(y) == 0:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "n": 0}
    pr, rc, f1, _ = precision_recall_fscore_support(y, flagged, average="binary", zero_division=0)
    return {
        "precision": round(float(pr), 4),
        "recall": round(float(rc), 4),
        "f1": round(float(f1), 4),
        "n": int(len(y)),
    }


def run(seed: int = 7, out_dir: Path | None = None, sms_path: Path | None = None) -> dict:
    out = out_dir or paths.ARTIFACTS / "scam"
    out.mkdir(parents=True, exist_ok=True)

    df = scam_data.build(seed, sms_path)
    df["split"] = scam_data.split(df, seed)
    parts = {k: df[df["split"] == k] for k in ("train", "val", "test")}

    vec = make_vectorizer()
    clf = LogisticRegression(
        C=10.0, max_iter=3000, solver="lbfgs", class_weight="balanced", random_state=seed
    )
    clf.fit(vec.fit_transform(parts["train"]["text"]), parts["train"]["label"])

    # Thresholds are set where spam is as rare as in real inboxes: the SMS collection's
    # validation rows when present (13% spam), otherwise all validation rows. The generated
    # Nigerian messages are half scams, which would make any threshold look precise.
    val = parts["val"]
    calibration = val[val["source"] == "sms"] if (val["source"] == "sms").sum() >= 100 else val
    p_cal = spam_probability(clf, vec, calibration["text"])
    t_high = pick_threshold(calibration["label"].to_numpy(), p_cal, HIGH_PRECISION)
    t_low = min(pick_threshold(calibration["label"].to_numpy(), p_cal, LOW_PRECISION), t_high)

    test = parts["test"].copy()
    test["p"] = spam_probability(clf, vec, test["text"])
    test["codes"] = test["text"].map(scam_rules.fired)
    test["rule_value"] = test["codes"].map(scam_rules.score)
    test["rules_flag"] = test["rule_value"] >= scam_rules.SUSPICIOUS_AT
    test["model_flag"] = test["p"] >= t_low
    test["system_verdict"] = [
        combined_verdict(r, p, t_low, t_high) for r, p in zip(test["rule_value"], test["p"], strict=True)
    ]
    test["system_flag"] = test["system_verdict"] != "looks_safe"

    def block(rows: pd.DataFrame) -> dict:
        y = rows["label"].to_numpy()
        return {
            "rules_baseline": prf(y, rows["rules_flag"].to_numpy()),
            "model_alone": prf(y, rows["model_flag"].to_numpy()),
            "system": prf(y, rows["system_flag"].to_numpy()),
            "model_pr_auc": round(float(average_precision_score(y, rows["p"])), 4) if y.any() else None,
            "spam": int(y.sum()),
        }

    # Legitimate messages the rules and the model must leave alone: real OTP notices, alerts.
    ham = test[(test["label"] == 0) & (test["source"] == "nigeria")]
    metrics = {
        "model": MODEL_NAME,
        "rows": {k: int(len(v)) for k, v in parts.items()},
        "sources": {k: int(v) for k, v in df["source"].value_counts().items()},
        "thresholds": {"suspicious": t_low, "likely_scam": t_high},
        "test_all": block(test),
        "test_nigeria": block(test[test["source"] == "nigeria"]),
        "test_sms": block(test[test["source"] == "sms"]) if (test["source"] == "sms").any() else None,
        "legit_nigerian_messages_flagged": {
            "rules_baseline": round(float(ham["rules_flag"].mean()), 4) if len(ham) else 0.0,
            "system": round(float(ham["system_flag"].mean()), 4) if len(ham) else 0.0,
            "n": int(len(ham)),
            "templates": int(ham["template"].nunique()),
            "templates_flagged_by_system": int(ham.groupby("template")["system_flag"].mean().gt(0.5).sum()),
        },
        "has_sms_collection": bool((df["source"] == "sms").any()),
    }
    # The SMS collection is the larger, independent test; the Nigerian set is a smoke test.
    ref = metrics["test_sms"] or metrics["test_nigeria"]
    metrics["beats_baseline"] = bool(ref["system"]["f1"] >= ref["rules_baseline"]["f1"])

    terms = [t for t, _ in sorted(vec.vocabulary_.items(), key=lambda kv: kv[1])]
    w = clf.coef_[0]
    b = float(clf.intercept_[0])
    # Two-class softmax with weights (-w/2, +w/2) is exactly the logistic sigmoid of w.x + b,
    # so the Go scorer is the same code as smart categories.
    model_json = {
        "model": MODEL_NAME,
        "format": "tfidf-char_wb-logreg",
        "classes": CLASSES,
        "ngram": list(make_vectorizer().ngram_range),
        "normalize": "lowercase a-z; digit runs become one '0'; everything else is a space (merchants.normalize)",
        "sublinear_tf": True,
        "norm": "l2",
        "terms": terms,
        "idf": [round(float(v), 6) for v in vec.idf_],
        "coef": [[round(float(-v / 2), 5), round(float(v / 2), 5)] for v in w],
        "intercept": [round(-b / 2, 5), round(b / 2, 5)],
        "threshold": t_low,
        "thresholds": {"suspicious": t_low, "likely_scam": t_high},
        "tolerance": 1e-3,
        "trained_with": {"nemml": __version__, "seed": seed},
    }
    golden = golden_cases(model_json, df, seed)

    def write(name: str, text: str) -> None:
        (out / name).write_text(text, encoding="utf-8", newline="\n")

    write("model.json", json.dumps(model_json, separators=(",", ":")) + "\n")
    write("scam_rules.json", json.dumps(scam_rules.export(), indent=1) + "\n")
    write("golden.json", json.dumps(golden, indent=1) + "\n")
    write("metrics.json", json.dumps(metrics, indent=2) + "\n")
    sha = hashlib.sha256((out / "model.json").read_bytes()).hexdigest()
    write("model_card.md", model_card(metrics, sha, seed, len(terms)))
    return {"metrics": metrics, "out_dir": out}


def golden_cases(model: dict, df: pd.DataFrame, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    texts = df.iloc[rng.choice(len(df), GOLDEN_CASES - 14, replace=False)]["text"].tolist()
    # Messages the rules must agree on, in Go as in Python, including the false-alarm guard.
    texts += [
        "",
        "Your Nem Bank OTP is 482913. Do not share it with anyone.",
        "Send me your OTP right now",
        "Dear customer, your account will be blocked. Update your BVN at bit.ly/abc",
        "I mistakenly sent N20,000 to you, please send am back",
        "This is my new number, my phone got spoilt, urgent help",
        "You have won N500,000 in the MTN promo, pay the processing fee to claim",
        "Double your money in 7 days, guaranteed returns of 100% profit",
        "See you at church on Sunday",
        "Please call me urgently, the meeting moved",
        "Your loan is approved! Don't tell anybody",
        "EFCC: your account is frozen",
        "Café Zürich ₦500 PIN",
        "12345 67890",
    ]
    cases = []
    for t in texts:
        cases.append(
            {
                "text": t,
                "probabilities": [round(p, 6) for p in score_text(model, t)],
                "rules": scam_rules.fired(t),
            }
        )
    return {"tolerance": model["tolerance"], "cases": cases}


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x:.1%}"


def model_card(m: dict, sha: str, seed: int, n_terms: int) -> str:
    th = m["thresholds"]

    def row(name: str, b: dict) -> str:
        return f"| {name} | {_pct(b['precision'])} | {_pct(b['recall'])} | {b['f1']:.3f} |"

    def table(title: str, b: dict | None) -> str:
        if not b:
            return f"{title}\n\n_Not available: the SMS Spam Collection was not present when this was trained._\n"
        return (
            f"{title} ({b['spam']} scam messages; PR-AUC of the model alone {b['model_pr_auc']})\n\n"
            "| Step | Precision | Recall | F1 |\n|---|---|---|---|\n"
            f"{row('Rules baseline (message rules)', b['rules_baseline'])}\n"
            f"{row('Model alone', b['model_alone'])}\n"
            f"{row('**System (rules or model, whichever is stronger)**', b['system'])}\n"
        )

    legit = m["legit_nigerian_messages_flagged"]
    return f"""# Model card: {MODEL_NAME} (scam message checker)

Feature AI-2. Trained in Python (`ml/`), scored in pure Go. Reproduce with `uv run nemml scam`.

## Intended use
Tell a customer whether a message they received looks like a scam, with reasons. Their text is checked and discarded: never stored, never sent to an LLM. The answer combines hand-written Nigerian scam rules, link checks and this text model; the rules alone work with no model (non-AI fallback), and the same rules run on the phone with no network. It is advice, not a verdict: it can be wrong in both directions, and it says why.

## Data
- **UCI SMS Spam Collection** (Almeida, Gomez Hidalgo, Yamakami, 2011): {m["sources"].get("sms", 0)} unique real English text messages, 13% spam. CC BY 4.0. {"Included." if m["has_sms_collection"] else "NOT included in this run."}
- **Generated Nigerian messages**: {m["sources"].get("nigeria", 0)} (`ml/src/nemml/scam_data.py`): bank impersonation, BVN/NIN updates, wrong-transfer tricks, advance fees, family emergencies, prizes, investment schemes, in English and Pidgin, and the legitimate look-alikes (bank alerts, real OTP notices that say "do not share", delivery and airtime notices, everyday chat that says "urgent").
- Split by message template (60/20/20, seed {seed}): held-out Nigerian messages are worded in ways the model never saw. Rows: train {m["rows"]["train"]}, validation {m["rows"]["val"]}, test {m["rows"]["test"]}.
- No personal data. Phone numbers and amounts in generated messages are made up.

## Model
`TfidfVectorizer` (character n-grams 2 to 4 inside words, sublinear tf, L2 norm, {n_terms} terms) feeding `LogisticRegression` (balanced class weights). Exported as JSON (`model.json`, SHA-256 `{sha}`); `golden.json` holds {GOLDEN_CASES} cases Go must reproduce, probabilities and fired rules both.
The model alone calls a message **suspicious** at {th["suspicious"]} and a **likely scam** at {th["likely_scam"]} (chosen on validation data with realistic spam rarity, for {LOW_PRECISION:.0%} and {HIGH_PRECISION:.0%} precision).

## Results on held-out messages
{table("### Nigerian messages", m["test_nigeria"])}
{table("### SMS Spam Collection (English, not Nigerian)", m["test_sms"])}
Legitimate Nigerian messages wrongly flagged (held-out, {legit["n"]} messages from only {legit["templates"]} templates): rules alone {_pct(legit["rules_baseline"])}, system {_pct(legit["system"])}; {legit["templates_flagged_by_system"]} of the {legit["templates"]} held-out templates are mostly flagged. With so few templates this is an anecdote, not a rate: a real customer will see false alarms, which is why the verdict is advice with reasons and not a block. The false alarm the rules guard against is a bank's own "your OTP is 482913, do not share it" notice, which mentions the OTP without asking for it.

## Limitations
- **The Nigerian data is generated by me.** There are only a few dozen templates, so the held-out Nigerian set is small (read it as a smoke test, not a benchmark), and the model has seen the style of scam I know how to write. Real scammers adapt.
- The SMS Spam Collection is 2011-era English spam from the UK and Singapore: it teaches "free prize, call now" wording, not Nigerian fraud.
- Links are judged by Go code (look-alike domains, short links, bare IP addresses), not by this model. Account numbers are not scored by it at all.
- Short messages and messages in Yoruba, Igbo or Hausa are weakly covered; Pidgin only by a few templates.
- Character n-grams can be gamed with odd spelling, which is why the rules and link checks run beside it.
- No fairness testing was possible: the data has no demographic fields, and names in templates are placeholders.
"""
