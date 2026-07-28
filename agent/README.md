# Flight Delay Predictions

A small FastAPI service that serves exactly what its model was trained on,
nothing else: given a route-level flight description (carrier, route, date,
time of day), `POST /predict` returns the **calibrated probability of the
protocol's covered event**:

```
p_covered = P( arrival ≥ 180 min late  OR  cancelled  OR  diverted )
```

graded against the network baseline (`risk`: low/moderate/high). The service
is deliberately **insurance-blind** — no premiums, no payoffs. The
protocol's expected-loss pricing (`p × payoff × margin`, rails-clamped)
lives in the dapp (`dapp/api/_lib/route_rules.ts`), applied by the daily
route-agent cron (`dapp/api/cron/agent.ts`), which calls `/predict` per
whitelisted route. The service can be down without breaking anything — the
cron falls back to the routes-file terms.

This service is **too heavy for a Vercel function** (xgboost + sklearn +
pandas), so it deploys as the Render web service `flight-delay-predictions`
(see `render.yaml` at the repo root). Trained artifacts are committed in
`artifacts/` so the service runs out of the box.

Model v3 (2026-07-27): XGBoost (300 trees) + isotonic calibration, trained
on 15.4M per-flight BTS "Marketing Carrier On-Time Performance" rows
(24 months, fetched + collated automatically from transtats PREZIP —
`make download-data`, no auth, no quota). Held-out test: ROC AUC 0.789,
Brier 0.0282, mean predicted p 0.0341 vs actual 0.0342 — calibrated, so
the probability is an honest base for expected-loss math. Features are the
serving contract only: month, day-of-month, day-of-week, carrier, origin,
dest, scheduled departure HHMM, distance. Flight numbers are never a
feature. A small committed fixture at
`training/fixtures/delay_data.sample.csv` smoke-tests the pipeline via
`--data`. **Retrain every 6 months** — full runbook, BTS source links, and
copy-paste Claude prompts: `spec/maintenance.md`.

## Setup

| Step | Command | Notes |
|---|---|---|
| 1. Python 3.10+ | `python3 --version` | 3.11 on Render |
| 2. macOS only — OpenMP runtime | `brew install libomp` | xgboost needs `libomp.dylib` |
| 3. Create venv | `python3 -m venv .venv && source .venv/bin/activate` | `.venv/` is gitignored |
| 4. Install deps | `make install` | |
| 5. Run the service | `make serve` | uvicorn on port 8000 |
| 6. Run the tests | `make test` | uses the committed artifacts |
| (opt) Retrain | `make download-data`, then `make train` | ~3 min for 15M rows |

## Endpoint contract

### `POST /predict`

```bash
curl -sS -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{
    "carrier": "UA",
    "origin": "ORD",
    "dest": "SFO",
    "month": 12,
    "day_of_month": 22,
    "day_of_week": 2,
    "dep_time_hhmm": 1930,
    "distance_mi": 1846
  }'
```

Response:

```json
{
  "p_covered": 0.0114,
  "risk": "low",
  "baseline": 0.0342,
  "vs_baseline": 0.33,
  "model_version": "2026-07-27T18:01:47Z-btsM24-arr180m"
}
```

`dep_time_hhmm` (24-hour HHMM, default 1200) and `distance_mi` (default
1000) are optional. `risk` compares `p_covered` to the network-average
baseline: low < 0.75×, moderate < 2×, high ≥ 2×. Unknown carriers/airports
don't error (encoder ignores them). When `AGENT_TOKEN` is set, `/predict`
requires `Authorization: Bearer <token>`; `GET /healthz` (model version)
stays open.

## Env

| Var | Default | Meaning |
|---|---|---|
| `AGENT_TOKEN` | unset (open) | Bearer token for `/predict` |
| `AGENT_ARTIFACTS_DIR` | `artifacts/` | Artifacts override (tests) |
