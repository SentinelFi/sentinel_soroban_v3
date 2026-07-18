"""Train the XGBoost flight-delay classifier and persist serving artifacts.

This is a port of the modelling cells in `agent/training/model_1.ipynb`
(notebook cells `0bb9cbd0`, `3136bf30`, `87b7ce66`, `13ec2e3c`, `2ef52595`).
The notebook fits OneHotEncoder on `train + Kaggle_test` concatenated; this
script fits OHE on training data only and relies on
`handle_unknown="ignore"` for serving-time unseen categories. This is
expected to shift validation ROC AUC by less than 0.005 vs the notebook.

Run:
    cd agent && python -m training.train
or:
    make train
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder
from xgboost import XGBClassifier

# Paths resolved from this file so the script works regardless of CWD.
AGENT_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = AGENT_ROOT / "data" / "flight_delays_train.csv"
ARTIFACTS_DIR = AGENT_ROOT / "artifacts"

CAT_FEATURES = ["Month", "DayofMonth", "DayOfWeek", "UniqueCarrier", "Origin", "Dest"]
NUM_FEATURES = ["DepTime", "Distance"]
TARGET = "dep_delayed_15min"

# Locked hyperparameters from the notebook (cell 0bb9cbd0, CFG.xgb_params).
XGB_PARAMS = {
    "n_estimators": 200,
    "learning_rate": 0.1,
    "max_depth": 9,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "random_state": 42,
    "n_jobs": -1,
    "eval_metric": "logloss",  # explicit to silence xgboost 2.x default-metric warning
}

RANDOM_STATE = 42
TRAIN_SIZE = 0.7
TEST_VALID_REL = 0.5  # remaining 30% → 50/50 valid/test


def main() -> None:
    if not DATA_PATH.exists():
        raise FileNotFoundError(
            f"Training data not found at {DATA_PATH}. "
            "Run `make download-data` for instructions on the manual Kaggle download."
        )
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[train] Loading {DATA_PATH}")
    df = pd.read_csv(DATA_PATH)
    print(f"[train] Rows: {len(df):,}  Columns: {list(df.columns)}")

    # Target: "N"/"Y" -> 0/1.
    y = df[TARGET].map({"N": 0, "Y": 1}).astype(int)
    X = df[CAT_FEATURES + NUM_FEATURES].copy()

    # OHE on categoricals; passthrough on numericals. handle_unknown="ignore"
    # is what makes the served model robust to unseen Origin/Dest/Carrier.
    preprocessor = ColumnTransformer(
        [
            (
                "cat",
                OneHotEncoder(handle_unknown="ignore", sparse_output=False),
                CAT_FEATURES,
            )
        ],
        remainder="passthrough",
    )

    # 70/15/15 stratified split — matches notebook (cells 3136bf30, 87b7ce66).
    X_train_full, X_temp, y_train_full, y_temp = train_test_split(
        X, y, train_size=TRAIN_SIZE, stratify=y, random_state=RANDOM_STATE
    )
    X_valid, X_test_internal, y_valid, y_test_internal = train_test_split(
        X_temp,
        y_temp,
        test_size=TEST_VALID_REL,
        stratify=y_temp,
        random_state=RANDOM_STATE,
    )
    print(
        f"[train] Splits: train={len(X_train_full):,}  "
        f"valid={len(X_valid):,}  test={len(X_test_internal):,}"
    )

    print("[train] Fitting OneHotEncoder on training categoricals")
    X_train_t = preprocessor.fit_transform(X_train_full)
    X_valid_t = preprocessor.transform(X_valid)
    X_test_t = preprocessor.transform(X_test_internal)

    feature_names = list(preprocessor.get_feature_names_out())
    print(f"[train] Post-OHE feature count: {len(feature_names)}")

    print("[train] Fitting XGBClassifier")
    model = XGBClassifier(**XGB_PARAMS)
    model.fit(X_train_t, y_train_full)

    valid_auc = roc_auc_score(y_valid, model.predict_proba(X_valid_t)[:, 1])
    test_auc = roc_auc_score(y_test_internal, model.predict_proba(X_test_t)[:, 1])

    print()
    print(f"[train] Validation ROC AUC:    {valid_auc:.4f}")
    print(f"[train] Internal test ROC AUC: {test_auc:.4f}")
    print("[train] Notebook reference (cells 2ef52595/ed3361da): ~0.7497 / ~0.7540")
    print()

    # Persist artifacts.
    model_path = ARTIFACTS_DIR / "model.joblib"
    encoder_path = ARTIFACTS_DIR / "encoder.joblib"
    features_path = ARTIFACTS_DIR / "feature_names.json"
    version_path = ARTIFACTS_DIR / "model_version.txt"

    joblib.dump(model, model_path)
    joblib.dump(preprocessor, encoder_path)
    features_path.write_text(json.dumps(feature_names, indent=2))
    version = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    version_path.write_text(version + "\n")

    print(f"[train] Wrote {model_path}")
    print(f"[train] Wrote {encoder_path}")
    print(f"[train] Wrote {features_path}")
    print(f"[train] Wrote {version_path}  (version={version})")


if __name__ == "__main__":
    main()
