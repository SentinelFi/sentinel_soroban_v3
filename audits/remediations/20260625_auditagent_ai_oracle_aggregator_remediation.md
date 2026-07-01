# Nethermind AuditAgent AI — OracleAggregator Report — Remediation Summary

**Source report:** [`20260625_auditagent_ai_oracle_aggregator_report.md`](../20260625_auditagent_ai_oracle_aggregator_report.md)
**Remediation date:** 2026-07-01
**Scope:** `contracts/oracle_aggregator` (+ Controller booking bounds and the TTL
executor for cross-checking).
**Test status:** full workspace suite green — **326 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

Two of the three findings were already resolved in the Nemesis pass on the same
commit and are cross-referenced below; AA-OA-02 is fixed here.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-OA-01 | Medium | Confirmed | ✅ Already fixed (deadline-derived FlightData TTL) |
| AA-OA-02 | Medium | Confirmed | ✅ Fixed / mitigated (ActiveFlightList length cap) |
| AA-OA-03 | Medium | Confirmed | ✅ Fixed (batch under footprint; scan bounded by the cap) |

---

## Fixed in this pass

### AA-OA-02 — ActiveFlightList reaches the contract-instance entry-size limit
**Confirmed (Medium).** `ActiveFlightList` is a single `Vec<(Symbol, u64)>` in
the contract-instance entry. Every `register_flight` appends and rewrites it, so
sustained registrations could grow the entry past Soroban's 65,536-byte limit
(~1,629 entries in the assessed layout), after which `register_flight` — and the
other instance-state writes that share the entry — revert, blocking protocol-wide
flight registration.

**Fix (bounded mitigation, the report's recommended interim safeguard):**
`register_flight` now rejects a new flight with `Error::ActiveFlightListFull`
once the list reaches `MAX_ACTIVE_FLIGHTS = 1_000` — comfortably below the
measured limit, leaving headroom for longer flight idents and other instance
state. Settled flights are evicted by `prune_settled`, freeing capacity, so the
cap bounds the *concurrent* active set rather than lifetime throughput. The
idempotent re-registration path (existing flight → extend TTL and return) is
unaffected, so the cap only gates genuinely new `(flight_id, date)` entries.
*Files:* `oracle_aggregator/src/{constants,error,lifecycle}.rs`.
*Test:* `test_register_flight_rejects_when_active_list_full` (seeds the list to
the cap and asserts the next distinct registration reverts with `#606`).

> **Deferred (documented):** the auditor's primary recommendation — individually-
> keyed active entries with a compact index / separate active-vs-historical
> indexes — is a storage-layout migration shared with the other monolithic-vector
> findings (Nemesis NM-006, and the pool/controller ActiveFlightList/TravelerFlights
> findings). It is not included here; the length cap makes the current design safe
> in the interim by preventing the entry from ever reaching the size limit.

### AA-OA-03 — prune_settled exceeds transaction limits at its configured batch size and remains O(n)
**Confirmed (Medium).** Two parts:
1. **Footprint** — a 100-entry inspection window required ~103 footprint ledger
   entries (the per-entry `FlightData` persistent lookups plus fixed
   instance/invocation entries), exceeding Soroban's 100-entry limit, so the
   daily prune reverted before committing.
2. **O(n)** — `prune_settled` loads the whole `ActiveFlightList`, iterates every
   element, and rebuilds the vector, so cost scaled with total list length.

**Fix:**
- The footprint failure is resolved by reducing the inspection window to
  `MAX_PRUNE_BATCH = 60` (landed in the Nemesis pass, NM-005), which keeps the
  per-call `FlightData` lookups plus fixed entries well under the 100-entry
  footprint limit. The rotating cursor still sweeps the whole list across
  repeated (permissionless, idempotent) calls.
- The O(n) full-list scan/rebuild is now **bounded** by the AA-OA-02 cap
  (`MAX_ACTIVE_FLIGHTS = 1_000`): the list can never exceed the cap, so the
  per-call iteration and the instance-entry rewrite are bounded in both CPU and
  size. The vector is only rewritten when an entry is actually evicted.

*Files:* `oracle_aggregator/src/constants.rs` (batch; cap from AA-OA-02).

> **Deferred (documented):** eliminating the O(n) rebuild entirely — swap-removal
> and/or individually-keyed active records so a prune touches only the batch
> window — is part of the same keyed-storage migration deferred under AA-OA-02.
> With the length cap in place the current scan is bounded and safe in the
> interim.

---

## Already fixed (Nemesis pass on the same commit)

### AA-OA-01 — FlightData TTL is shorter than the permitted pre-departure lifecycle
**= Nemesis NM-008.** Already remediated in
[`20260625_nemesis_auditor_remediation.md`](20260625_nemesis_auditor_remediation.md):
the oracle now extends each `FlightData` entry via a deadline-derived helper
(`extend_flight_ttl_to`) sized to cover the flight `date` plus a ~30-day
settlement buffer (clamped to the network-max persistent TTL, floored at the
prior 31-day extension), applied in `register_flight` and every lifecycle write.
A flight insured up to the 90-day booking horizon no longer archives before the
oracle reports on it. No further change required.

---

## Files changed

Source (3): `oracle_aggregator/src/{constants,error,lifecycle}.rs`.
Tests (1): `oracle_aggregator/src/test.rs`.
