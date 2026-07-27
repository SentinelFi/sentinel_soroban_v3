"""Train the flight-risk model on weather-enriched BTS data (2023-2025).

v2 (2026-07-27) — retargeted to the PROTOCOL'S COVERED EVENT and modern
data, replacing the 2008 Kaggle departure-delay proxy:

    label = 1  iff  ARR_DELAY >= THRESHOLD_MIN (default 180)
                 OR CANCELLED == 1
                 OR DIVERTED == 1   (diverted pays as cancellation — policy)

Rows that never produced an outcome (null ARR_DELAY without a
cancelled/diverted flag) are dropped: they cannot be labeled.

Data: stratified 1% sample of BTS "Marketing Carrier On-Time Performance"
2023-2025, weather-enriched (Meteostat) per origin/destination. ~148k rows,
~2.6% positive — imbalanced, so the classifier is followed by ISOTONIC
CALIBRATION on the validation split: expected-loss pricing multiplies
p * payoff, and an uncalibrated score is a price error, not just a rank
error. Serving artifacts stay drop-in (model.joblib exposes
predict_proba; encoder.joblib is the fitted ColumnTransformer).

Feature set is the SERVING CONTRACT set — exactly what /price receives
today (no weather at serving time yet; a weather-augmented model needs the
/price schema extended to carry forecasts and is left as a follow-up):
    Month, DayofMonth, DayOfWeek (as c-N strings — serving compatibility),
    UniqueCarrier, Origin, Dest (one-hot, unknown-tolerant),
    DepTime (HHMM), Distance (miles).

Run:
    make train                                       # full data
    python -m training.train --data data/delay_data.sample.csv  # pipeline smoke
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.compose import ColumnTransformer
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder
from xgboost import XGBClassifier

AGENT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = AGENT_ROOT / "data" / "delay_data.csv"
ARTIFACTS_DIR = AGENT_ROOT / "artifacts"

# Serving-contract features (must match app/main.py::to_notebook_format).
CAT_FEATURES = ["Month", "DayofMonth", "DayOfWeek", "UniqueCarrier", "Origin", "Dest"]
NUM_FEATURES = ["DepTime", "Distance"]

THRESHOLD_MIN = 180  # the protocol's covered arrival delay

XGB_PARAMS = {
    "n_estimators": 300,
    "learning_rate": 0.08,
    "max_depth": 7,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "random_state": 42,
    "n_jobs": -1,
    "eval_metric": "logloss",
}

RANDOM_STATE = 42


def load_and_label(path: Path, threshold_min: int) -> tuple[pd.DataFrame, pd.Series]:
    """Raw weather-enriched BTS CSV → serving-contract features + covered-event label."""
    usecols = [
        "MONTH", "DAY_OF_MONTH", "DAY_OF_WEEK", "OP_UNIQUE_CARRIER",
        "ORIGIN", "DEST", "CRS_DEP_TIME", "DISTANCE",
        "ARR_DELAY", "CANCELLED", "DIVERTED",
    ]
    df = pd.read_csv(path, usecols=usecols)
    n_raw = len(df)

    cancelled = df["CANCELLED"].fillna(0).astype(float) >= 1
    diverted = df["DIVERTED"].fillna(0).astype(float) >= 1
    delayed = df["ARR_DELAY"].astype(float) >= threshold_min  # NaN compares False

    # Unlabelable: no arrival outcome and neither cancelled nor diverted.
    unlabelable = df["ARR_DELAY"].isna() & ~cancelled & ~diverted
    df = df[~unlabelable]
    y = (delayed | cancelled | diverted)[~unlabelable].astype(int)

    X = pd.DataFrame(
        {
            # c-N string encoding — the serving path sends the same shapes.
            "Month": "c-" + df["MONTH"].astype(int).astype(str),
            "DayofMonth": "c-" + df["DAY_OF_MONTH"].astype(int).astype(str),
            "DayOfWeek": "c-" + df["DAY_OF_WEEK"].astype(int).astype(str),
            "UniqueCarrier": df["OP_UNIQUE_CARRIER"].astype(str),
            "Origin": df["ORIGIN"].astype(str),
            "Dest": df["DEST"].astype(str),
            "DepTime": df["CRS_DEP_TIME"].fillna(0).astype(int),
            "Distance": df["DISTANCE"].fillna(0).astype(float),
        }
    )
    print(f"[train] Rows: {n_raw:,} raw → {len(X):,} labeled "
          f"(dropped {n_raw - len(X):,} unlabelable); positives: {int(y.sum()):,} ({y.mean()*100:.2f}%)")
    return X, y


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA)
    ap.add_argument("--threshold-min", type=int, default=THRESHOLD_MIN)
    args = ap.parse_args()

    if not args.data.exists():
        raise FileNotFoundError(f"Training data not found at {args.data}")
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[train] Loading {args.data} (covered event: arr>={args.threshold_min}min OR cancelled OR diverted)")
    X, y = load_and_label(args.data, args.threshold_min)

    smoke = len(X) < 1_000  # tiny sample → pipeline smoke test, not a model
    if smoke:
        print("[train] <1000 rows — SMOKE MODE: no stratify/calibration, artifacts land in artifacts/smoke/")

    preprocessor = ColumnTransformer(
        [("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), CAT_FEATURES)],
        remainder="passthrough",
    )

    stratify = None if smoke else y
    X_train, X_temp, y_train, y_temp = train_test_split(
        X, y, train_size=0.7, stratify=stratify, random_state=RANDOM_STATE
    )
    X_valid, X_test, y_valid, y_test = train_test_split(
        X_temp, y_temp, test_size=0.5,
        stratify=None if smoke else y_temp, random_state=RANDOM_STATE
    )
    print(f"[train] Splits: train={len(X_train):,} valid={len(X_valid):,} test={len(X_test):,}")

    X_train_t = preprocessor.fit_transform(X_train)
    X_valid_t = preprocessor.transform(X_valid)
    X_test_t = preprocessor.transform(X_test)
    feature_names = list(preprocessor.get_feature_names_out())
    print(f"[train] Post-OHE feature count: {len(feature_names)}")

    base = XGBClassifier(**XGB_PARAMS)
    base.fit(X_train_t, y_train)

    if smoke:
        model = base
    else:
        # Isotonic calibration on the held-out validation split: the premium
        # is p * payoff * margin — the PRICE is only as honest as p.
        model = CalibratedClassifierCV(base, method="isotonic", cv="prefit")
        model.fit(X_valid_t, y_valid)

    def report(name: str, Xt, yt) -> None:
        p = model.predict_proba(Xt)[:, 1]
        auc = roc_auc_score(yt, p) if yt.nunique() > 1 else float("nan")
        brier = brier_score_loss(yt, p)
        print(f"[train] {name}: ROC AUC={auc:.4f}  Brier={brier:.5f}  "
              f"mean p={p.mean():.4f}  actual rate={yt.mean():.4f}")

    print()
    report("valid (calibration split)", X_valid_t, y_valid)
    report("test  (held out)         ", X_test_t, y_test)
    print()

    out_dir = ARTIFACTS_DIR / "smoke" if smoke else ARTIFACTS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out_dir / "model.joblib")
    joblib.dump(preprocessor, out_dir / "encoder.joblib")
    (out_dir / "feature_names.json").write_text(json.dumps(feature_names, indent=2))
    version = (
        f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"
        f"-bts2023_25-arr{args.threshold_min}m"
    )
    (out_dir / "model_version.txt").write_text(version + "\n")
    print(f"[train] Artifacts → {out_dir}  (version={version})")


if __name__ == "__main__":
    main()
