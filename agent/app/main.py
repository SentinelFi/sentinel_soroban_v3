"""Flight Delay Predictions — FastAPI service (pure prediction API).

Serves exactly what the model was trained on, nothing else: given a
route-level flight description (carrier, origin, dest, month, day of
month, day of week, scheduled departure HHMM, distance), `POST /predict`
returns the calibrated probability of the COVERED EVENT —

    p_covered = P(arrival >= 180 min late  OR  cancelled  OR  diverted)

— graded against the network-average rate (risk: low/moderate/high).
Model: XGBoost (300 trees) + isotonic calibration, trained on 15.4M BTS
Marketing Carrier flights (24 months); see spec/maintenance.md for the
6-month retraining runbook and spec/architecture.md for the system view.

This service knows NOTHING about premiums, payoffs, or insurance — the
protocol's expected-loss pricing lives in the dapp cron
(dapp/api/_lib/route_rules.ts expectedLossPremiumUnits + rails).

Env:
    AGENT_TOKEN         — optional bearer token; when set, /predict
                          requires `Authorization: Bearer <token>`
    AGENT_ARTIFACTS_DIR — override artifacts path (tests)

Run:
    cd agent && python -m uvicorn app.main:app --port 8000
or:
    make serve
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import joblib
import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

AGENT_ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS_DIR = Path(
    os.environ.get("AGENT_ARTIFACTS_DIR", str(AGENT_ROOT / "artifacts"))
)

CAT_FEATURES = ["Month", "DayofMonth", "DayOfWeek", "UniqueCarrier", "Origin", "Dest"]
NUM_FEATURES = ["DepTime", "Distance"]

# Network-average covered-event rate over the v3 training window (24 BTS
# months ending 2026-05; see spec/maintenance.md). /predict grades a
# route's probability against this baseline. Refresh alongside the model.
BASELINE_COVERED_RATE = 0.0342

# Module-level state, populated in lifespan startup.
_state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load model artifacts at startup; fail fast if any are missing."""
    model_path = ARTIFACTS_DIR / "model.joblib"
    encoder_path = ARTIFACTS_DIR / "encoder.joblib"
    version_path = ARTIFACTS_DIR / "model_version.txt"

    for required in (model_path, encoder_path, version_path):
        if not required.exists():
            raise RuntimeError(
                f"Missing artifact: {required}. Run `make train` first. "
                "See agent/README.md for setup."
            )

    _state["model"] = joblib.load(model_path)
    _state["encoder"] = joblib.load(encoder_path)
    _state["model_version"] = version_path.read_text().strip()
    _state["loaded_at"] = datetime.now(timezone.utc).isoformat()
    # Carrier vocabulary the encoder was fitted on (IATA, from BTS data).
    # Anything outside it would one-hot to all-zeros ("unknown carrier")
    # and silently predict without the carrier signal — /predict rejects
    # such requests instead (422).
    _state["known_carriers"] = _known_categories(_state["encoder"], "UniqueCarrier")
    yield
    _state.clear()


app = FastAPI(
    title="Flight Delay Predictions",
    version="0.3.0",
    description=(
        "Route-level disruption model: carrier + route + date + time of day "
        "-> calibrated P(arrival >=180min late OR cancelled OR diverted). "
        "Pure prediction; no pricing."
    ),
    lifespan=lifespan,
)


def require_token(request: Request) -> None:
    """Bearer-token gate for mutating-ish endpoints. No token env → open."""
    token = os.environ.get("AGENT_TOKEN", "")
    if not token:
        return
    if request.headers.get("authorization") != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─── Schemas ──────────────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    # Pydantic 2 reserves the `model_` prefix; opt out so `model_version`
    # passes validation without a warning.
    model_config = ConfigDict(protected_namespaces=())

    status: str
    model_version: str
    loaded_at: str


class PredictRequest(BaseModel):
    """Route-level flight description — no flight number, no payoff.

    The model never sees flight numbers: a route+calendar+time tuple IS
    the entire feature set.
    """

    carrier: str = Field(..., description="IATA carrier code (e.g. 'UA').")
    origin: str = Field(..., description="IATA origin airport code (e.g. 'ORD').")
    dest: str = Field(..., description="IATA destination airport code (e.g. 'SFO').")
    month: int = Field(..., ge=1, le=12)
    day_of_month: int = Field(..., ge=1, le=31)
    day_of_week: int = Field(..., ge=1, le=7, description="Mon=1, Sun=7.")
    dep_time_hhmm: int = Field(1200, ge=0, le=2359, description="Scheduled departure HHMM (default noon).")
    distance_mi: int = Field(1000, ge=0, description="Route distance in miles (default 1000).")


class PredictResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    p_covered: float = Field(description="P(arrival ≥180min late OR cancelled OR diverted) — calibrated.")
    risk: str = Field(description="'low' | 'moderate' | 'high' relative to the network baseline.")
    baseline: float = Field(description="Network-average covered-event rate the risk grade compares against.")
    vs_baseline: float = Field(description="p_covered / baseline — e.g. 2.0 = twice the average risk.")
    model_version: str


# ─── Helpers ──────────────────────────────────────────────────────────────


def _known_categories(encoder: Any, column: str) -> frozenset[str] | None:
    """Category vocabulary the fitted encoder learned for `column`.

    Handles both a bare fitted OneHotEncoder over CAT_FEATURES and a
    ColumnTransformer wrapping one (columns referenced by name or index).
    None = not extractable — validation is then skipped, never guessed.
    """
    try:
        transformers = getattr(encoder, "transformers_", None)
        if transformers is None:
            return frozenset(encoder.categories_[CAT_FEATURES.index(column)])
        all_columns = CAT_FEATURES + NUM_FEATURES
        for _name, trans, cols in transformers:
            cols = [all_columns[c] if isinstance(c, int) else c for c in list(cols)]
            if column in cols and hasattr(trans, "categories_"):
                return frozenset(trans.categories_[cols.index(column)])
    except Exception:
        pass
    return None


def to_notebook_format(req: PredictRequest) -> pd.DataFrame:
    """Translate a request into the model's expected DataFrame format.

    The training pipeline represents Month/DayofMonth/DayOfWeek as `c-{n}`
    strings (e.g. `c-7`, `c-21`); the fitted ColumnTransformer expects the
    same encoding at serving time. Unseen airports are handled by the
    encoder's handle_unknown="ignore"; unseen CARRIERS are rejected with a
    422 in /predict before reaching here (a carrier outside the training
    vocabulary would silently predict without the carrier signal).
    """
    row = {
        "Month": f"c-{req.month}",
        "DayofMonth": f"c-{req.day_of_month}",
        "DayOfWeek": f"c-{req.day_of_week}",
        "UniqueCarrier": req.carrier,
        "Origin": req.origin,
        "Dest": req.dest,
        "DepTime": req.dep_time_hhmm,
        "Distance": req.distance_mi,
    }
    return pd.DataFrame([row], columns=CAT_FEATURES + NUM_FEATURES)


def predict_p_covered(req: PredictRequest) -> float:
    """Run the calibrated model on one route/calendar/time tuple."""
    encoder = _state.get("encoder")
    model = _state.get("model")
    if encoder is None or model is None:
        raise HTTPException(status_code=503, detail="Model artifacts not loaded.")
    X = encoder.transform(to_notebook_format(req))
    return float(model.predict_proba(X)[0, 1])


# ─── Routes ───────────────────────────────────────────────────────────────


@app.get("/")
def banner() -> dict[str, str]:
    return {
        "service": "flight-delay-predictions",
        "see": "POST /predict, GET /healthz",
    }


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    if "model_version" not in _state:
        raise HTTPException(status_code=503, detail="Model artifacts not loaded.")
    return HealthResponse(
        status="ok",
        model_version=str(_state["model_version"]),
        loaded_at=str(_state["loaded_at"]),
    )


@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(require_token)])
def predict(req: PredictRequest) -> PredictResponse:
    """Route-level delay outlook: route + date + time → calibrated probability.

    A single flight's disruption is never a certainty, so the honest answer
    is a probability graded against the network baseline — 'high' means
    this route/day/time historically misses several times more often than
    average, not that THIS flight will.
    """
    known = _state.get("known_carriers")
    if known is not None and req.carrier not in known:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown carrier '{req.carrier}'. Expected an IATA code the model "
                f"was trained on (e.g. UA, AA, DL) — ICAO codes (UAL, AAL) are not "
                f"accepted; convert first."
            ),
        )
    p = predict_p_covered(req)
    vs = p / BASELINE_COVERED_RATE
    risk = "low" if vs < 0.75 else "moderate" if vs < 2.0 else "high"
    return PredictResponse(
        p_covered=p,
        risk=risk,
        baseline=BASELINE_COVERED_RATE,
        vs_baseline=round(vs, 2),
        model_version=str(_state["model_version"]),
    )
