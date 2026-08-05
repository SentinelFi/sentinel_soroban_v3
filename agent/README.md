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

## Delay tiers

The 180-minute threshold is the protocol's covered event, but the same
pipeline trains shorter ones from the same BTS window — only the label's
threshold changes, never the features:

| Endpoint | Covered event | Artifacts | Test AUC | Brier | Base rate |
|---|---|---|---|---|---|
| `POST /predict` | arr ≥ **180 min** ∪ cancel ∪ divert | `artifacts/` | 0.789 | 0.0282 | 3.42% |
| `POST /predict/60m` | arr ≥ **60 min** ∪ cancel ∪ divert | `artifacts/arr60/` | 0.745 | 0.0763 | 9.53% |
| `POST /predict/30m` | arr ≥ **30 min** ∪ cancel ∪ divert | `artifacts/arr30/` | 0.724 | 0.1185 | 15.81% |

All three trained 2026-08-05 on the same 15.4M-row window, and all three
are calibrated to 4 decimal places (mean predicted p vs actual: 0.0953 /
0.0953 at 60m, 0.1580 / 0.1581 at 30m). AUC slides as the threshold
drops — a 30-minute miss is far more often ordinary noise than a 3-hour
one, so there is less structure to learn — while calibration holds, which
is the property that matters for any expected-value use.

Same request body for all three; the tier responses add `threshold_min`.
Each tier is graded against **its own** base rate — a 30-minute miss is
several times commoner than a 3-hour one, so grading them all off the
180m rate would mark every route "high".

Rules of the road:

- **`/predict` is the only endpoint the protocol prices from.** The tiers
  are informational; nothing in `dapp/` calls them.
- The tiers are **optional at runtime** — a missing `artifacts/arr30/` or
  `artifacts/arr60/` makes that one path 503 and leaves everything else
  healthy. Only the 180m set is required to boot.
- The three models are fitted **independently**, so per-request
  monotonicity isn't guaranteed (p30 ≥ p60 ≥ p180 holds for the labels
  by construction and in aggregate, but a single route can invert
  slightly). Don't build logic that assumes ordering.
- `GET /models` lists what this instance actually loaded.

Train a tier (or any other threshold) with the two knobs:

```sh
python -m training.train --threshold-min 60 --out-dir artifacts/arr60
make train-tiers   # both tiers, ~7 min
```

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
| (opt) Delay tiers | `make train-tiers` | ~7 min; 30m + 60m siblings |

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
baseline: low < 0.75×, moderate < 2×, high ≥ 2×. Unknown **airports**
don't error (the encoder ignores them); an unknown **carrier** is a 422 —
it would one-hot to all-zeros and silently price without the carrier
signal, which is exactly the 2026-07-29 ICAO bug. Send IATA (`UA`), not
ICAO (`UAL`). When `AGENT_TOKEN` is set, all `/predict*` paths require
`Authorization: Bearer <token>`; `GET /healthz` (model version) stays open.

### `POST /predict/60m`, `POST /predict/30m`

Identical request body; response adds `threshold_min`:

```json
{
  "p_covered": 0.0863,
  "risk": "low",
  "baseline": 0.0953,
  "vs_baseline": 0.91,
  "model_version": "…-btsM24-arr60m",
  "threshold_min": 60
}
```

503 when that tier's artifacts aren't present. See **Delay tiers** above.

### `GET /models`

Thresholds this instance loaded, descending — endpoint, version, baseline.

## Env

| Var | Default | Meaning |
|---|---|---|
| `AGENT_TOKEN` | unset (open) | Bearer token for `/predict` |
| `AGENT_ARTIFACTS_DIR` | `artifacts/` | Artifacts override (tests) |
