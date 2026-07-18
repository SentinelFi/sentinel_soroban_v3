# Sentinel Premium Pricing Agent

A small FastAPI service that wraps an XGBoost delay-probability model
(trained on the Kaggle 2008 flight-delay dataset, which derives from US BTS
on-time data) and returns a USDC premium via expected-loss pricing with
hard rails:

```
expected_loss      = p_delay * payoff_usdc
premium_usdc       = clamp(expected_loss * AGENT_MARGIN, AGENT_PREMIUM_MIN, AGENT_PREMIUM_MAX)
premium_base_units = round(premium_usdc * 10_000_000)   # Stellar: 7 decimals
```

The only consumer is the dapp's **daily route-agent cron**
(`dapp/api/cron/agent.ts`), which calls `POST /price` per whitelisted route
and re-clamps the answer against the routes-file rails plus the on-chain
owner-set term limits. The service can be down without breaking anything —
the cron falls back to the routes-file terms.

This service is **too heavy for a Vercel function** (xgboost + sklearn +
pandas), so it deploys as a Render web service (see `render.yaml` at the
repo root). Trained artifacts are committed in `artifacts/` so the service
runs out of the box; retrain with `make train` after dropping the Kaggle
CSV into `data/`.

POC pricing — **not actuarially sound**: the model target is
`dep_delayed_15min` (departure delay), a proxy for the protocol's covered
event (arrival delay ≥ threshold / cancellation), on 2008 data. Retraining
on current BTS data with an arrival-delay target is the planned follow-up.

## Setup

| Step | Command | Notes |
|---|---|---|
| 1. Python 3.10+ | `python3 --version` | 3.11 in the Docker image |
| 2. macOS only — OpenMP runtime | `brew install libomp` | xgboost needs `libomp.dylib` |
| 3. Create venv | `python3 -m venv .venv && source .venv/bin/activate` | `.venv/` is gitignored |
| 4. Install deps | `make install` | |
| 5. Run the service | `make serve` | uvicorn on port 8000 |
| 6. Run the tests | `make test` | uses the committed artifacts |
| (opt) Retrain | `make download-data`, then `make train` | ~30s on a laptop |

## Endpoint contract

### `POST /price`

```bash
curl -sS -X POST http://localhost:8000/price \
  -H "Content-Type: application/json" \
  -d '{
    "flight_id": "AA100",
    "carrier": "AA",
    "origin": "JFK",
    "dest": "LAX",
    "payoff_usdc": 450,
    "month": 8,
    "day_of_month": 21,
    "day_of_week": 7
  }'
```

Response:

```json
{
  "p_delay": 0.4970,
  "premium_usdc": 100.0,
  "premium_base_units": 1000000000,
  "model_version": "2026-05-10T12:41:08Z"
}
```

`dep_time_hhmm` (default 1200) and `distance_mi` (default 1000) are
optional model features. When `AGENT_TOKEN` is set, `/price` requires
`Authorization: Bearer <token>`; `GET /healthz` stays open.

## Env

| Var | Default | Meaning |
|---|---|---|
| `AGENT_TOKEN` | unset (open) | Bearer token for `/price` |
| `AGENT_MARGIN` | `1.3` | Loading factor on expected loss |
| `AGENT_PREMIUM_MIN` | `10` | Premium floor, USDC |
| `AGENT_PREMIUM_MAX` | `100` | Premium cap, USDC |
| `AGENT_ARTIFACTS_DIR` | `artifacts/` | Artifacts override (tests) |
