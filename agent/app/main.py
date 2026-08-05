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

DELAY TIERS (2026-08-05). The 180-minute threshold is the protocol's
live covered event, but it is not the only interesting one, so two
shorter-threshold siblings are trained from the same BTS window and
served on their own paths:

    POST /predict       -> 180 min  (artifacts/)       — the live model
    POST /predict/60m   ->  60 min  (artifacts/arr60/)
    POST /predict/30m   ->  30 min  (artifacts/arr30/)

Same features, same pipeline, same calibration — only the label's delay
threshold differs. `/predict` is untouched by their addition and stays
the sole endpoint the protocol prices from; the tiers are additive and
OPTIONAL (a missing artifacts/arr30 or artifacts/arr60 downgrades that
one path to a 503 and leaves the rest of the service healthy).

Because the three models are fitted independently, their probabilities
are not guaranteed monotone per request (p30 >= p60 >= p180 holds for
the LABELS by construction, and in aggregate, but a single route/date
can invert slightly). Do not build logic that assumes ordering.

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

import json
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
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

# Same window, shorter thresholds — the delay-tier siblings. A trained
# artifacts dir ships its own measured rate in metrics.json and that wins;
# these constants are the fallback when the file is absent.
BASELINE_60M_RATE = 0.0953
BASELINE_30M_RATE = 0.1581


@dataclass(frozen=True)
class ModelSpec:
    """One trained threshold: where it lives and how it is graded."""

    key: str  # registry key / URL suffix ("180", "60", "30")
    threshold_min: int
    subdir: str  # relative to ARTIFACTS_DIR; "" = the root (live) set
    fallback_baseline: float
    required: bool  # a missing REQUIRED model fails startup

    @property
    def path(self) -> Path:
        return ARTIFACTS_DIR / self.subdir if self.subdir else ARTIFACTS_DIR


# The live 180m model is REQUIRED — the service has no reason to exist
# without it, so a missing artifact still fails fast exactly as before.
# The tiers are optional: they must never be able to take the protocol's
# endpoint down with them.
MODELS: tuple[ModelSpec, ...] = (
    ModelSpec("180", 180, "", BASELINE_COVERED_RATE, required=True),
    ModelSpec("60", 60, "arr60", BASELINE_60M_RATE, required=False),
    ModelSpec("30", 30, "arr30", BASELINE_30M_RATE, required=False),
)

# Module-level state, populated in lifespan startup.
_state: dict[str, Any] = {}


def _load_one(spec: ModelSpec) -> dict[str, Any] | None:
    """Load one threshold's artifacts, or None when they aren't there."""
    model_path = spec.path / "model.joblib"
    encoder_path = spec.path / "encoder.joblib"
    version_path = spec.path / "model_version.txt"

    for required in (model_path, encoder_path, version_path):
        if not required.exists():
            if spec.required:
                raise RuntimeError(
                    f"Missing artifact: {required}. Run `make train` first. "
                    "See agent/README.md for setup."
                )
            print(f"[agent] tier {spec.threshold_min}m not loaded — no {required}")
            return None

    encoder = joblib.load(encoder_path)
    return {
        "spec": spec,
        "model": joblib.load(model_path),
        "encoder": encoder,
        "model_version": version_path.read_text().strip(),
        "baseline": _baseline_for(spec),
        # Carrier vocabulary the encoder was fitted on (IATA, from BTS
        # data). Anything outside it would one-hot to all-zeros ("unknown
        # carrier") and silently predict without the carrier signal — the
        # predict endpoints reject such requests instead (422).
        "known_carriers": _known_categories(encoder, "UniqueCarrier"),
    }


def _baseline_for(spec: ModelSpec) -> float:
    """Measured positive rate from metrics.json, else the code constant.

    The trainer writes metrics.json next to the model, so a retrain can
    never leave the risk grading pinned to a stale hand-copied rate. The
    constant remains the answer for artifact sets predating that file —
    which includes today's shipped 180m model.
    """
    try:
        metrics = json.loads((spec.path / "metrics.json").read_text())
        rate = float(metrics["test"]["actual_rate"])
        if 0.0 < rate < 1.0:
            return rate
        print(f"[agent] tier {spec.threshold_min}m: implausible metrics rate {rate}")
    except FileNotFoundError:
        pass
    except Exception as err:  # noqa: BLE001
        print(f"[agent] tier {spec.threshold_min}m: unreadable metrics.json — {err}")
    return spec.fallback_baseline


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load model artifacts at startup; fail fast if a required one is missing."""
    loaded: dict[str, dict[str, Any]] = {}
    for spec in MODELS:
        entry = _load_one(spec)
        if entry is not None:
            loaded[spec.key] = entry

    _state["models"] = loaded
    _state["loaded_at"] = datetime.now(timezone.utc).isoformat()
    # /healthz reports the LIVE model's version — unchanged contract.
    _state["model_version"] = loaded["180"]["model_version"]
    print(f"[agent] loaded thresholds: {', '.join(sorted(loaded, key=int))}")
    yield
    _state.clear()


app = FastAPI(
    title="Flight Delay Predictions",
    version="0.4.0",
    description=(
        "Route-level disruption model: carrier + route + date + time of day "
        "-> calibrated P(arrival late OR cancelled OR diverted). /predict is "
        "the protocol's 180-minute covered event; /predict/60m and "
        "/predict/30m are informational shorter-threshold siblings. "
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


class TieredPredictResponse(PredictResponse):
    """The tier endpoints' response: PredictResponse + which threshold.

    A separate model on purpose — /predict's response stays exactly the
    shape it has always been, so no existing consumer sees a new field.
    """

    threshold_min: int = Field(description="Delay threshold this probability was trained on.")


class LoadedModel(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    threshold_min: int
    endpoint: str
    model_version: str
    baseline: float


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
    same encoding at serving time. All three thresholds share this format —
    they differ only in label, never in features. Unseen airports are
    handled by the encoder's handle_unknown="ignore"; unseen CARRIERS are
    rejected with a 422 before reaching here (a carrier outside the
    training vocabulary would silently predict without the carrier signal).
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


def _entry(key: str) -> dict[str, Any]:
    """The loaded model for a threshold key, or 503 if it isn't there."""
    entry = _state.get("models", {}).get(key)
    if entry is None:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Model for the {key}-minute threshold is not loaded "
                f"(missing artifacts). Train it with "
                f"`python -m training.train --threshold-min {key} "
                f"--out-dir artifacts/arr{key}`."
            ),
        )
    return entry


def predict_p_covered(req: PredictRequest, key: str = "180") -> float:
    """Run one threshold's calibrated model on a route/calendar/time tuple."""
    entry = _entry(key)
    X = entry["encoder"].transform(to_notebook_format(req))
    return float(entry["model"].predict_proba(X)[0, 1])


def _reject_unknown_carrier(req: PredictRequest, entry: dict[str, Any]) -> None:
    """422 on a carrier outside the encoder's vocabulary (the ICAO bug)."""
    known = entry.get("known_carriers")
    if known is not None and req.carrier not in known:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown carrier '{req.carrier}'. Expected an IATA code the model "
                f"was trained on (e.g. UA, AA, DL) — ICAO codes (UAL, AAL) are not "
                f"accepted; convert first."
            ),
        )


def grade(p: float, baseline: float) -> str:
    """Risk grade relative to that model's own network-average rate."""
    vs = p / baseline
    return "low" if vs < 0.75 else "moderate" if vs < 2.0 else "high"


# ─── Routes ───────────────────────────────────────────────────────────────


@app.get("/")
def banner() -> dict[str, str]:
    return {
        "service": "flight-delay-predictions",
        "see": "POST /predict, POST /predict/60m, POST /predict/30m, GET /models, GET /healthz",
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
    _reject_unknown_carrier(req, _entry("180"))
    p = predict_p_covered(req)
    vs = p / BASELINE_COVERED_RATE
    return PredictResponse(
        p_covered=p,
        risk=grade(p, BASELINE_COVERED_RATE),
        baseline=BASELINE_COVERED_RATE,
        vs_baseline=round(vs, 2),
        model_version=str(_state["model_version"]),
    )


# ─── Delay tiers (2026-08-05) ─────────────────────────────────────────────
#
# Same request body, same features, same calibration — a shorter covered
# event. Each tier is graded against ITS OWN baseline: a 30-minute miss is
# roughly four times as common as a 3-hour one, so grading all three off
# the 180m rate would mark every short-threshold route "high".


def _tier_predict(key: str, req: PredictRequest) -> TieredPredictResponse:
    entry = _entry(key)
    _reject_unknown_carrier(req, entry)
    p = predict_p_covered(req, key)
    baseline = float(entry["baseline"])
    return TieredPredictResponse(
        p_covered=p,
        risk=grade(p, baseline),
        baseline=baseline,
        vs_baseline=round(p / baseline, 2),
        model_version=str(entry["model_version"]),
        threshold_min=int(entry["spec"].threshold_min),
    )


@app.post(
    "/predict/60m", response_model=TieredPredictResponse, dependencies=[Depends(require_token)]
)
def predict_60m(req: PredictRequest) -> TieredPredictResponse:
    """P(arrival ≥60 min late OR cancelled OR diverted) — calibrated.

    NOT the protocol's covered event. Informational tier: same route/date
    /time input, a one-hour threshold instead of three.
    """
    return _tier_predict("60", req)


@app.post(
    "/predict/30m", response_model=TieredPredictResponse, dependencies=[Depends(require_token)]
)
def predict_30m(req: PredictRequest) -> TieredPredictResponse:
    """P(arrival ≥30 min late OR cancelled OR diverted) — calibrated.

    NOT the protocol's covered event. The most permissive tier — expect
    roughly four times the 180m rate on an average route.
    """
    return _tier_predict("30", req)


@app.get("/models", response_model=list[LoadedModel])
def models() -> list[LoadedModel]:
    """Which thresholds this instance actually has artifacts for."""
    entries = _state.get("models", {})
    return [
        LoadedModel(
            threshold_min=e["spec"].threshold_min,
            endpoint="/predict" if e["spec"].key == "180" else f"/predict/{e['spec'].key}m",
            model_version=str(e["model_version"]),
            baseline=float(e["baseline"]),
        )
        for _key, e in sorted(entries.items(), key=lambda kv: -int(kv[0]))
    ]
