# Codex AI Report (2026-07-11) — Remediation Summary

**Source report:** [`20260711_codex_ai_report.md`](../20260711_codex_ai_report.md)
**Audited commit:** `cdac8a8` (main)
**Remediation date:** 2026-07-11
**Test status:** full workspace suite green — **399 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean. Executor (TypeScript) changes verified
by review — the executor is not part of the CI test suite.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CAI-H01 | High | Confirmed | ✅ Fixed (oracle-attested sale window required by every purchase + executor SaleAuthorizer cron) |
| CAI-M01 | Medium | Confirmed | ✅ Fixed (bounded `Active` timeout voids flights whose terminal outcome never arrives) |

---

## Fixed

### CAI-H01 — Stale oracle state permits deterministic cancellation-claim purchases

**Confirmed (High).** The purchase gate admitted any flight whose oracle row
was `NotInitiated` or `Active`. That only proves no outcome is recorded
ON-CHAIN — it cannot distinguish a genuinely operating flight from one whose
public cancellation has not yet reached the oracle contract. During that
interval every accepted policy was a deterministic `payoff − premium` claim
against the vault, repeatable across buyer addresses up to the solvency
limit. The prior round's cancellation tombstone (2026-07-04 remediation)
closed the structural gap for cancellations already written on-chain; this
report correctly identified that the path stayed **fail-open** between public
cancellation discovery and the oracle write.

**Fix — insurability is now attested, not inferred (fail closed):**

1. **On-chain sale window** (`oracle_aggregator`). The oracle gains
   `open_sale(oracle, flight_id, date, expires_at)` / `close_sale(...)` and
   the views `is_sale_open` / `get_sale_auth`. An authorization is the
   oracle's affirmative, short-lived attestation that the flight instance
   was verified scheduled-and-not-cancelled at write time:
   - `expires_at` is bounded by `now + 24h` (`SALE_AUTH_MAX_VALIDITY_SECS`)
     and by the departure-day boundary, so an attestation can never be
     staler than a day and the oracle must keep re-attesting while sales
     stay open;
   - `open_sale` is rejected once any outcome is recorded (only
     `NotInitiated`/`Active` rows are attestable);
   - `set_cancelled` deletes any live authorization in the same transaction
     that records the cancellation — the tombstone and the window close
     atomically;
   - authorizations live in **temporary** storage (`OracleKey::SaleAuth`):
     a lapsed window physically vanishes and archival-restoration semantics
     can never resurrect one. Correctness never depends on the entry TTL —
     `is_sale_open` compares the stored expiry against the ledger clock and
     fails closed on every degraded state (never written, closed, lapsed,
     archived).
2. **Purchase gate** (`controller`). `buy_insurance` now requires
   `oracle.is_sale_open(flight_id, date)` in addition to the existing
   status gate, and reverts with the new `SaleNotOpen` (#319) otherwise.
   `NotInitiated`/`Active` alone is no longer treated as evidence that a
   flight is insurable.
3. **Executor SaleAuthorizer cron** (`executor/centralized_cron`). A new
   job (oracle key, every 2h at :30, off-tempo from the fetcher) sweeps the
   configured flight numbers across the booking horizon each run: it pushes
   the `set_cancelled` tombstone the moment a cancellation is visible
   (closing sales instantly instead of waiting for the window to lapse),
   `close_sale`s instances that became unverifiable (no data / ambiguous
   candidates — never guess), and otherwise opens/refreshes windows with
   `min(flight date, now + SALE_AUTH_VALIDITY_SECS)` (default 6h). Config:
   `SALE_AUTH_FLIGHT_IDS` / `SALE_AUTH_HORIZON_DAYS` /
   `SALE_AUTH_VALIDITY_SECS`; wired into the scheduler, single-shot CLI
   (`npm run authorize`), HTTP trigger, and run-log/health surfaces.

The failure direction is the security property: if the authorizer stops, or
a flight can't be verified, sales halt for it — **availability degrades,
never safety**.

*Files:* `oracle_aggregator/src/{constants,storage,lifecycle,queries,events}.rs`,
`sentinel_types/src/interfaces.rs`, `controller/src/{purchase,error}.rs`,
`executor/centralized_cron/src/{sale_authorizer,config,types,index,run_once,server,run_log}.ts`,
`executor/centralized_cron/package.json`.
*Tests:* oracle — `test_open_sale_round_trip_and_expiry`,
`test_open_sale_validates_expiry`, `test_open_sale_allowed_pre_outcome_only`,
`test_open_sale_panics_on_cancelled_tombstone`,
`test_close_sale_removes_authorization`,
`test_set_cancelled_clears_sale_authorization`,
`test_open_sale_requires_oracle`, `test_close_sale_requires_oracle`;
controller — `test_buy_insurance_panics_without_sale_authorization`,
`test_buy_insurance_panics_on_expired_sale_authorization`,
`test_buy_insurance_panics_after_sale_closed`; integration —
`sale_window_lapse_fails_closed_until_reattested` (group 1). Every existing
purchase path now runs through an `open_sale` helper that mirrors the
executor (it never authorizes a flight with a recorded outcome), proving the
gate composes with the whole lifecycle suite.

### CAI-M01 — Active flights without terminal oracle data can lock collateral indefinitely

**Confirmed (Medium).** The state machine's only exits from `Active` were
`Landed` and `Cancelled`, and `classify_flights` fell through on `Active`
rows. A flight whose terminal outcome never arrived (provider gap, executor
failure, pipeline outage after the estimated-arrival write) kept its full
payoff locked in the vault forever and pinned an active-list slot in both
the oracle and the pool — a paid griefing vector with no recovery short of
an upgrade (the eviction escape hatch requires the `FlightData` row to be
absent, which never holds here).

**Fix — bounded `Active → ToBeSettledOnTime` void path, mirroring the
existing `NotInitiated` stale void:**

- New shared constant `ACTIVE_FLIGHT_TIMEOUT_SECS = 14 days`
  (`sentinel_types::timeouts`), anchored at the flight's **recorded
  scheduled arrival** (not the departure date), shared by the deciding and
  validating contracts so they cannot drift.
- The oracle's transition table gains `(Active, ToBeSettledOnTime)`, and
  `set_to_be_settled` enforces the timing **on the state machine itself**
  (new `ActiveTimeoutNotReached` error, #611) — per the report's
  recommendation, no caller can void a flight the oracle is merely late in
  resolving. Delayed/cancelled remain invalid targets from `Active`, so the
  void can never pay out. Like the `NotInitiated` void, it counts as a
  pending outcome from classification, keeping the vault's LP settlement
  barrier consistent.
- `classify_flights` gains an `Active` branch: past
  `estimated_arrival_time + timeout` it classifies the flight
  `ToBeSettledOnTime` and emits the distinct **`FlightTimedOutActive`**
  event (`sentinel.timed_out`), so operators can tell an oracle-liveness
  void from a `FlightVoided` dataless void and from an ordinary on-time
  settlement. Settlement then proceeds on the normal pipeline: premiums
  become vault income, the locked payoff is released, and both active-list
  slots free up. The oracle can still write the real outcome at any moment
  before the void is classified.

Every state that locks vault collateral now has a bounded terminal path —
the report's key requirement.

*Files:* `sentinel_types/src/lib.rs`,
`oracle_aggregator/src/{storage,lifecycle,error}.rs`,
`controller/src/{settle,events}.rs`.
*Tests:* oracle — `test_active_timeout_void_gated_by_timeout`; controller —
`test_classify_flights_times_out_stuck_active_flight`,
`test_classify_flights_leaves_stuck_active_flight_before_timeout`;
integration — `lifecycle_active_timeout_void` (group 1);
`active_flight_never_voided_by_stale_timeout` (group 5) was renamed to
`active_flight_not_voided_before_terminal_timeout` — its old assertion
("`Active` waits forever") encoded exactly the hazard this finding flags,
and it now proves the wait is bounded, not infinite.

---

## Adopted design vs. the report's primary recommendation

The report's first-choice remedy for CAI-H01 is a full oracle-attested flight
registry: pre-registered instances with canonical identity fields and an
explicit `OpenForPurchase` state in the status machine. The applied fix keeps
lazy registration and implements the report's stated alternative — "a
short-lived oracle authorization consumed atomically by `buy_insurance`" —
which delivers the decisive property (no purchase without a fresh,
affirmative, expiring attestation) without a breaking `FlightStatus` ABI
change. Mapping to the report's authorization requirements:

- *exact instance binding* — the authorization is keyed on
  `(flight_id, date)`; origin/destination remain bound by the governance
  route whitelist consulted in the same transaction;
- *current non-cancelled sale state* — `open_sale` rejects rows with
  recorded outcomes, and `set_cancelled` kills the window atomically;
- *expiration timestamp* — explicit `expires_at`, capped on-chain at 24h;
- *terms binding* — provided by the existing pool mechanism (terms are
  locked at first registration and every later buyer transacts at the
  snapshot), not duplicated inside the authorization;
- *nonce / replay resistance* — not applicable: the authorization is
  on-chain contract state consulted in the purchase transaction, not a
  signed off-chain message that could be replayed.

> **Residual risk & ops duties (documented in `spec/architecture.md`):**
> - The residual purchase-time exposure is bounded by the authorization's
>   remaining validity plus the authorizer's observation cadence: a
>   cancellation that becomes public immediately after a refresh stays
>   purchasable until the next authorizer pass writes the tombstone or the
>   window lapses (≤ 24h worst case, ~one 2h cycle in normal operation) —
>   versus unbounded before this fix.
> - `SALE_AUTH_FLIGHT_IDS` must track the governance route whitelist; a
>   whitelisted route missing from the list is never sellable. Days beyond
>   the schedule provider's visibility stay closed, so the effective sale
>   horizon is `min(configured horizon, provider visibility)`.
> - The active-void timeout inherits the stale-void caveat: under a partial
>   oracle outage with the keeper still classifying, real flights past
>   `scheduled arrival + 14 days` are voided as on-time. The existing
>   operational requirement (pause the Controller / stop the classifier
>   well before day 14 of an oracle outage) now covers both void paths.

---

## Interface changes in this pass

- `OracleAggregator` new entry points: `open_sale(oracle, flight_id, date,
  expires_at)`, `close_sale(oracle, flight_id, date)` (oracle-only); new
  views `is_sale_open(flight_id, date) -> bool`,
  `get_sale_auth(flight_id, date) -> Option<u64>`; new storage variant
  `OracleKey::SaleAuth(Symbol, u64)` (temporary tier); new events
  `SaleOpened` (`sentinel.sale_open`) and `SaleClosed`
  (`sentinel.sale_close`); new error `ActiveTimeoutNotReached` (611); new
  accepted transition `Active → ToBeSettledOnTime`.
- `Controller`: `buy_insurance` requires a live sale authorization — new
  error `SaleNotOpen` (319); new event `FlightTimedOutActive`
  (`sentinel.timed_out`).
- `sentinel_types`: new `timeouts::ACTIVE_FLIGHT_TIMEOUT_SECS`; shared
  `OracleClient` trait gains `is_sale_open`.
- Executor: new SaleAuthorizer cron (#0), env vars `SALE_AUTH_FLIGHT_IDS`,
  `SALE_AUTH_HORIZON_DAYS`, `SALE_AUTH_VALIDITY_SECS`, CLI
  `npm run authorize`, HTTP trigger `/api/trigger/sale_authorizer`.
- **Deployment note:** existing deployments sell nothing after upgrading
  until the SaleAuthorizer runs (or `open_sale` is invoked manually) —
  fail-closed by design. Frontends should surface
  `is_sale_open`/`get_sale_auth` so users see why a purchase is unavailable.

## Documentation updated

`spec/architecture.md` (state machine, oracle function reference, cron #0,
buy flow, known limitations), `spec/simple_architecture.md`,
`sequence_diagrams.md` (buy + settlement diagrams), docs site pages
`contracts/oracle-aggregator.md`, `contracts/controller.md`,
`concepts/solvency-and-safety.md`, `guides/buy-insurance.md`,
`developers/executor.md`.
