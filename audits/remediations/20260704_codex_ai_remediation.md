# Codex AI Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_codex_ai_report.md`](../20260704_codex_ai_report.md)
**Audited commit:** `6b0db9e` (main)
**Remediation date:** 2026-07-10
**Test status:** full workspace suite green — **340 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean. Executor (TypeScript) changes verified
by review — the executor is not part of the CI test suite.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CAI-H01 | High | Confirmed | ✅ Fixed (pre-registration cancellation path + executor same-cycle cancellation push) |

---

## Fixed

### CAI-H01 — Flights already cancelled off-chain remain insurable until the oracle catches up

**Confirmed (High).** The report identified a circular admission dependency:
`OracleAggregator::set_cancelled` required an existing `FlightData` record, but
only `Controller::buy_insurance` creates that record (lazy registration on the
first purchase). A flight publicly cancelled before anyone bought a policy was
therefore structurally *unclosable* on-chain — the purchase gate saw the
missing record as `NotInitiated` (purchasable), and each purchase of the
already-dead flight was a deterministic `payoff − premium` claim against the
vault, repeatable across Sybil addresses up to the solvency limit. Two
production-executor gaps lengthened the window further: the `NotInitiated`
branch ignored AeroAPI's `cancelled` flag entirely, and the `Active` branch
only checked it after `ETA + 1 hour`.

**Fix — three coordinated changes:**

1. **Oracle can record a cancellation for a not-yet-registered flight**
   (`oracle_aggregator/src/lifecycle.rs`). `set_cancelled` no longer panics on
   a missing record: it creates the record directly in `Cancelled`. This
   breaks the circular dependency — cancellation publication no longer waits
   for a purchase, and the purchase gate (which already rejects anything
   outside `NotInitiated`/`Active`) then blocks the first buyer and every
   Sybil follower. This implements the report's key requirement that "the
   oracle can change the sale state to `Cancelled` independently of whether
   any policy exists."

   A record created this way is deliberately kept **out of the active flight
   list and the pending-outcomes counter**. Absence of a record proves no
   policy exists (every purchase registers the flight in the same
   transaction), so there is no premium, collateral, or vault PnL to settle.
   Feeding the record into the classify/settle pipeline would strand it
   forever on a missing pool config and permanently jam the vault's
   settlement barrier; leaving it out keeps LP entry/exit open and keeper
   cycles clean. The record acts purely as a purchase-blocking tombstone, and
   `register_flight`'s idempotent no-op path cannot resurrect it.

2. **Executor pushes cancellations in the same cycle they become visible**
   (`executor/centralized_cron/src/flight_data_fetcher.ts`). The
   `NotInitiated` branch now checks `apiData.cancelled` first and calls
   `set_cancelled` (the `NotInitiated → Cancelled` transition already existed
   on-chain) instead of storing an ETA for a dead flight. The `Active` branch
   now fetches AeroAPI data every cycle and checks `cancelled` **before** the
   `ETA + 1 hour` gate; only the landed resolution still waits for the gate.
   A pre-departure cancellation is now recorded within one 2-hour cron cycle
   instead of after the flight's scheduled arrival. (Cost note: `Active`
   flights are now fetched every cycle rather than only post-ETA — the
   security property requires observing cancellations promptly.)

3. **Regression tests** mapped to the report's requested coverage:
   - *Cancellation known before the first policy:*
     `test_set_cancelled_before_registration_creates_purchase_blocking_record`,
     `test_set_cancelled_twice_on_preregistration_record_fails`,
     `test_register_flight_after_preemptive_cancellation_is_noop`
     (`oracle_aggregator/src/test.rs`);
     `test_buy_insurance_rejected_for_preemptively_cancelled_flight`
     (`controller/src/test.rs`);
     `preemptive_cancellation_blocks_all_purchases_without_jamming_protocol`
     (`integration_tests/src/tests/group1_lifecycle.rs`) — also proves the
     tombstone trips neither the settlement barrier nor keeper cycles, and an
     unrelated flight settles normally alongside it.
   - *Cancellation while the record is `NotInitiated`:*
     `test_set_cancelled_from_not_initiated_enters_settlement_pipeline`
     (oracle) and `lifecycle_cancelled_before_eta_recorded` (integration) —
     the registered-with-buyers case takes the normal pipeline: pending
     outcome recorded, later buyers rejected, existing policy settles and pays.
   - *Multiple attacker-controlled buyer addresses:* the Sybil loop inside
     `preemptive_cancellation_blocks_all_purchases_without_jamming_protocol`.
   - *Ordering around an oracle cancellation update:* every purchase after the
     cancellation write is rejected (new tests plus the pre-existing
     `test_buy_insurance_rejected_after_oracle_cancellation`).
   - *Cancellation while `Active` before the executor's ETA gate:* the
     on-chain `Active → Cancelled` path was already exercised (existing
     settlement-barrier and lifecycle tests cancel well before ETA); the ETA
     gate itself is executor logic, addressed by change 2 and verified by
     review.
   - *Whitelist modes:* orthogonal to this fix — the gate binds before and
     independently of the buyer whitelist; existing whitelist tests cover both
     modes.

*Files:* `oracle_aggregator/src/lifecycle.rs`,
`executor/centralized_cron/src/flight_data_fetcher.ts`.
*Tests:* `oracle_aggregator/src/test.rs`, `controller/src/test.rs`,
`integration_tests/src/tests/group1_lifecycle.rs`.

---

## Adopted design vs. the report's primary recommendation

The report's first-choice remedy is a canonical, oracle-attested flight
registry (pre-registration, an explicit `OpenForPurchase` state, atomic
cancellation + sale closure), with signed purchase-time attestations as the
alternative if lazy registration remains. The applied fix keeps lazy
registration but adopts the recommendation's decisive element: **the oracle
can now publish a cancellation independently of policy existence, and
publication closes sales atomically** (the purchase gate reads the oracle
status in the same transaction as admission). Together with the executor
pushing cancellations the cycle they are observed, the exploit's precondition
— a publicly cancelled flight the chain cannot represent — is removed.

> **Residual risk & deferred items (documented):**
> - The on-chain path provides the *capability* to close an unregistered
>   flight; observing cancellations for flights nobody has bought yet is an
>   operational duty. The executor polls only registered (purchased) flights,
>   so closing a never-purchased flight requires the operator to invoke
>   `set_cancelled` (any monitoring feed of the whitelisted routes' upcoming
>   departures can drive this). Because the first purchase registers the
>   flight, the executor's same-cycle cancellation check then bounds the
>   remaining exposure to at most one cron cycle after the first purchase.
> - A purchase that lands strictly before the cancellation is recorded
>   on-chain remains a valid policy — the irreducible window is oracle
>   publication latency (per cycle above), not the structural gap the report
>   identified.
> - The full canonical registry (pre-registered instances, provider-specific
>   identifiers, `OpenForPurchase` state machine) and signed purchase
>   attestations remain the architecturally stronger endgame and are deferred
>   as a protocol-level redesign; the `min_lead_time` purchase cutoff
>   (owner-configurable) already provides the report's "conservative sale
>   cutoff" lever.
