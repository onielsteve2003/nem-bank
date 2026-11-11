"""Train, evaluate and export the fraud model (AI-1).

Pipeline: build the table, split by time (train on the past, test on the
future), fit LightGBM, compare with the rules baseline on the same held-out
rows, pick the allow / step-up / hold thresholds on validation data, then write
everything the Go risk engine and the model card need to `ml/artifacts/fraud/`.
"""

import hashlib
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score

from nemml import __version__, paths
from nemml.dataset import DatasetConfig, build_dataset
from nemml.features import FEATURES, model_matrix
from nemml.rules import RULES, rules_score

MODEL_NAME = "fraud-lgbm-v1"
# Share of rows for train / validation / test, by time within each source.
SPLIT = (0.6, 0.2, 0.2)
# Thresholds are the lowest score reaching this precision on validation data.
HOLD_PRECISION = 0.85
STEP_UP_PRECISION = 0.40

PARAMS = {
    "objective": "binary",
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_child_samples": 40,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "metric": "average_precision",
    "verbosity": -1,
    "num_threads": 1,
    "deterministic": True,
    "force_row_wise": True,
}


def time_split(rows: pd.DataFrame) -> pd.Series:
    """Label each row train / val / test by time quantile within its source."""
    label = pd.Series("train", index=rows.index)
    for _, g in rows.groupby("source"):
        a, b = g["ts_hours"].quantile([SPLIT[0], SPLIT[0] + SPLIT[1]])
        label.loc[g.index[g["ts_hours"] > a]] = "val"
        label.loc[g.index[g["ts_hours"] > b]] = "test"
    return label


def precision_at_k(y: np.ndarray, score: np.ndarray, k: int) -> float:
    k = max(1, min(k, len(y)))
    top = np.argsort(-score, kind="stable")[:k]
    return float(y[top].mean())


def recall_at_alert_rate(y: np.ndarray, score: np.ndarray, rate: float) -> float:
    k = max(1, int(round(len(y) * rate)))
    top = np.argsort(-score, kind="stable")[:k]
    return float(y[top].sum() / max(1, y.sum()))


def threshold_for_precision(y: np.ndarray, score: np.ndarray, precision: float) -> float:
    """Lowest score whose precision (flagging everything >= it) reaches `precision`."""
    p, _, t = precision_recall_curve(y, score)
    ok = np.where(p[:-1] >= precision)[0]
    return float(t[ok[0]]) if len(ok) else float(score.max())


def evaluate(y: np.ndarray, score: np.ndarray) -> dict:
    n_pos = int(y.sum())
    return {
        "rows": int(len(y)),
        "fraud": n_pos,
        "pr_auc": round(float(average_precision_score(y, score)), 4),
        "roc_auc": round(float(roc_auc_score(y, score)), 4),
        "precision_at_100": round(precision_at_k(y, score, 100), 4),
        "precision_at_n_fraud": round(precision_at_k(y, score, n_pos), 4),
        "recall_at_1pct_alerts": round(recall_at_alert_rate(y, score, 0.01), 4),
    }


def at_threshold(y: np.ndarray, score: np.ndarray, threshold: float) -> dict:
    flagged = score >= threshold
    tp = int((flagged & (y == 1)).sum())
    return {
        "threshold": round(float(threshold), 6),
        "alert_rate": round(float(flagged.mean()), 5),
        "precision": round(tp / max(1, int(flagged.sum())), 4),
        "recall": round(tp / max(1, int(y.sum())), 4),
    }


def run(cfg: DatasetConfig | None = None, out_dir: Path | None = None) -> dict:
    cfg = cfg or DatasetConfig()
    out = out_dir or (paths.ARTIFACTS / "fraud")
    out.mkdir(parents=True, exist_ok=True)

    rows, manifest = build_dataset(cfg)
    rows = rows[~rows["warmup"]].reset_index(drop=True)
    rows["split"] = time_split(rows)
    parts = {name: rows[rows["split"] == name] for name in ("train", "val", "test")}
    x = {k: model_matrix(v) for k, v in parts.items()}
    y = {k: v["is_fraud"].to_numpy() for k, v in parts.items()}

    booster = lgb.train(
        {**PARAMS, "seed": cfg.seed},
        lgb.Dataset(x["train"], y["train"]),
        num_boost_round=800,
        valid_sets=[lgb.Dataset(x["val"], y["val"])],
        callbacks=[lgb.early_stopping(50, verbose=False)],
    )
    best_iteration = int(booster.best_iteration)
    booster.save_model(str(out / "model.txt"), num_iteration=best_iteration)
    # `leaves` (the pure-Go scorer) reads the v3 text format. LightGBM 4 writes "version=v4" for
    # the same trees when there are no categorical features, so the header is the only change;
    # the Go golden test (apps/api/internal/risk) proves the scores are identical.
    model_path = out / "model.txt"
    with open(model_path, newline="") as fh:
        text = fh.read()
    with open(model_path, "w", newline="") as fh:
        fh.write(text.replace("version=v4", "version=v3", 1))

    # Scores. The rules baseline is scaled to 0-1 only so the two read alike.
    model_score = {k: booster.predict(x[k], num_iteration=best_iteration) for k in x}
    max_points = sum(r.points for r in RULES)
    rule_score = {k: rules_score(parts[k]) / max_points for k in parts}

    hold_t = threshold_for_precision(y["val"], model_score["val"], HOLD_PRECISION)
    step_t = min(threshold_for_precision(y["val"], model_score["val"], STEP_UP_PRECISION), hold_t)
    thresholds = {"step_up": step_t, "hold": hold_t}
    # The rules engine gets thresholds chosen the same way, for a fair comparison.
    r_hold = threshold_for_precision(y["val"], rule_score["val"], HOLD_PRECISION)
    r_step = min(threshold_for_precision(y["val"], rule_score["val"], STEP_UP_PRECISION), r_hold)

    test = parts["test"]
    by_source = {}
    for src in test["source"].unique():
        idx = np.where(test["source"].to_numpy() == src)[0]
        if y["test"][idx].sum() == 0:
            continue
        by_source[src] = {
            "model": evaluate(y["test"][idx], model_score["test"][idx]),
            "rules": evaluate(y["test"][idx], rule_score["test"][idx]),
        }

    scenarios = {}
    hold_flag = model_score["test"] >= hold_t
    step_flag = model_score["test"] >= step_t
    rule_flag = rule_score["test"] >= r_step
    for scen in test.loc[test["is_fraud"] == 1, "scenario"].unique():
        idx = np.where(test["scenario"].to_numpy() == scen)[0]
        scenarios[scen] = {
            "fraud_rows": int(len(idx)),
            "model_caught_step_up_or_hold": round(float(step_flag[idx].mean()), 4),
            "model_caught_hold": round(float(hold_flag[idx].mean()), 4),
            "rules_caught_step_up_or_hold": round(float(rule_flag[idx].mean()), 4),
        }

    importance = dict(
        sorted(
            zip(FEATURES, booster.feature_importance("gain").round(1).tolist(), strict=True),
            key=lambda kv: -kv[1],
        )
    )
    model_eval = evaluate(y["test"], model_score["test"])
    rules_eval = evaluate(y["test"], rule_score["test"])
    metrics = {
        "summary": {
            "model": MODEL_NAME,
            "test_rows": model_eval["rows"],
            "test_fraud": model_eval["fraud"],
            "pr_auc_model": model_eval["pr_auc"],
            "pr_auc_rules": rules_eval["pr_auc"],
            "beats_baseline": model_eval["pr_auc"] > rules_eval["pr_auc"],
        },
        "test": {"model": model_eval, "rules": rules_eval},
        "test_by_source": by_source,
        "test_by_scenario": scenarios,
        "operating_points_test": {
            "model_step_up": at_threshold(y["test"], model_score["test"], step_t),
            "model_hold": at_threshold(y["test"], model_score["test"], hold_t),
            "rules_step_up": at_threshold(y["test"], rule_score["test"], r_step),
            "rules_hold": at_threshold(y["test"], rule_score["test"], r_hold),
        },
        "feature_importance_gain": importance,
        "split_rows": {k: int(len(v)) for k, v in parts.items()},
        "best_iteration": best_iteration,
    }

    export = {
        "model": MODEL_NAME,
        "format": "lightgbm-text",
        "file": "model.txt",
        "features": FEATURES,
        "missing_value": "NaN (unknown device or account age; the model has learned a default direction)",
        "output": "probability of fraud, 0-1",
        "thresholds": {k: round(v, 6) for k, v in thresholds.items()},
        "decision": "score < step_up: allow; step_up <= score < hold: step_up; score >= hold: hold",
        "rules": [{"code": r.code, "points": r.points, "description": r.description} for r in RULES],
        "trained_with": {"nemml": __version__, "lightgbm": lgb.__version__, "seed": cfg.seed},
        "dataset_fingerprint": manifest["fingerprint"],
        "model_sha256": hashlib.sha256((out / "model.txt").read_bytes()).hexdigest(),
    }
    (out / "export.json").write_text(json.dumps(export, indent=2) + "\n", encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    write_golden(out, booster, best_iteration, test, x["test"], y["test"])
    (out / "model_card.md").write_text(model_card(export, metrics, manifest), encoding="utf-8")
    return {"metrics": metrics, "export": export, "out_dir": out}


def write_golden(out: Path, booster, best_iteration: int, test, x_test, y_test) -> None:
    """Fixed inputs with their scores so the Go port can prove parity (T29.3)."""
    rng = np.random.default_rng(0)
    pos = np.where(y_test == 1)[0]
    neg = np.where(y_test == 0)[0]
    pick = np.concatenate(
        [rng.choice(pos, size=min(25, len(pos)), replace=False), rng.choice(neg, size=25, replace=False)]
    )
    sample = x_test.iloc[pick]
    scores = booster.predict(sample, num_iteration=best_iteration)
    cases = [
        {
            "features": {k: (None if pd.isna(v) else round(float(v), 6)) for k, v in row.items()},
            "score": round(float(s), 8),
        }
        for (_, row), s in zip(sample.iterrows(), scores, strict=True)
    ]
    (out / "golden.json").write_text(
        json.dumps({"tolerance": 1e-6, "cases": cases}, indent=1) + "\n", encoding="utf-8"
    )


def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def model_card(export: dict, m: dict, manifest: dict) -> str:
    t = m["test"]
    op = m["operating_points_test"]
    lines = [
        f"# Model card: {export['model']} (fraud risk scoring)",
        "",
        "Feature AI-1. Scored in pure Go with `leaves`; trained in Python (`ml/`). Reproduce with `uv run nemml fraud`.",
        "",
        "## Intended use",
        "Score every outgoing transfer before it is sent and return `allow`, `step_up` (ask for more proof) or `hold` "
        "(wait for staff review) with reason codes. It runs beside hand-written rules; if the model is unavailable "
        "the rules alone decide (non-AI fallback). It is a demo of the technique, not a production fraud system.",
        "",
        "## Data",
        f"- Source: {manifest['paysim_origin']} plus a synthetic Nigerian pattern generator (`ml/src/nemml/nigeria.py`).",
        f"- {manifest['rows_after_warmup']:,} rows after a history warm-up, fraud rate {_pct(manifest['fraud_rate_after_warmup'])}.",
        f"- Scenarios: {', '.join(f'{k} ({v:,})' for k, v in manifest['by_scenario'].items())}.",
        "- Split by time, not at random: train on the earliest 60% of each source, validate on the next 20%, test on the "
        "final 20%, so the test set is the future relative to training.",
        f"- Fingerprint `{manifest['fingerprint']}`, seed {export['trained_with']['seed']}.",
        "- Licences: PaySim is CC BY-SA 4.0 (Lopez-Rojas et al., 2016); the Nigerian generator is original to this repo. "
        "No real customer data was used.",
        "",
        "## Features",
        ", ".join(f"`{f}`" for f in export["features"])
        + ". Each uses only the customer's earlier activity (checked by a test that removes the future).",
        "",
        "## Results on the held-out test set",
        f"{t['model']['rows']:,} rows, {t['model']['fraud']:,} fraud.",
        "",
        "| Metric | Rules baseline | LightGBM |",
        "|---|---|---|",
        f"| PR-AUC | {t['rules']['pr_auc']} | **{t['model']['pr_auc']}** |",
        f"| ROC-AUC | {t['rules']['roc_auc']} | {t['model']['roc_auc']} |",
        f"| Precision@100 | {t['rules']['precision_at_100']} | {t['model']['precision_at_100']} |",
        f"| Precision@(number of fraud rows) | {t['rules']['precision_at_n_fraud']} | {t['model']['precision_at_n_fraud']} |",
        f"| Recall when flagging the top 1% | {t['rules']['recall_at_1pct_alerts']} | {t['model']['recall_at_1pct_alerts']} |",
        "",
        "Thresholds are chosen on validation data, then applied unchanged to the test set:",
        "",
        "| Decision | Rule | Alert rate | Precision | Recall |",
        "|---|---|---|---|---|",
    ]
    for label, key in (
        ("Rules, step-up or hold", "rules_step_up"),
        ("Model, step-up or hold", "model_step_up"),
        ("Rules, hold", "rules_hold"),
        ("Model, hold", "model_hold"),
    ):
        o = op[key]
        lines.append(
            f"| {label} | score >= {o['threshold']} | {_pct(o['alert_rate'])} | {_pct(o['precision'])} | {_pct(o['recall'])} |"
        )
    lines += ["", "### By source (PR-AUC, rules vs model)", "", "| Source | Rules | Model |", "|---|---|---|"]
    for src, v in m["test_by_source"].items():
        lines.append(f"| {src} | {v['rules']['pr_auc']} | {v['model']['pr_auc']} |")
    lines += [
        "",
        "### Fraud caught by scenario (step-up or hold)",
        "",
        "| Scenario | Fraud rows | Rules | Model | Model, hold |",
        "|---|---|---|---|---|",
    ]
    for scen, v in m["test_by_scenario"].items():
        lines.append(
            f"| {scen} | {v['fraud_rows']} | {_pct(v['rules_caught_step_up_or_hold'])} | "
            f"{_pct(v['model_caught_step_up_or_hold'])} | {_pct(v['model_caught_hold'])} |"
        )
    lines += [
        "",
        "## Limitations",
        "- **The data is synthetic.** The fraud patterns were written by me, and the model learns the patterns I wrote. "
        "These numbers show the pipeline works; they do not predict performance on real Nigerian fraud.",
        "- PaySim-style fraud (an account drained to a fresh mule) is easy to separate, which is also true of the real PaySim "
        "file. Read the Nigerian-source numbers, not the pooled ones, as the more honest measure.",
        "- Authorised push payment scams look like a real customer making a deliberate payment, so they are the weakest "
        "scenario. Rules, models and users all struggle here; staff review and customer warnings matter more than scores.",
        "- Reason codes come from the rules, not the model. The model gives a score; the rules explain it.",
        "- No fairness testing was possible because the data has no demographic fields. Features avoid names, phone "
        "numbers, location and any personal attribute.",
        "- Attackers adapt. A real deployment needs retraining on labelled cases (the console's fraud queue records them) "
        "and drift monitoring.",
        "",
        "## Safety",
        "A `hold` never rejects money silently: the customer sees why and staff can release it. The risk engine (T29.3) "
        "combines model and rules so the model can only add friction (step-up or hold); it cannot approve "
        "something the rules would block.",
        "",
        f"Model file SHA-256: `{export['model_sha256']}`.",
        "",
    ]
    return "\n".join(lines)
