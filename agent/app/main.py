"""Sentinel Premium Pricing Agent — FastAPI service.

Maps a flight tuple to a USDC premium using an XGBoost delay-probability
model (trained on the Kaggle 2008 flight-delay dataset, BTS-derived) and
an expected-loss formula with hard rails:

    expected_loss   = p_delay * payoff_usdc
    premium_usdc    = clamp(expected_loss * AGENT_MARGIN,
                            AGENT_PREMIUM_MIN, AGENT_PREMIUM_MAX)
    premium_base_units = round(premium_usdc * 10_000_000)  # Stellar: 7 decimals

The only consumer is the dapp's daily route-agent cron
(dapp/api/cron/agent.ts), which re-clamps against the routes-file rails and
the on-chain owner-set term limits — the service's own rails are a first
line, not the last.

Known limitations (POC): the model's target is `dep_delayed_15min`
(departure delay), a proxy for Sentinel's covered event (arrival delay >=
threshold / cancellation), and the training data is the 2008 Kaggle
extract. Retraining on current BTS on-time data with an arrival-delay
target is the planned follow-up.

Env:
    AGENT_TOKEN        — optional bearer token; when set, /price requires
                         `Authorization: Bearer <token>`
    AGENT_MARGIN       — loading factor on expected loss (default 1.3)
    AGENT_PREMIUM_MIN  — floor in USDC (default 10)
    AGENT_PREMIUM_MAX  — cap in USDC (default 100)
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

USDC_BASE_UNITS_PER_USDC = 10_000_000  # Stellar assets use 7 decimals

MARGIN = float(os.environ.get("AGENT_MARGIN", "1.3"))
PREMIUM_MIN = float(os.environ.get("AGENT_PREMIUM_MIN", "10"))
PREMIUM_MAX = float(os.environ.get("AGENT_PREMIUM_MAX", "100"))

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
    yield
    _state.clear()


app = FastAPI(
    title="Sentinel Premium Pricing Agent",
    version="0.2.0",
    description=(
        "Maps a flight tuple to a USDC premium via XGBoost p(delay) x "
        "expected-loss pricing with hard rails. Stellar port."
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


class PriceRequest(BaseModel):
    flight_id: str = Field(..., description="Informational only; not a model feature (e.g. 'AA100').")
    carrier: str = Field(..., description="IATA carrier code (e.g. 'AA').")
    origin: str = Field(..., description="IATA origin airport code (e.g. 'JFK').")
    dest: str = Field(..., description="IATA destination airport code (e.g. 'LAX').")
    payoff_usdc: float = Field(..., gt=0, description="Route payoff in USDC — the expected-loss base.")
    month: int = Field(..., ge=1, le=12)
    day_of_month: int = Field(..., ge=1, le=31)
    day_of_week: int = Field(..., ge=1, le=7, description="Mon=1, Sun=7.")
    dep_time_hhmm: int = Field(1200, ge=0, le=2359, description="Scheduled departure HHMM (default noon).")
    distance_mi: int = Field(1000, ge=0, description="Route distance in miles (default 1000).")


class PriceResponse(BaseModel):
    # Pydantic 2 reserves the `model_` prefix; opt out so `model_version`
    # passes validation without a warning.
    model_config = ConfigDict(protected_namespaces=())

    p_delay: float
    premium_usdc: float
    premium_base_units: int
    model_version: str


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    model_version: str
    loaded_at: str


# ─── Helpers ──────────────────────────────────────────────────────────────


def to_notebook_format(req: PriceRequest) -> pd.DataFrame:
    """Translate a PriceRequest into the model's expected DataFrame format.

    The training pipeline represents Month/DayofMonth/DayOfWeek as `c-{n}`
    strings (e.g. `c-7`, `c-21`); the fitted ColumnTransformer expects the
    same encoding at serving time. Unseen carriers/airports are handled by
    the encoder's handle_unknown="ignore".
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


def price_from_probability(p_delay: float, payoff_usdc: float) -> tuple[float, int]:
    """Expected-loss premium with rails.

    premium = clamp(p_delay * payoff * margin, PREMIUM_MIN, PREMIUM_MAX).
    Base units use Stellar's 7 decimals.
    """
    raw = float(p_delay) * float(payoff_usdc) * MARGIN
    premium_usdc = max(PREMIUM_MIN, min(PREMIUM_MAX, raw))
    premium_base_units = round(premium_usdc * USDC_BASE_UNITS_PER_USDC)
    return premium_usdc, premium_base_units


# ─── Routes ───────────────────────────────────────────────────────────────


@app.get("/")
def banner() -> dict[str, str]:
    return {
        "service": "sentinel-premium-pricing-agent",
        "chain": "stellar",
        "see": "POST /price, GET /healthz",
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


@app.post("/price", response_model=PriceResponse, dependencies=[Depends(require_token)])
def price(req: PriceRequest) -> PriceResponse:
    encoder = _state.get("encoder")
    model = _state.get("model")
    if encoder is None or model is None:
        raise HTTPException(status_code=503, detail="Model artifacts not loaded.")

    df = to_notebook_format(req)
    X = encoder.transform(df)
    p_delay = float(model.predict_proba(X)[0, 1])
    premium_usdc, premium_base_units = price_from_probability(p_delay, req.payoff_usdc)

    return PriceResponse(
        p_delay=p_delay,
        premium_usdc=premium_usdc,
        premium_base_units=premium_base_units,
        model_version=str(_state["model_version"]),
    )
