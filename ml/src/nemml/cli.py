"""Command line: `uv run nemml data` and `uv run nemml fraud`."""

import argparse
import json
import sys

from nemml.dataset import DatasetConfig, build_dataset, write_dataset


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nemml", description="Nem Bank ML pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    data = sub.add_parser("data", help="generate the training table")
    data.add_argument("--seed", type=int, default=7)
    data.add_argument("--paysim-customers", type=int, default=5000)
    data.add_argument("--nigeria-customers", type=int, default=4000)

    fraud = sub.add_parser("fraud", help="train, evaluate and export the fraud model")
    fraud.add_argument("--seed", type=int, default=7)
    fraud.add_argument("--out", default=None, help="artifact directory (default ml/artifacts/fraud)")

    args = parser.parse_args(argv)
    cfg = DatasetConfig(seed=args.seed)
    if args.command == "data":
        cfg = DatasetConfig(
            seed=args.seed,
            paysim_customers=args.paysim_customers,
            nigeria_customers=args.nigeria_customers,
        )
        rows, manifest = build_dataset(cfg)
        out = write_dataset(rows, manifest)
        print(json.dumps(manifest, indent=2))
        print(f"wrote {out}")
        return 0

    from pathlib import Path

    from nemml.fraud import run

    result = run(cfg, Path(args.out) if args.out else None)
    print(json.dumps(result["metrics"]["summary"], indent=2))
    print(f"wrote {result['out_dir']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
