"""Filesystem layout. Everything is relative to the ml/ project root."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_RAW = ROOT / "data" / "raw"  # downloaded datasets, gitignored
DATA_GENERATED = ROOT / "data" / "generated"  # reproducible output, gitignored
ARTIFACTS = ROOT / "artifacts"  # trained models and model cards, committed

PAYSIM_CSV = DATA_RAW / "paysim.csv"
