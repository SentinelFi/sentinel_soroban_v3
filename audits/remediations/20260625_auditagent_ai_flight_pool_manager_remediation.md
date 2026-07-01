# Nethermind AuditAgent AI — FlightPoolManager Report — Remediation Summary

**Source report:** [`20260625_auditagent_ai_flight_pool_manager_report.md`](../20260625_auditagent_ai_flight_pool_manager_report.md)
**Remediation date:** 2026-07-01
**Scope:** `contracts/flight_pool_manager` (+ Controller / RiskVault for the
settlement authorization path).
**Test status:** full workspace suite green — **328 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-FPM-01 | Medium | Confirmed | ✅ Already fixed (Controller records premium income directly) |
| AA-FPM-02 | Medium | Confirmed | ✅ Fixed / mitigated (ActiveFlightList length cap) |

---

## AA-FPM-01 — Missing nested Controller authorization blocks on-time settlement
**= cosminmarian M-01. Already fixed.** See
[`20260625_cosminmarian53_soroban_auditor_remediation.md`](20260625_cosminmarian53_soroban_auditor_remediation.md).

On-time settlement had `FlightPoolManager::settle_on_time` transfer the collected
premiums to RiskVault and then call the vault's controller-only
`record_premium_income`, passing the Controller's address. Soroban does not
propagate the Controller's authorization to a sub-invocation the *pool* makes, so
`record_premium_income`'s `controller.require_auth()` only passed under the tests'
non-root auth mocking; in production every on-time flight with at least one buyer
would revert, stranding premiums and locked collateral.

The fix restructured the call so each contract authorizes only its direct caller:
`settle_on_time` now transfers the premiums and **returns** the transferred total
(`-> i128`) without calling the vault; `Controller::execute_settlements` captures
that value and calls `RiskVault::record_premium_income` **directly**, so the
Controller is the authorizing caller the vault expects. Because this removed the
only non-root contract authorization in the system, the whole test suite now runs
under plain `mock_all_auths()` — the suite (including end-to-end on-time
settlement) passing under root-frame-only auth is the proof the production path is
correct. Covered by `on_time_settlement_records_premium_income_via_controller`
(integration group 6) and the updated `flight_pool_manager::test_settle_on_time_*`
tests. No further change required.

---

## AA-FPM-02 — ActiveFlightList imposes a hard protocol-wide flight-capacity ceiling
**Confirmed (Medium). Fixed / mitigated.** `ActiveFlightList` is a single
`Vec<(Symbol, u64)>` in the contract-instance entry. Every `register_flight`
appends and rewrites it, so sustained first-purchases could grow the entry past
Soroban's 65,536-byte limit (~1,626 entries in the assessed layout), after which
new flight registration — and the settlement writes that rewrite the list on
eviction — revert, denying protocol-wide registration.

**Fix (bounded mitigation, the report's recommended interim safeguard):**
`register_flight` now rejects a new flight with `Error::ActiveFlightListFull`
(`#417`) once the list reaches `MAX_ACTIVE_FLIGHTS = 1_000` — comfortably below
the measured limit, with headroom for longer flight idents and other instance
state, and matching the OracleAggregator cap for a uniform interim bound. Settled
flights are removed from the list on settlement (`prune_active_list`), so the cap
bounds the *concurrent* active set rather than lifetime throughput. The idempotent
re-registration path (existing flight → term-match check + TTL extension, early
return) runs before the append, so the cap only gates genuinely new
`(flight_id, date)` entries.
*Files:* `flight_pool_manager/src/{constants,error,lifecycle}.rs`.
*Test:* `test_register_flight_rejects_when_active_list_full` (seeds the list to
the cap and asserts the next distinct registration reverts with `#417`).

> **Deferred (documented):** the auditor's primary recommendation — individually-
> keyed active-flight records with a reverse index for O(1) swap-removal and
> paginated reads — is a storage-layout migration shared with the other
> monolithic-vector findings (OracleAggregator `ActiveFlightList` / AA-OA-02,
> Controller `TravelerFlights` / AA-CT-02, and Nemesis NM-006). It is not included
> here; the length cap makes the current design safe in the interim by preventing
> the entry from ever reaching the size limit.

---

## Files changed

Source (3): `flight_pool_manager/src/{constants,error,lifecycle}.rs`.
Tests (1): `flight_pool_manager/src/test.rs`.
