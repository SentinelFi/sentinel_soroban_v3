# Nethermind AuditAgent Controller Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_auditagent_ai_controller_report.md`](../20260704_auditagent_ai_controller_report.md)
**Audited commit:** `6b0db9e` (main)
**Remediation date:** 2026-07-10
**Test status:** full workspace suite green — **357 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-CT-03 | High | Confirmed | ✅ Fixed (stale-flight void path releases collateral after a bounded timeout) |
| AA-CT-01 | Low | Confirmed | ✅ Already fixed in this remediation series (claim deadline capped); verified |
| AA-CT-04 | Low | Confirmed | ✅ Already fixed in this remediation series (terms snapshotted per bucket); verified |
| AA-CT-02 | Informational | Confirmed | ✅ Authorization model chosen and documented (approvals lapse on dormancy, fail closed) |

---

## Fixed

### AA-CT-03 — Unconfirmed flight dates can lock vault capital indefinitely
**Confirmed (High).** `buy_insurance` accepts any future day-aligned date for a
whitelisted route without proof that the date corresponds to a real scheduled
flight. A purchase for a bogus date registers the flight, transfers the
premium, and locks the full payoff in the vault — and the oracle row then
stays `NotInitiated` forever (no data will ever arrive for a flight that
doesn't exist). `classify_flights` treated `NotInitiated` as diagnostic-only
and `execute_settlements` ignores non-`ToBeSettled*` rows, so there was no
on-chain path that ever released the collateral or freed the policy-bucket
slot. Sybil buyers could repeat this per `(flight_id, date)` up to the
solvency limit, pinning underwriter capital at premium cost.

**Fix — an on-chain void timeout** (the report's recommendation 3):

- **Shared timeout constant** `STALE_FLIGHT_TIMEOUT_SECS` = 14 days
  (`sentinel_types::timeouts`, shared so the Controller's decision and the
  Oracle's validation can never drift). A real flight receives its estimated
  arrival within one executor cycle of purchase; a row still `NotInitiated`
  two weeks *past departure* means no flight data ever existed.
- **Controller** (`classify_flights`): a listed flight still `NotInitiated`
  past the timeout is voided — classified `ToBeSettledOnTime`, so the normal
  settlement pass forwards the premiums to the vault as yield, releases the
  locked payoff, and closes the pool bucket. A dedicated `FlightVoided` event
  distinguishes voids from ordinary on-time settlements for operators. The
  new `has_flight_data` oracle view gates the path: an *archived* row (TTL
  lapse on a real flight) is never voided — it keeps emitting the `ttl_miss`
  recovery diagnostic instead.
- **Oracle** (`set_to_be_settled`): the state machine gains exactly one new
  edge, `NotInitiated → ToBeSettledOnTime`, and enforces the timing itself —
  it panics with `StaleTimeoutNotReached` before `date + 14 days`, so no
  caller can void a flight the executor merely hasn't fetched yet.
  `NotInitiated → ToBeSettledDelayed/Cancelled` remain invalid: a dataless
  flight can never become payable, so voiding can't be abused to mint claims
  from bogus dates. The void increments the pending-outcomes counter (its
  premium income is unrecognized vault PnL), keeping the LP settlement
  barrier consistent through the classify→settle window.
- **Economics:** the premium is forfeited to the vault, not refunded — a
  refund would make the capital-lockup griefing nearly free, while forfeiture
  makes each occupied slot cost the full premium and compensates the LPs
  whose capital was pinned for `date + 14 days`.

> **Trade-off (documented):** if the oracle executor were down from purchase
> through 14 days past departure (so a *real* flight never even got an ETA),
> the void would settle it as on-time and a genuinely delayed/cancelled
> flight's buyers would lose payouts. A two-week total outage is a
> catastrophic ops failure with manual remediation regardless; the timeout
> can be revisited via the shared constant. The report's alternative —
> oracle pre-registration of confirmed flight instances before purchase —
> remains the architectural endgame and is deferred with the same
> pre-registration redesign noted in the Codex CAI-H01 remediation.

*Files:* `sentinel_types/src/lib.rs`, `oracle_aggregator/src/{storage,lifecycle,error}.rs`,
`controller/src/{settle,events,interfaces}.rs`.
*Tests:* `test_stale_not_initiated_void_gated_by_timeout` (oracle: rejected
before the timeout, delayed/cancelled targets always rejected, pending-
outcome counter balanced) and
`stale_unconfirmed_flight_voided_and_collateral_released` (integration: full
keeper cycle — collateral released, premium credited as vault yield, flight
settled, nothing claimable, barrier clear).

---

## Previously fixed — verified against this report

### AA-CT-01 — Buyer-key lifetime does not account for delayed settlement
**Confirmed (Low) at the audited commit; fixed in the
[FlightPoolManager remediation](20260704_auditagent_ai_flight_pool_manager_remediation.md)**
(same finding as AA-FPM-02). The pool now caps every settlement's claim
deadline at `date + 90 days` — the lifetime every buyer proof provably has
given the 90-day booking horizon and the fixed 180-day key TTL — which is
this report's preferred option 1 ("cap `claim_expiry` to a safely earlier
deadline"). The Controller-side compile-time invariant
(`book-ahead + claim window ≤ buyer TTL`) remains as the static bound; the
pool-side cap adds the dynamic settlement-delay dimension the invariant
could not express. Regression test:
`test_claim_deadline_capped_to_buyer_proof_lifetime` (the report's
maximum-horizon delayed-settlement boundary).

### AA-CT-04 — Route term changes can block later purchases for active flight buckets
**Confirmed (Low) at the audited commit; fixed in the
[GovernanceModule remediation](20260704_auditagent_ai_governance_module_remediation.md)**
(same finding as AA-GM-03), using this report's recommendation 1 verbatim:
`buy_insurance` now reads the pool's stored config for an already-registered
`(flight_id, date)` and charges/locks against those pinned terms rather than
current Governance terms. Term changes apply only to not-yet-registered
dates. Recommendation 3 (a read path for bucket-level terms) already exists —
`flight_pool_manager.get_flight_config` is public. Regression test:
`test_second_buyer_transacts_at_snapshotted_terms_after_term_change`.

---

## Documented (model decision)

### AA-CT-02 — Dormant whitelist approvals expire without explicit revocation
**Confirmed (Informational).** Whitelist approvals are persistent entries
with a ~180-day TTL, refreshed on every purchase the buyer makes; a buyer
dormant for the full window lapses silently and cannot self-refresh (the
purchase gate rejects before the touch runs).

**Resolution — the expiring model is chosen and now explicit** (the report's
first option): dormancy-lapse is treated as periodic re-attestation of
inactive accounts. It fails closed (an expired approval denies purchase, it
never grants), recovery is a single `add_whitelisted_buyer` call, and the
behavior is now documented on the entrypoint itself. Operational monitoring
(watching `buyer_whitelisted` events and re-extending or alerting before
dormant entries age out) is noted as the off-chain complement; on-chain
expiry timestamps were not added because TTLs are not readable on-chain and
the whitelist is a default-off feature.

*Files:* `controller/src/whitelist.rs` (documentation).

---

## Files changed in this pass

Source: `sentinel_types/src/lib.rs`,
`oracle_aggregator/src/{storage,lifecycle,error}.rs`,
`controller/src/{settle,events,interfaces,whitelist}.rs`.
Tests: `oracle_aggregator/src/test.rs`,
`integration_tests/src/tests/group5_edge_cases.rs`.
Docs: `spec/architecture.md` (state-machine diagram gains the void edge).
