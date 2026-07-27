# Maintenance — Periodic Data Refresh & Model Retraining

The pricing model (`agent/`) is trained on **per-flight** BTS data. Flight
behavior drifts — schedules, carrier mixes, congestion, seasonal patterns —
so the model must be retrained on fresh data **every 6 months**.

## The two BTS datasets (don't confuse them)

| Dataset | What it is | Use here |
|---|---|---|
| **Marketing/Reporting Carrier On-Time Performance** | PER-FLIGHT rows: date, carrier, origin→dest, CRS dep time, ARR_DELAY minutes, CANCELLED, DIVERTED, DISTANCE | **The training source.** Download: <https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FGJ> (pick fields, month by month) or the prezipped monthlies at <https://transtats.bts.gov/PREZIP/> |
| **On-Time Delay Cause** (<https://transtats.bts.gov/OT_Delay/OT_DelayCause1.asp>) | AGGREGATE rows per (month, carrier, arrival airport): flight counts, ≥15-min delay counts, cause buckets, cancellations | **Monitoring only** — it has no per-flight rows, no 180-min threshold information, and no routes, so it CANNOT train the covered-event model. Use it to sanity-check the model's monthly/carrier delay rates against official numbers |

Both are free, no account, no API quota.

## Retraining runbook (every ~6 months)

1. **Download** the newest per-flight months (Marketing Carrier On-Time
   Performance). Minimal columns — 11 (or 9 with `FlightDate` replacing
   the three date parts). The field-picker download uses CamelCase names;
   older extracts use SNAKE_CASE (what `train.py`'s `usecols` currently
   expects — add the header mapping if using the CamelCase form):
   | Role | CamelCase (field picker) | SNAKE_CASE (train.py today) |
   |---|---|---|
   | features | `Month`, `DayofMonth`, `DayOfWeek`, `Operating_Airline`, `Origin`, `Dest`, `CRSDepTime`, `Distance` | `MONTH`, `DAY_OF_MONTH`, `DAY_OF_WEEK`, `OP_UNIQUE_CARRIER`, `ORIGIN`, `DEST`, `CRS_DEP_TIME`, `DISTANCE` |
   | labels | `ArrDelay`, `Cancelled`, `Diverted` | `ARR_DELAY`, `CANCELLED`, `DIVERTED` |
   Optional hygiene: `Duplicate` (filter `Y` rows). Skip Div1-5, delay-cause
   minutes, taxi/wheels, IDs — post-outcome leakage or redundant. A stratified ~1% sample by
   (month, carrier) keeps the file manageable while preserving seasonal
   trends and small-carrier share (~150k rows covers 2-3 years).
   Weather enrichment (Meteostat) is optional — the current model does not
   use the weather columns (the `/price` request carries no forecast yet).
2. **Drop** the CSV at `agent/data/delay_data.csv` (gitignored).
3. **Smoke-test the pipeline on a small sample FIRST** (the standing rule):
   cut ~25 stratified rows covering every outcome class (on-time,
   arr≥180, cancelled, diverted, null-ARR_DELAY) and run
   `python -m training.train --data <sample.csv>` — under 1,000 rows the
   trainer enters smoke mode (artifacts to `artifacts/smoke/`, gitignored).
   Refresh the committed fixture `agent/training/fixtures/delay_data.sample.csv`
   if the schema changed.
4. **Train**: `cd agent && make train`. The label is the protocol's covered
   event — `ARR_DELAY >= 180 OR CANCELLED OR DIVERTED` (diverted pays as
   cancellation, matching the oracle policy) — with isotonic calibration.
5. **Verify before shipping**:
   - held-out metrics printed by the trainer: ROC AUC should stay ≈ 0.70+,
     and **mean predicted p must track the actual positive rate** (the
     calibration property expected-loss pricing depends on) — v2 baseline:
     AUC 0.708, mean p 0.0290 vs actual 0.0289;
   - `make test` (the service's pytest suite runs against the artifacts);
   - price sanity spot-checks (a reliable island hop should floor at
     PREMIUM_MIN; evening departures should price above morning ones).
6. **Commit** the new `agent/artifacts/` (model, encoder, feature names,
   version stamp) — Render serves the new model on its next redeploy
   (`render.yaml`, rootDir `agent`).
7. **Optional monitoring**: refresh the delay-cause aggregate from the
   OT_DelayCause page and compare official monthly delay/cancel rates per
   carrier against the model's predictions for drift.

## Other periodic maintenance (same cadence checkpoint)

- **AeroAPI quota**: confirm the monthly budget fits current route count —
  steady state is ~30 cached /schedules calls/day + per-flight calls only
  near departure/arrival (see architecture, call-economy sections).
- **Routes refresh**: `npm run discover:routes` (idempotent) to pick up new
  service on the configured city pairs; review `git diff`, then
  `npm run whitelist:routes`.
- **Governance DB hygiene**: `signals` self-expire; `aeroapi_cache` rows
  age out by TTL query (no cleanup needed); check `/api/admin/diagnostics`
  for accumulated operator-attention events.
