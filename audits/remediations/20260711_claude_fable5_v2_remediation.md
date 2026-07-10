# Claude Fable 5 Findings Report v2 (2026-07-11) — Remediation Summary

**Source report:** [`20260711_claude_fable5_v2_report.md`](../20260711_claude_fable5_v2_report.md)
**Audited commit:** `5e37718` (branch `new-issues-fixes`)
**Remediation date:** 2026-07-11
**Test status:** full workspace suite green — **377 tests pass**
(`cd contracts && cargo test --workspace`; 370 pre-existing + 7 new);
`cargo clippy --workspace --all-targets` clean; `cargo fmt --all --check`
clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CF5v2-M01 | Medium | Confirmed | ✅ Fixed — owner-only `Controller.settle_evicted_flight` completes the eviction lifecycle (releases collateral, settles the pool bucket, frees the pool slot) |
| CF5v2-L01 | Low | Confirmed | ✅ Fixed — `Recredit` now bounded by the vault's asset surplus over TMA |

General improvements: 5 of 9 fixed in code, 4 addressed via documentation —
see the table at the end.

---

## Fixed

### CF5v2-M01 — `evict_missing_flight` permanently strands vault collateral and pool-side state

**Confirmed (Medium, cross-cutting: oracle ↔ vault ↔ pool).** Eviction freed
only the oracle-side active-list slot (and, since CF5-M02, the barrier
count). The evicted flight's pool bucket stayed `Active` forever and its
`payoff × buyer_count` of vault collateral stayed locked forever —
`decrease_locked` is reachable only from `execute_settlements`, and an
evicted flight is permanently outside keeper enumeration. The pool's capped
active list also leaked the bucket's slot (the pool has no eviction
function). The documented safe-use condition ("needs no further on-chain
resolution") was unsatisfiable: every listed flight has buyers and
collateral.

**Fix — the report's option (2): a matching owner-gated reconciliation:**

- New owner-only `Controller.settle_evicted_flight(flight_id, date)`
  completes the release: it settles the pool bucket via `settle_on_time`
  (void semantics — held premiums forwarded to the vault as income, no
  payout, pool active-list slot freed), records the premium income on the
  vault, and unlocks the flight's `payoff × buyer_count` collateral.
- Guard rails keep it strictly terminal: it refuses while the oracle still
  has a `FlightData` row (`FlightDataStillPresent`, #316 — a present row
  means restore-and-settle is the correct path), refuses while the flight is
  still in the oracle active list (`FlightStillListed`, #317 — a listed
  flight is keeper-enumerable and must settle normally), and refuses unknown
  buckets (`FlightNotRegisteredInPool`, #318). `settle_on_time`'s own
  `Active`-status check makes the call cleanly non-repeatable.
- New `("sentinel", "evict_settled")` event (`EvictedFlightSettled` —
  flight_id topic; date, premium_income, collateral_released payload) pairs
  with the oracle's `FlightEvicted` so indexers can close out the flight's
  lifecycle.
- `evict_missing_flight`'s doc comment now states eviction is **step one of
  two** and that the archived row must not be restored afterwards (the
  reconciliation requires it absent); `spec/architecture.md`'s function
  reference documents both steps.

*Files:* `controller/src/{settle,events,error}.rs`,
`oracle_aggregator/src/admin.rs`, `spec/architecture.md`.
*Tests:* `controller/src/test.rs` — happy path (collateral released, TMA up
by the premiums, pool slot freed, bucket `SettledOnTime`, non-repeatable),
refusal while data present (#316), refusal while still listed (#317),
refusal for unknown flights (#318), and an unauthorized-caller panic test.
Archival is simulated by deleting the oracle row inside the oracle's storage
context — the same technique the oracle's own eviction tests use.

### CF5v2-L01 — `recover_uncollected(Recredit)` lacked an upper-bound backing check

**Confirmed (Low).** The Recredit arm guarded against underpaying an existing
credit but accepted any larger amount unchecked. A mis-keyed amount (e.g. a
decimals slip while reconstructing owed value from event logs) silently
created a claimable liability with no asset behind it; the eventual
`collect()` would consume asset backing outstanding shares — silent
insolvency surfacing as some unrelated party's failed transfer.

**Fix:** the Recredit arm now requires the credited amount to fit inside the
vault's asset surplus over managed assets
(`asset.balance(vault) − TMA` — exactly the pool of asset available to
satisfy claimable entries, since every legitimate credit already reduced TMA
when it was made). Violations revert with the new
`RecreditExceedsRecoverableSurplus` (#723). A correct restore of an archived
credit always fits; the bound is a floor (other users' uncollected credits
share the surplus), so it cannot catch every overpay — but it caps the
damage at value already owed to users, never asset backing shares.

*Files:* `risk_vault/src/{claims,error}.rs`.
*Tests:* new `test_recover_uncollected_recredit_exceeding_surplus_panics`
(#723); existing Recredit tests updated to model the archived credit's asset
physically present in the vault (mint-before-recredit), in both the vault
unit suite and integration groups 3 and 8.

---

## General improvements

| # | Item | Status |
|---|------|--------|
| 1 | `set_landed` plausibility floor still documented though deliberately removed | ✅ Doc fixed — `spec/architecture.md` state-machine rules and Oracle Trust Model now describe the input validation (`InvalidTimestamp`) and the deliberate acceptance of early arrivals |
| 2 | `SETTLED_RETENTION_DAYS` documented as 30, code is 7; missing-data prune behavior stale | ✅ Doc fixed — retention corrected to 7 days in prose and storage snippet; missing-`FlightData` behavior rewritten (retain + `MissingFlightData` + two-step eviction), replacing the obsolete "evict-and-continue" description |
| 3 | Controller deploy example passes nonexistent `--solvency_ratio`, omits `owner` / `authorized_keeper` | ✅ Doc fixed — deployment step (e) now mirrors the actual `__constructor` signature and notes the solvency ratio initializes to 100 and is tuned via `set_solvency_ratio` |
| 4 | `spec/audit.md` I-03 ("no upgrade path, accepted") contradicts the implemented owner-gated `upgrade()` | ✅ Doc fixed — I-03 marked superseded in the register and rewritten to describe the shared `sentinel_types::upgrade` mechanism and the flipped trade-off (mitigated by the I-02 multisig recommendation) |
| 5 | Dead error variant `MinLeadTimeExceedsMaximum = 302` | ✅ Fixed — variant removed; code 302 documented as retired and reserved (never reuse) |
| 6 | `FlightPoolManager::claim` did not renew the instance TTL (vault `collect` does) | ✅ Fixed — `claim` now renews the instance TTL alongside every other user-facing path |
| 7 | Pool `settle_delayed`/`settle_cancelled` opened the claim window without verifying the vault top-up arrived | ✅ Fixed — `settle_with_claim_window` now requires the pool's asset balance to cover `payoff × buyer_count` before opening the window (`PayoutNotReceived`, #418), mirroring the vault's premium-receipt check; unit tests reordered to the production sequence (top-up before settle) plus a new #418 test |
| 8 | `route_status` performs writes (TTL renewals, index self-heal) while governance is paused, contradicting the pause doc | ✅ Documented — in-code note at `route_status` and an explicit exemption paragraph in `spec/architecture.md`'s Emergency Stop section (protective writes, no privilege; behavior deliberately unchanged) |
| 9 | Governance `Admin(Address)` keys grow the shared instance entry with no documented scale assumption | ✅ Documented — `DataKey::Admin` doc comment states the small-roster assumption and the migration direction (per-address Persistent keys) if the operating model ever needs dozens of admins |

---

## Not addressed (unchanged accepted residuals)

The report's cross-cutting notes re-verified three previously accepted
residuals (pre-publication information asymmetry around the settlement
barrier; adverse selection on pre-departure-announced cancellations of
never-purchased flights; no owner reconciliation for an upward
`PendingOutcomes` desync). These remain accepted as documented in earlier
rounds; no code change was made for them in this pass.

---

## Interface changes in this pass

- **New controller entry point:** `settle_evicted_flight(flight_id, date)`
  (owner-only).
- **New events:** controller `("sentinel", "evict_settled")`
  (`EvictedFlightSettled`).
- **New error codes:** controller #316 `FlightDataStillPresent`,
  #317 `FlightStillListed`, #318 `FlightNotRegisteredInPool`;
  risk_vault #723 `RecreditExceedsRecoverableSurplus`;
  flight_pool_manager #418 `PayoutNotReceived`.
- **Removed:** controller error #302 `MinLeadTimeExceedsMaximum` (never
  emitted; code retired, not reused).
- **Behavioral tightening:** `recover_uncollected(Recredit)` reverts when the
  amount exceeds the vault's asset surplus over TMA;
  `settle_delayed`/`settle_cancelled` revert when the pool does not hold the
  bucket's full claimable value (the controller's production call order
  already satisfies both).

**Ops runbook addition:** after any `oracle.evict_missing_flight`, run
`controller.settle_evicted_flight` for the same `(flight_id, date)` — and do
not restore the archived `FlightData` row in between.
