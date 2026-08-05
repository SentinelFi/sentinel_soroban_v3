# Maintenance — Periodic Data Refresh & Model Retraining

The pricing model (`agent/`) is trained on **per-flight** BTS data. Flight
behavior drifts — schedules, carrier mixes, congestion, seasonal patterns —
so the model must be retrained on fresh data **every 6 months**.

## The two BTS datasets (don't confuse them)

| Dataset | What it is | Use here |
|---|---|---|
| **Marketing Carrier On-Time Performance (Beginning January 2018)** | PER-FLIGHT rows: date, carrier, origin→dest, CRS dep time, ARR_DELAY minutes, CANCELLED, DIVERTED, DISTANCE | **The training source.** Field picker / latest-month check: <https://transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FGK&QO_fu146_anzr=b0-gvzr> ; the automated fetch uses the prezipped monthlies at <https://transtats.bts.gov/PREZIP/> |
| **On-Time Delay Cause** (<https://transtats.bts.gov/OT_Delay/OT_DelayCause1.asp>) | AGGREGATE rows per (month, carrier, arrival airport): flight counts, ≥15-min delay counts, cause buckets, cancellations | **Monitoring only** — it has no per-flight rows, no 180-min threshold information, and no routes, so it CANNOT train the covered-event model. Use it to sanity-check the model's monthly/carrier delay rates against official numbers |

Both are free, no account, no API quota.

## Retraining runbook (every ~6 months)

1. **Fetch + collate — fully automated, no manual downloads.**
   `agent/training/fetch_and_prepare.py` pulls the free prezipped
   monthlies straight from transtats PREZIP and writes the collated
   minimal-schema CSV to `agent/data/delay_data.csv` (gitignored):
   ```sh
   cd agent && python -m training.fetch_and_prepare --end 2027-01 --months 24
   ```
   Set `--end` to the latest available month (BTS lags ~2 months). Each
   month prints a coverage line — rows + covered-event rate, normally
   ~2.5%; a weird rate or a FAILED line means re-run that month (the
   script continues past failures and lists them at the end). Kept
   columns (CamelCase): `Month`, `DayofMonth`, `DayOfWeek`,
   `Operating_Airline`, `Origin`, `Dest`, `CRSDepTime`, `Distance`
   (features) + `ArrDelay`, `Cancelled`, `Diverted` (labels) +
   `Duplicate` (hygiene — the trainer drops `Y` rows). Everything else in
   the BTS table (Div1-5, delay-cause minutes, taxi/wheels, IDs) is
   post-outcome leakage or redundant and never touches disk.
2. **Smoke-test the pipeline on a small sample FIRST** (the standing rule):
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
   - held-out metrics printed by the trainer: ROC AUC should stay ≈ 0.75+,
     and **mean predicted p must track the actual positive rate** (the
     calibration property expected-loss pricing depends on) — v3 baseline
     (24 months ending 2026-05, 15.4M flights): test AUC 0.789,
     Brier 0.0282, mean p 0.0341 vs actual 0.0342;
   - `make test` (the service's pytest suite runs against the artifacts);
   - /predict sanity spot-checks (a reliable island hop → low risk;
     evening departures should out-risk morning ones on congested routes);
   - update `BASELINE_COVERED_RATE` in `agent/app/main.py` to the new
     window's actual positive rate (printed by the trainer).
6. **Retrain the delay tiers** (added 2026-08-05): the same CSV also
   trains the shorter-threshold siblings served at `/predict/60m` and
   `/predict/30m` — `cd agent && make train-tiers` (~7 min, sequential;
   each run holds the full CSV in memory). Verify the same way: mean
   predicted p must track the actual rate, and the base rates should
   stay ordered 30m > 60m > 180m. If a tier is skipped its endpoint
   503s and nothing else is affected — `/predict` never depends on them.
7. **Commit** the new `agent/artifacts/` (model, encoder, feature names,
   version stamp, `metrics.json`) plus `artifacts/arr30|arr60/` if
   retrained — Render serves the new models on its next redeploy
   (`render.yaml`, rootDir `agent`).

   Note on baselines: since 2026-08-05 the trainer writes `metrics.json`
   beside each model and the service reads `test.actual_rate` from it as
   that model's risk-grading baseline. The in-code constants
   (`BASELINE_COVERED_RATE`, `BASELINE_60M_RATE`, `BASELINE_30M_RATE`)
   are fallbacks for artifact sets without the file — which today
   includes the shipped 180m model, so step 5's "update
   `BASELINE_COVERED_RATE`" still applies until 180m is retrained.
8. **Optional monitoring**: refresh the delay-cause aggregate from the
   OT_DelayCause page and compare official monthly delay/cancel rates per
   carrier against the model's predictions for drift.

## Copy-paste Claude prompts for the 6-month refresh

The whole refresh is automatable — paste these into Claude Code from the
repo root, in order. (Data source behind them: BTS prezipped Marketing
Carrier monthlies at <https://transtats.bts.gov/PREZIP/> — free, no
account; the field-picker UI for reference is
<https://transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FGK&QO_fu146_anzr=b0-gvzr>. BTS
lags ~2 months behind the calendar.)

**Prompt 1 — fetch fresh data:**

> Fetch the latest 24 months of BTS flight data for the pricing model:
> check <https://transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FGK&QO_fu146_anzr=b0-gvzr>
> for the latest available month, then run
> `cd agent && python -m training.fetch_and_prepare --end <YYYY-MM> --months 24`
> (transtats needs curl -k-style unverified TLS — the script handles it).
> Watch the per-month coverage lines: covered-event rates are normally
> 2-7%; rerun any month that prints FAILED
> (`--months 1 --end <that-month>`). Confirm the row total at the end.

**Prompt 2 — smoke-test the pipeline on a sample FIRST (standing rule):**

> Cut a ~25-row stratified fixture from agent/data/delay_data.csv covering
> every outcome class (on-time, arr≥180, cancelled, diverted), refresh
> agent/training/fixtures/delay_data.sample.csv, and run
> `python -m training.train --data training/fixtures/delay_data.sample.csv`
> — it must complete in smoke mode with no schema errors before any full
> training run.

**Prompt 3 — retrain, verify, ship:**

> Run `cd agent && make train`, then verify against the acceptance
> baselines in spec/maintenance.md: test ROC AUC ≈ 0.75+, and mean
> predicted p must track the actual positive rate (calibration). Update
> BASELINE_COVERED_RATE in agent/app/main.py to the new actual rate, run
> `make test`, spot-check /predict (a Hawaiian island hop should be low
> risk; a winter-evening JFK short-hop should be elevated/high), then
> commit the new agent/artifacts/ + fixture and push. Render redeploys
> the service on push.

## Other periodic maintenance (same cadence checkpoint)

- **AeroAPI quota**: confirm the monthly budget fits current route count —
  steady state is ~30 cached /schedules calls/day + per-flight calls only
  near departure/arrival (see architecture, call-economy sections).
- **Routes refresh** (manual, admin-gated — never scheduled): the
  3-script pipeline in `scripts/` — `discover_routes` (API → deduped
  catalog, tracked carriers only) → `price_routes` (live ML →
  `route_whitelist.json`) → ADMIN REVIEWS AND SAYS GO → `seed_routes`
  (on-chain with the exact staged terms). See scripts/README.md.
- **Governance DB hygiene**: `signals` self-expire; `aeroapi_cache` rows
  age out by TTL query (no cleanup needed); check `/api/admin/diagnostics`
  for accumulated operator-attention events.
