"""Build the training table: PaySim rows + Nigerian-pattern rows, with features.

Reproducible: the same seed and the same inputs give the same table, and the
manifest records a content fingerprint to prove it.
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from nemml import paths
from nemml.features import build_features
from nemml.nigeria import WARMUP_DAYS, simulate_nigeria
from nemml.paysim import load_paysim, simulate_paysim
from nemml.schema import finalise

PAYSIM_WARMUP_HOURS = 168.0


@dataclass(frozen=True)
class DatasetConfig:
    seed: int = 7
    paysim_customers: int = 5000
    nigeria_customers: int = 4000
    paysim_csv: Path | None = None  # None = use ml/data/raw/paysim.csv if present
    paysim_max_customers: int = 20000  # cap when the real 6.3M-row file is used


def build_dataset(cfg: DatasetConfig | None = None) -> tuple[pd.DataFrame, dict]:
    """Return (rows with features and a `warmup` flag, manifest)."""
    cfg = cfg or DatasetConfig()
    csv = cfg.paysim_csv or (paths.PAYSIM_CSV if paths.PAYSIM_CSV.exists() else None)
    if csv is not None:
        paysim = load_paysim(csv, max_customers=cfg.paysim_max_customers, seed=cfg.seed)
        paysim_origin = f"kaggle file {csv.name}"
    else:
        paysim = simulate_paysim(n_customers=cfg.paysim_customers, seed=cfg.seed)
        paysim_origin = "PaySim-style simulator (Kaggle file not present)"
    nigeria = simulate_nigeria(n_customers=cfg.nigeria_customers, seed=cfg.seed + 4)

    # Features are computed per source so a customer id can never collide
    # across sources, then history before the warm-up cut-off is flagged.
    parts = []
    for frame, warmup_h in ((paysim, PAYSIM_WARMUP_HOURS), (nigeria, WARMUP_DAYS * 24.0)):
        feats = build_features(frame)
        feats["warmup"] = feats["ts_hours"] < warmup_h
        parts.append(feats)
    rows = finalise_with_features(pd.concat(parts, ignore_index=True))

    live = rows[~rows["warmup"]]
    manifest = {
        "seed": cfg.seed,
        "paysim_origin": paysim_origin,
        "rows_total": int(len(rows)),
        "rows_after_warmup": int(len(live)),
        "fraud_rate_after_warmup": round(float(live["is_fraud"].mean()), 5),
        "by_source": {
            src: {
                "rows": int(len(g)),
                "fraud": int(g["is_fraud"].sum()),
                "fraud_rate": round(float(g["is_fraud"].mean()), 5),
            }
            for src, g in live.groupby("source")
        },
        "by_scenario": {k: int(v) for k, v in live.groupby("scenario").size().items()},
        "fingerprint": fingerprint(rows),
    }
    return rows, manifest


def finalise_with_features(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.sort_values(["source", "ts_hours", "customer_id"], kind="stable").reset_index(drop=True)


def fingerprint(frame: pd.DataFrame) -> str:
    """Order-sensitive content hash that does not depend on the file format."""
    cols = [c for c in frame.columns if c != "device_id"]
    h = pd.util.hash_pandas_object(frame[cols].round(6), index=False).to_numpy()
    return f"{hashlib.sha256(h.tobytes()).hexdigest()[:16]}-{len(frame)}"


def write_dataset(rows: pd.DataFrame, manifest: dict, out_dir: Path | None = None) -> Path:
    out = out_dir or paths.DATA_GENERATED
    out.mkdir(parents=True, exist_ok=True)
    rows.to_parquet(out / "events.parquet", index=False)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return out


__all__ = ["DatasetConfig", "build_dataset", "write_dataset", "finalise", "fingerprint"]
