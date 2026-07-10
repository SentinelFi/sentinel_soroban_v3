# Nethermind AuditAgent FlightPoolManager Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_auditagent_ai_flight_pool_manager_report.md`](../20260704_auditagent_ai_flight_pool_manager_report.md)
**Audited commit:** `6b0db9e` (main)
**Remediation date:** 2026-07-10
**Test status:** full workspace suite green — **355 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-FPM-01 | Medium | Confirmed | ✅ Interim mitigations (occupancy observability); keyed-entry migration deferred |
| AA-FPM-02 | Low | Confirmed | ✅ Fixed (claim deadline capped to the buyer proofs' guaranteed lifetime) |
| AA-FPM-03 | Low | Confirmed | ✅ Fixed (instance TTL renewed on all owner maintenance paths) |

---

## Fixed

### AA-FPM-02 — Buyer proof TTL does not account for delayed settlement
**Confirmed (Low).** Buyer entitlement keys are written at purchase with a
fixed 180-day TTL (the network maximum) and cannot be renewed at settlement —
the contract has no iterable buyer list. With a 90-day booking horizon and a
60-day claim window, only ~30 days of settlement-delay margin remained: a
settlement opening its claim window more than ~30 days after departure could
leave the flight *claimable* while the earliest buyers' proofs archived, so
their valid `claim` calls returned `NoPolicy` and the funded payout was later
swept.

**Fix — deadline cap derived from the proofs' guaranteed lifetime** (the
report's recommendation 2): the earliest possible purchase is 90 days before
departure, so every buyer proof is provably alive until at least
`date + 90 days`. `settle_delayed` / `settle_cancelled` now clamp the
controller-supplied claim deadline to that horizon
(`MAX_CLAIM_DEADLINE_AFTER_DATE_SECS`). Consequences:

- Normal operation is unchanged: settlement within ~30 days of departure keeps
  its full 60-day claim window (the cap only binds later than that).
- A moderately delayed settlement gets a correspondingly shorter window —
  every second of which every buyer can actually prove their policy for. The
  cap is the on-chain encoding of the report's "explicit maximum
  settlement-delay assumption".
- A settlement delayed past `date + 90 days` still settles (refusing would
  strand the bucket and jam the settlement pipeline and the vault's pending-
  outcome barrier) but its window is born expired: claims fail closed
  *uniformly* instead of silently discriminating against early buyers, and
  `sweep_expired` routes the funds to the recovered balance for owner-driven
  manual remediation — an ops failure of that magnitude needs manual handling
  regardless.

The report's corollary (an archived buyer key letting the same address buy
twice pre-settlement) is not reachable under current bounds: purchases stop
at departure (lead-time gate), and every proof outlives `date` by at least
90 days.

> **Not adopted (documented):** an iterable per-flight buyer registry
> (recommendation 1) would allow renewing every proof through any
> claim deadline, but is an unbounded-growth storage structure of the same
> family as the deferred active-list migration; the deadline cap achieves the
> entitlement guarantee without it.

*Files:* `flight_pool_manager/src/{settle,constants}.rs`.
*Test:* `test_claim_deadline_capped_to_buyer_proof_lifetime` — a
maximum-delay settlement stores the capped deadline, claims fail closed, and
the funds are sweepable (the report's requested delayed-settlement scenario).

### AA-FPM-03 — Owner maintenance paths do not refresh instance TTL
**Confirmed (Low).** `withdraw_recovered`, `pause`, and `unpause` mutated
instance state without renewing the instance TTL. These are exactly the calls
made during incidents — when the external TTL cron is most likely to be
degraded — so an emergency intervention could succeed while leaving the
contract to archive moments later.

**Fix:** all three paths now call `extend_instance_ttl` (the report's
recommendation verbatim). The external extender remains defense in depth.
(TTL extension is not observable from the test harness; the change is
verified by review — the calls sit first in each function.)

*Files:* `flight_pool_manager/src/{admin,traits}.rs`.

---

## Mitigated (architectural fix deferred)

### AA-FPM-01 — Global active-flight cap can halt new policy-bucket registration
**Confirmed (Medium).** All unsettled policy buckets share one instance-stored
vector capped at 1,000 entries (the deliberate safeguard against the
65,536-byte instance-entry limit). Each first purchase of a distinct
`(flight_id, date)` consumes a slot until settlement prunes it, so demand —
organic or coordinated — can saturate the cap and block new-bucket creation
protocol-wide.

**Mitigations** (the report's recommendation 4; recommendations 1/5 deferred):

- **Occupancy observability:** new `get_active_flight_count()` view, matching
  the gauges added on the oracle and vault sides. Operators alert at
  conservative thresholds and react (settlement throughput, keeper cadence)
  before registration starts rejecting.
- **Existing structural bounds noted:** unlike the oracle list (which retains
  settled flights for 7 days), the pool removes buckets *immediately* at
  settlement, so pool occupancy equals concurrent unsettled buckets — bounded
  in practice by the 90-day booking horizon times the whitelisted-route
  count. Saturation requires premium payment and vault collateral per slot
  (the report's own cost observation), and the governance route whitelist
  bounds which `(flight_id, date)` pairs are admissible at all.
- **Capacity as a launch parameter:** per the report, the cap is documented
  as a production capacity limit — route onboarding and keeper cadence should
  be sized against it (`spec/architecture.md` function reference lists the
  gauge for monitoring).

> **Deferred (documented):** individually keyed active-flight records with
> paginated enumeration (recommendations 1/5) — the same monolithic-vector
> migration tracked across AA-OA-01/NM-002. Per-route/per-epoch capacity
> allocation and differentiated bucket-opening costs (recommendations 2/3)
> are economic-design changes deferred with it.

*Files:* `flight_pool_manager/src/queries.rs`.
*Test:* `test_active_flight_count_tracks_registration_and_settlement`.

---

## Files changed in this pass

Source: `flight_pool_manager/src/{settle,constants,admin,traits,queries}.rs`.
Tests: `flight_pool_manager/src/test.rs`.
Docs: `spec/architecture.md` (function-reference row for the occupancy gauge).
