# Nethermind AuditAgent AI — Controller Report — Remediation Summary

**Source report:** [`20260625_auditagent_ai_controller_report.md`](../20260625_auditagent_ai_controller_report.md)
**Remediation date:** 2026-07-01
**Scope:** `contracts/controller` (+ GovernanceModule / FlightPoolManager /
OracleAggregator for cross-contract identity).
**Test status:** full workspace suite green — **329 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-CT-01 | Medium | Confirmed | ✅ Fixed (route uniqueness index made non-expiring) |
| AA-CT-02 | Medium | Confirmed | ✅ Fixed (TravelerFlights bounded, non-blocking) |
| AA-CT-03 | Low | Confirmed | ✅ Already fixed (empty booking interval rejected) |

---

## AA-CT-01 — Route dimensions are dropped from policy identity after authorization
**Confirmed (Medium). Fixed via the governance-level remediation the report
recommends.** The Controller validates the full `(flight_id, origin, dest)` route
but keys downstream pool/oracle/index state by `(flight_id, date)`, relying on
GovernanceModule to guarantee one `(origin, dest)` per flight number. The report's
concrete failure required that guarantee to break: the `FlightRoute(flight_id)`
uniqueness index could **archive independently** of an actively-used route, after
which a second, conflicting route could be whitelisted for the same flight number
and collide in the shared `(flight_id, date)` state.

That root cause is closed by the FlightRoute-index fix (Nemesis NM-007 /
AuditAgent AA-GM-01, see
[`20260625_auditagent_ai_governance_module_remediation.md`](20260625_auditagent_ai_governance_module_remediation.md)):
the index is now renewed in lockstep with the route on every on-chain touch
(`route_status`, `disable`/`enable`/`update_route_terms`, and `whitelist`), and
neither is cron-extended — so there is no path that keeps a route alive while its
uniqueness index lapses. The index therefore cannot expire independently, and
`whitelist_route` still rejects a second `(origin, dest)` for an existing
flight_id, so **at most one route exists per flight number at any time**. A
`route_status(flight_id, origin, dest)` that returns `Active` is consequently the
canonical route for that flight number, which is exactly the invariant the
Controller relies on — no separate Controller-side assertion is required.

Combined with the day-aligned `date` requirement (Nemesis NM-001, which makes
`(flight_id, day)` map to a single physical flight), the reduced
`(flight_id, date)` identity is unambiguous on the buy path.

> **Deferred (documented):** the report's *preferred* remediation — a canonical,
> oracle-attested flight-instance identifier threaded through every contract's
> keys, buyer/claim records, events, and the traveler index — is an architectural
> redesign shared with Nemesis NM-001's residual and the Codex CAI-H01 follow-ups.
> It is not included here; the non-expiring uniqueness invariant plus day-alignment
> deterministically prevent the collision the finding describes.

## AA-CT-02 — TravelerFlights grows into a per-address permanent purchase denial
**Confirmed (Medium). Fixed.** `TravelerFlights(addr)` is a single append-only
`Vec` in one persistent entry. It is never pruned, so a sufficiently active
address would grow the entry toward Soroban's 65,536-byte limit (~1,640 entries)
— and because the append happens on the `buy_insurance` path, exceeding it would
**permanently block that address from buying**.

**Fix (non-blocking bound):** the index is now capped at
`MAX_TRAVELER_FLIGHTS = 1_000`, but — unlike the global active-flight lists, which
are drained by settlement and so use a *blocking* cap — this list is never
pruned, so blocking would itself be the permanent-denial defect. Instead, when the
index is full `append_traveler_flight` **evicts the oldest entry** and appends the
newest, so `buy_insurance` is never blocked and the entry size stays bounded. This
index is a frontend "My Policies" convenience — canonical policy ownership lives
in FlightPoolManager and every purchase emits an event — so keeping the most
recent 1,000 on-chain (with older history reconstructable from events) is a safe
trade.
*Files:* `controller/src/{constants,storage}.rs`.
*Test:* `test_traveler_flights_index_is_bounded` (seeds the index to the cap,
appends once, and asserts the length stays at the cap, the oldest entry is
evicted, and the newest is retained).

> **Deferred (documented):** the report's primary recommendation — paginated /
> individually-keyed traveler entries with a counter — is the same keyed-storage
> migration deferred across the other monolithic-vector findings (AA-OA-02,
> AA-FPM-02, Nemesis NM-006). The non-blocking cap removes the Medium-severity
> impact (permanent purchase denial) in the interim.

## AA-CT-03 — Maximum allowed minimum lead time disables all policy purchases
**= Nemesis NM-009. Already fixed.** See
[`20260625_nemesis_auditor_remediation.md`](20260625_nemesis_auditor_remediation.md).
`assert_min_lead_time` now rejects `min_lead_time >= MAX_BOOK_AHEAD_SECS` with
`Error::MinLeadTimeLeavesNoBookingWindow`, applied in both the constructor and
`set_min_lead_time`, so the owner can no longer configure an empty booking
interval (`now + min_lead < date <= now + MAX_BOOK_AHEAD`). Covered by
`test_set_min_lead_time_equal_to_booking_horizon_panics` and
`test_set_min_lead_time_just_below_horizon_ok`. No further change required.

---

## Files changed

Source (2): `controller/src/{constants,storage}.rs`.
Tests (1): `controller/src/test.rs`.
