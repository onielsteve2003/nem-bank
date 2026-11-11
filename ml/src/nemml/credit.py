"""Train, evaluate and export the credit scoring model (CRD-1, AI-5).

The model estimates the chance a borrower fails to repay from the same aggregates the Go
`credit.Facts` carries: average monthly salary, account age, active savings goals, loans repaid,
loans defaulted. It is a logistic regression on five standardized features, so the exported
JSON is just means, scales, weights and an intercept, and the reason codes are the largest
per-feature contributions. The rules scorer in Go stays as the non-AI fallback.

There is no public Nigerian lending data this project may use, so applicants and their
outcomes are generated (see Limitations in the card). The outcome depends on the five visible
features plus hidden noise, so the model cannot be perfect.
"""

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score

from nemml import __version__, paths

MODEL_NAME = "credit-lr-v1"
N_APPLICANTS = 30_000
GOLDEN_CASES = 40
# Bands by predicted default probability, upper bounds. Above the last is "poor".
BAND_BOUNDS = [("excellent", 0.04), ("good", 0.09), ("fair", 0.18)]
# Share of average monthly salary lent per band, in basis points (the rules scorer lends 30%).
BAND_SHARE_BPS = {"excellent": 4000, "good": 3000, "fair": 2000, "poor": 0}

FEATURES = ["log_salary", "log_age", "goals", "repaid", "defaulted"]


def transform(salary_naira: float, age_days: float, goals: int, repaid: int, defaulted: int) -> list[float]:
    """Raw facts to model inputs. Go repeats exactly this (see credit/model.go)."""
    return [
        math.log1p(max(salary_naira, 0.0)),
        math.log1p(max(age_days, 0.0)),
        float(min(max(goals, 0), 5)),
        float(min(max(repaid, 0), 5)),
        float(min(max(defaulted, 0), 3)),
    ]


def generate(seed: int, n: int = N_APPLICANTS) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    # Monthly salary: log-normal around ₦250k, a share with none yet.
    salary = np.exp(rng.normal(math.log(250_000), 0.75, n)).round(-3)
    salary[rng.random(n) < 0.12] = 0.0
    age = np.minimum(rng.exponential(220, n), 1500).round()
    goals = np.minimum(rng.poisson(1.1, n), 5)
    history = rng.random(n) < 0.35
    repaid = np.where(history, np.minimum(rng.poisson(1.6, n), 5), 0)
    defaulted = np.where(history & (rng.random(n) < 0.12), rng.integers(1, 3, n), 0)
    hidden = rng.normal(0, 0.9, n)  # everything the bank cannot see

    log_salary = np.log1p(salary)
    logit = (
        -2.2
        - 0.55 * (log_salary - 12.3)
        - 0.45 * (np.log1p(age) - 5.0)
        - 0.20 * goals
        - 0.30 * repaid
        + 1.40 * defaulted
        + 1.10 * (salary == 0)
        + hidden
    )
    p = 1 / (1 + np.exp(-logit))
    return pd.DataFrame(
        {
            "salary": salary,
            "age_days": age,
            "goals": goals,
            "repaid": repaid,
            "defaulted": defaulted,
            "default": (rng.random(n) < p).astype(int),
        }
    )


def matrix(df: pd.DataFrame) -> np.ndarray:
    return np.array(
        [
            transform(s, a, int(g), int(r), int(d))
            for s, a, g, r, d in zip(
                df["salary"], df["age_days"], df["goals"], df["repaid"], df["defaulted"], strict=True
            )
        ]
    )


def rules_band(salary: float, defaulted: int, repaid: int) -> int:
    """The Go RulesScorer's band as 0 (poor) to 3 (excellent), the baseline to beat."""
    if defaulted > 0 or salary == 0:
        return 0
    if salary >= 1_000_000 and repaid > 0:
        return 3
    return 2 if salary >= 500_000 else 1


def band_for(p: float) -> str:
    for name, bound in BAND_BOUNDS:
        if p < bound:
            return name
    return "poor"


def run(seed: int = 7, out_dir: Path | None = None) -> dict:
    out = out_dir or paths.ARTIFACTS / "credit"
    out.mkdir(parents=True, exist_ok=True)

    df = generate(seed)
    n = len(df)
    train, test = df.iloc[: int(n * 0.7)], df.iloc[int(n * 0.7) :]
    x_train, x_test = matrix(train), matrix(test)
    mean, scale = x_train.mean(axis=0), x_train.std(axis=0)
    clf = LogisticRegression(C=1.0, max_iter=1000, random_state=seed)
    clf.fit((x_train - mean) / scale, train["default"])
    p_test = clf.predict_proba((x_test - mean) / scale)[:, 1]
    y = test["default"].to_numpy()

    base = np.array(
        [
            rules_band(s, d, r)
            for s, d, r in zip(test["salary"], test["defaulted"], test["repaid"], strict=True)
        ]
    )
    bands = np.array([band_for(p) for p in p_test])
    per_band = {}
    for name in ("excellent", "good", "fair", "poor"):
        m = bands == name
        per_band[name] = {
            "share": round(float(m.mean()), 4),
            "predicted": round(float(p_test[m].mean()), 4) if m.any() else None,
            "observed": round(float(y[m].mean()), 4) if m.any() else None,
        }
    metrics = {
        "model": MODEL_NAME,
        "rows": {"train": len(train), "test": len(test)},
        "default_rate": round(float(df["default"].mean()), 4),
        "test": {
            "roc_auc_model": round(float(roc_auc_score(y, p_test)), 4),
            "roc_auc_rules": round(float(roc_auc_score(y, -base)), 4),
            "brier_model": round(float(brier_score_loss(y, p_test)), 4),
            "brier_constant": round(float(brier_score_loss(y, np.full(len(y), y.mean()))), 4),
            "bands": per_band,
        },
    }
    metrics["beats_baseline"] = metrics["test"]["roc_auc_model"] > metrics["test"]["roc_auc_rules"]

    w = clf.coef_[0]
    model_json = {
        "model": MODEL_NAME,
        "format": "standardized-logreg",
        "target": "probability of default",
        "features": [
            {"name": f, "mean": round(float(m), 6), "scale": round(float(s), 6), "weight": round(float(c), 6)}
            for f, m, s, c in zip(FEATURES, mean, scale, w, strict=True)
        ],
        "intercept": round(float(clf.intercept_[0]), 6),
        "bands": [{"band": b, "below": v} for b, v in BAND_BOUNDS],
        "share_bps": BAND_SHARE_BPS,
        "tolerance": 1e-5,
        "trained_with": {"nemml": __version__, "seed": seed},
    }
    golden = golden_cases(model_json, df, seed)

    def write(name: str, text: str) -> None:
        (out / name).write_text(text, encoding="utf-8", newline="\n")

    write("model.json", json.dumps(model_json, indent=1) + "\n")
    write("golden.json", json.dumps(golden, indent=1) + "\n")
    write("metrics.json", json.dumps(metrics, indent=2) + "\n")
    sha = hashlib.sha256((out / "model.json").read_bytes()).hexdigest()
    write("model_card.md", model_card(metrics, model_json, sha, seed))
    return {"metrics": metrics, "out_dir": out}


def score(model: dict, salary: float, age_days: float, goals: int, repaid: int, defaulted: int) -> float:
    """Reference scorer; the Go one must agree with it on golden.json."""
    x = transform(salary, age_days, goals, repaid, defaulted)
    z = model["intercept"] + sum(
        f["weight"] * (v - f["mean"]) / f["scale"] for f, v in zip(model["features"], x, strict=True)
    )
    return 1 / (1 + math.exp(-z))


def golden_cases(model: dict, df: pd.DataFrame, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    rows = df.iloc[rng.choice(len(df), GOLDEN_CASES - 6, replace=False)]
    cases = [
        {
            "salary": float(r.salary),
            "age_days": int(r.age_days),
            "goals": int(r.goals),
            "repaid": int(r.repaid),
            "defaulted": int(r.defaulted),
        }
        for r in rows.itertuples()
    ]
    cases += [  # edges: nothing at all, clamps, a defaulter, a strong applicant
        {"salary": 0.0, "age_days": 0, "goals": 0, "repaid": 0, "defaulted": 0},
        {"salary": 5_000_000.0, "age_days": 4000, "goals": 9, "repaid": 9, "defaulted": 0},
        {"salary": 300_000.0, "age_days": 400, "goals": 2, "repaid": 1, "defaulted": 5},
        {"salary": 1_200_000.0, "age_days": 900, "goals": 3, "repaid": 4, "defaulted": 0},
        {"salary": 80_000.0, "age_days": 10, "goals": 0, "repaid": 0, "defaulted": 0},
        {"salary": 250_000.0, "age_days": 200, "goals": 1, "repaid": 0, "defaulted": 0},
    ]
    for c in cases:
        c["p"] = round(score(model, c["salary"], c["age_days"], c["goals"], c["repaid"], c["defaulted"]), 8)
        c["band"] = band_for(c["p"])
    return {"tolerance": model["tolerance"], "cases": cases}


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x:.1%}"


def model_card(m: dict, model: dict, sha: str, seed: int) -> str:
    t = m["test"]
    bands = "\n".join(
        f"| {k} | {_pct(v['share'])} | {_pct(v['predicted'])} | {_pct(v['observed'])} |"
        for k, v in t["bands"].items()
    )
    weights = "\n".join(f"| {f['name']} | {f['weight']:+.3f} |" for f in model["features"])
    return f"""# Model card: {MODEL_NAME} (credit scoring)

Feature CRD-1 / AI-5. Trained in Python (`ml/`), scored in pure Go. Reproduce with `uv run nemml credit`.

## Intended use
Estimate how likely a Nem customer is to miss repayment on a small loan, to set a band (excellent, good, fair, poor), a borrowing ceiling and the reasons shown to the customer. Policy (KYC Tier 3, one loan at a time, no past default) is applied after the model and cannot be overridden by it. The rules scorer in Go is the non-AI fallback and answers if the model cannot load. This is a demo: no real money is lent.

## Data
Generated applicants ({m["rows"]["train"]} train, {m["rows"]["test"]} test, seed {seed}) with average monthly salary, account age, active savings goals, loans repaid and loans defaulted. Outcomes are drawn from a hand-written risk function plus hidden noise. Overall default rate {_pct(m["default_rate"])}. No personal data.

## Model
Logistic regression on {len(model["features"])} standardized features; weights below act on the default log-odds, so a negative weight lowers risk. Exported as JSON (`model.json`, SHA-256 `{sha}`); `golden.json` holds {GOLDEN_CASES} cases Go must reproduce within {model["tolerance"]}.

| Feature | Weight |
|---|---|
{weights}

Bands by predicted default probability: excellent below {BAND_BOUNDS[0][1]:.0%}, good below {BAND_BOUNDS[1][1]:.0%}, fair below {BAND_BOUNDS[2][1]:.0%}, otherwise poor (no loan). Reason codes are the features that moved the score most, in plain words.

## Results on held-out applicants
- ROC-AUC: **model {t["roc_auc_model"]}** against rules baseline {t["roc_auc_rules"]} (the Go rules' band as a score).
- Brier score: model {t["brier_model"]} against {t["brier_constant"]} for predicting the average for everyone.

| Band | Share of applicants | Predicted default | Observed default |
|---|---|---|---|
{bands}

## Limitations
- **Everything is synthetic.** The data comes from the same function I wrote the model to find, so these numbers prove the pipeline, not real-world accuracy. A real lender would need its own repayment history.
- Only five aggregates are used. No device, location, contacts or social data, deliberately.
- No fairness testing was possible: there are no demographic fields. Account age and salary can proxy for things they should not; a real rollout needs that audit.
- The model is not retrained from live outcomes yet.
"""
