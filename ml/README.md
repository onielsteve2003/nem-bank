# Nem Bank ML

Models are trained here in Python and scored in pure Go inside the API (ADR-8). There is no Python service in production.

## Setup

```
cd ml
uv sync
uv run pytest
```

## Data

```
uv run nemml data          # writes ml/data/generated/events.parquet + manifest.json
```

Two sources share one event table (`src/nemml/schema.py`):

| Source | What it is | Licence |
|---|---|---|
| PaySim | The real Kaggle file if you drop it at `ml/data/raw/paysim.csv`; otherwise a PaySim-style simulator with the same fraud pattern (victim drained to a fresh mule, who cashes out). | PaySim: CC BY-SA 4.0 (Lopez-Rojas et al.). Simulator: this repo. |
| Nigerian patterns | `src/nemml/nigeria.py`: honest salary-driven behaviour with real-looking outliers (rent, school fees), plus account takeover, authorised push payment and mule cash-out attacks. All synthetic. | This repo |

Everything is seeded: the same seed gives the same table, and `manifest.json` carries a content fingerprint.

## Layout

```
src/nemml/
  schema.py     the shared event table
  paysim.py     real PaySim loader + PaySim-style simulator
  nigeria.py    Nigerian behaviour and fraud scenarios
  features.py   point-in-time fraud features (history before the row only)
  rules.py      the hand-written rules baseline
  dataset.py    builds and fingerprints the training table
  cli.py        `nemml` command
tests/          reproducibility, schema, leakage and feature tests
artifacts/      trained models and model cards (committed)
```
