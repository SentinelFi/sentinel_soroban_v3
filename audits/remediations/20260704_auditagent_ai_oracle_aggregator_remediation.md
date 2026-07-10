# Nethermind AuditAgent OracleAggregator Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_auditagent_ai_oracle_aggregator_report.md`](../20260704_auditagent_ai_oracle_aggregator_report.md)
**Audited commit:** `6b0db9e` (main)
**Remediation date:** 2026-07-10
**Test status:** full workspace suite green — **347 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-OA-01 | Low | Confirmed | ✅ Interim mitigations extended (occupancy observability added; retention already shortened); migration deferred |
| AA-OA-02 | Low | Confirmed | ✅ Fixed (prune retains archived entries; owner-only confirmed eviction) |
| AA-OA-03 | Low | Confirmed | ✅ Fixed (zero / pre-departure timestamps rejected) |
| AA-OA-04 | Low | Confirmed | ✅ Fixed (90-day settlement-grace TTL for outcome-recorded flights) |

---

## Fixed

### AA-OA-02 — Missing-data pruning can orphan unresolved flights
**Confirmed (Low).** `prune_settled` treated a missing `FlightData` read as
removable and evicted the active-list entry. On Soroban, a missing persistent
read usually means *archived past TTL*, not resolved — the flight may still
have premiums, payouts, and locked collateral pending, and archived entries
are restorable via ledger restoration. Because pruning is permissionless, any
caller could turn a temporary TTL lapse into an orphaned workflow item: after
eviction, the `(flight_id, date)` tuple disappears from the enumeration the
keeper and executor drive settlement from.

**Fix — retain + operator-confirmed eviction** (the report's options 1 and 3):

- `prune_settled` now **retains** entries whose `FlightData` is missing and
  emits the `data_missing` diagnostic (event struct renamed
  `MissingFlightDataPruned` → `MissingFlightData`; same topic, so indexers
  are unaffected) as a recovery-required signal. The tuple stays discoverable
  on-chain; after ledger restoration the normal pipeline resumes by itself.
- New owner-only `evict_missing_flight(flight_id, date)` frees the capped
  list slot once the operator confirms off-chain that the flight needs no
  further on-chain resolution. It is bounded: it panics with
  `FlightDataStillPresent` if the data still exists (live flights can only
  leave the list via the normal settle-and-prune path) and with
  `FlightNotInList` for unknown tuples. Emits a `FlightEvicted` audit event.
- New `has_flight_data(flight_id, date)` view distinguishes an archived entry
  from a genuinely unregistered flight — `get_flight_data` reports both as
  `NotInitiated` (this also serves AA-OA-04's "distinguish archived from
  NotInitiated" recommendation).

*Files:* `oracle_aggregator/src/{lifecycle,admin,queries,events,error}.rs`.
*Tests:* `test_prune_settled_retains_missing_flight_data`,
`test_evict_missing_flight_owner_path`.

### AA-OA-03 — Zero actual-arrival timestamps can settle as on time
**Confirmed (Low).** `set_landed` accepted any `u64`, including `0` — the
unset sentinel. With a positive estimate, the Controller's saturating delay
computation turns a zero actual arrival into a zero delay, settling a
delayed flight as on-time and denying policyholder payouts, with no
correction path in the forward-only state machine.

**Fix:** both timestamp writes now validate at the door, per the report's
recommendation: `set_landed` rejects `actual_arrival_time == 0` or an arrival
before the departure day's midnight (`actual_arrival_time < date`);
`set_estimated_arrival` applies the same rule to the estimate. New error
`InvalidTimestamp`. The pre-departure bound is the domain-appropriate check
the report asks for — with day-aligned flight identity, no legitimate arrival
can precede the departure date.

> **Not adopted (documented):** an on-chain correction/dispute procedure
> before settlement. The forward-only state machine is a deliberate guarantee
> (no outcome can be rewritten once public — the vault settlement barrier and
> LP pricing depend on it). Input validation now rejects the malformed-payload
> class this finding identified; residual wrong-but-plausible data from the
> authorized oracle remains a trusted-role assumption, unchanged.

*Files:* `oracle_aggregator/src/lifecycle.rs`, `oracle_aggregator/src/error.rs`.
*Tests:* `test_arrival_timestamps_validated`; one integration fixture
(`multiple_flights_independent_settlements`) was corrected — it reused
day-one arrival times for a day-two flight, physically inconsistent data the
new validation rightly rejects.

### AA-OA-04 — Classified flights can archive before terminal settlement
**Confirmed (Low).** Outcome and classification writes extended `FlightData`
TTL toward the flight *date* — already in the past at that point — so the
extension bottomed out at the ~31-day floor. A keeper/protocol outage longer
than that could archive a `Landed`/`Cancelled`/`ToBeSettled*` record;
`set_settled` then panics `"flight not registered"` and premium
finalization, payout funding, and collateral release stay blocked until
manual restoration.

**Fix:** `set_landed`, `set_cancelled` (registered branch), and
`set_to_be_settled` now extend to an explicit settlement horizon:
`max(now, date) + SETTLEMENT_GRACE_SECS` (90 days — far beyond any plausible
operational outage, and with the 30-day TTL buffer still under the 180-day
network maximum). The pre-registration cancellation tombstone keeps its
date-based TTL (nothing to settle), and `set_settled` still deliberately
lets settled records expire naturally. The report's "distinguish archived
from NotInitiated" item is covered by the new `has_flight_data` view
(AA-OA-02 above); monitored key-level TTL extension remains the off-chain
TTL cron's job (layered defense, unchanged).

*Files:* `oracle_aggregator/src/{lifecycle,storage,constants}.rs`
(`settlement_deadline` helper, `SETTLEMENT_GRACE_SECS`).

---

## Mitigated (architectural fix deferred)

### AA-OA-01 — Global active-flight capacity can block new registrations
**Confirmed (Low).** The 1,000-entry cap on the single-vector active list is
a deliberate safeguard against the 65,536-byte instance-entry limit, but once
reached, every first purchase of a new `(flight_id, date)` reverts with
`ActiveFlightListFull`.

**Mitigations** (this pass and prior):

- **Occupancy observability (this pass, report recommendation 1–2):** new
  `get_active_flight_count()` view — operators alert at conservative
  thresholds and prune promptly, before the cap starts rejecting
  registrations. The owner-only `evict_missing_flight` (AA-OA-02) adds a
  bounded manual release valve for slots pinned by archived entries.
- **Retention already shortened (prior pass):** settled flights become
  prunable after 7 days instead of 30 (see the
  [Nemesis remediation](20260704_nemesis_auditor_remediation.md), NM-002),
  raising tolerated settled-flight throughput ~4× (~142 settled flights/day
  sustained against the cap, plus concurrent unsettled flights bounded by the
  90-day booking horizon — the documented throughput envelope the report
  asks for).
- **Immediate removal on settle (report recommendation 3) — not adopted:**
  the 7-day retention window keeps freshly settled flights queryable on-chain
  for direct integrations; shortening further is a config change
  (`SETTLED_RETENTION_DAYS`) available if capacity pressure demands it.

> **Deferred (documented):** the structural fix — individually keyed active
> records with paginated enumeration — is the shared monolithic-vector
> migration tracked since AA-OA-02/NM-002 of the prior reports, deferred as a
> larger storage migration.

*Files:* `oracle_aggregator/src/queries.rs`.
*Tests:* count assertions in `test_prune_settled_retains_missing_flight_data`
and `test_evict_missing_flight_owner_path`.

---

## Files changed in this pass

Source: `oracle_aggregator/src/{lifecycle,admin,queries,events,storage,constants,error}.rs`.
Tests: `oracle_aggregator/src/test.rs`,
`integration_tests/src/tests/group4_parallel.rs` (fixture correction).
Docs: `spec/architecture.md` (function reference — new queries and the
owner eviction entry).
