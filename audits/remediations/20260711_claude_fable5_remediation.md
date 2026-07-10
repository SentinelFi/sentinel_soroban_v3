# Claude Fable 5 Findings Report (2026-07-11) — Remediation Summary

**Source report:** [`20260711_claude_fable5_report.md`](../20260711_claude_fable5_report.md)
**Audited commit:** `708f4f2` (main)
**Remediation date:** 2026-07-11
**Test status:** full workspace suite green — **370 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CF5-M01 | Medium | Confirmed | ✅ Purchase-path guard added + model documented; testnet archival experiment and executor restore-preamble handling remain ops backlog |
| CF5-M02 | Medium | Confirmed | ✅ Fixed (eviction releases the flight's pending-outcome count via an owner-asserted flag) |
| CF5-L01 | Low | Confirmed (part 1) / Partially — by design (part 2) | ✅ Retirement marker now written when the index has lapsed; index self-heal kept as designed, limitation documented |
| CF5-L02 | Low | Confirmed | ✅ Documented (keeper-cadence invariant + pause-set procedure); on-chain barrier override deliberately not adopted |

General improvements: 8 of 11 fixed in code, 3 addressed via documentation — see the table at the end.

---

## Fixed

### CF5-M01 — Archival-semantics model mismatch
**Confirmed (Medium).** The contracts (and prior rounds) modeled a TTL-expired
persistent entry as reading back as absent (`get → None`, `has → false`). On
Soroban an expired persistent entry is *archived*, not deleted: depending on
protocol version, a transaction touching it either fails until restored or
auto-restores the original value — contract code never observes `None` for a
once-written key. The `None`/`has == false` fallbacks therefore only fire for
never-written keys, and several recovery/diagnostic branches are unreachable
for genuinely archived entries.

**Fix — hardening + model realignment:**

- `buy_insurance` now enforces the pool/oracle pairing invariant directly: if
  a `FlightConfig` already exists for `(flight_id, date)` but the oracle has
  no physical `FlightData` row, the purchase reverts with the new
  `OracleDataUnavailable` error instead of treating the flight as
  `NotInitiated`. A registered bucket whose oracle row is unobservable might
  be hiding an already-public outcome; selling into it would hand the buyer a
  guaranteed claim. This closes the late-buy window under *any* archival
  semantics, at the cost of one read on the already-registered path.
- `spec/learn_soroban.md` gained a "What contract code actually observes for
  an archived entry" section describing both archival regimes, stating that
  reads-as-missing must not be relied on, reframing the existing fallback
  branches as defense-in-depth for never-written keys, and listing the
  operational consequences (restoration is the recovery tool; the executor
  must handle `restorePreamble` on keeper transactions).

> **Remaining (ops backlog, not contract changes):** run the recommended
> testnet experiment with a deliberately-expired persistent entry against the
> target protocol version and record the observed behavior; add
> restore-preamble handling to the executor's keeper transaction submission.

*Files:* `controller/src/{purchase,error}.rs`, `spec/learn_soroban.md`.
*Tests:* the guard's precondition (pool config present, oracle row physically
absent) cannot be constructed through public entry points, and the SDK test
environment panics on expired-entry access — consistent with the finding's
own analysis, the branch is defense-in-depth verified by review.

### CF5-M02 — `evict_missing_flight` can permanently strand `PendingOutcomes`
**Confirmed (Medium).** `PendingOutcomes` (the vault's settlement-barrier
counter) is decremented only by `set_settled`. Evicting a flight whose
outcome had already been counted removed it from keeper enumeration with the
count still standing — and since `register_flight` is a no-op for an existing
key (it does not re-add to the active list), even restoring the data could
never re-enter the settlement pipeline. The barrier would stay engaged
forever; only a Wasm upgrade could repair the counter.

**Fix — eviction releases the count (report's option: owner-asserted flag):**

- `evict_missing_flight(flight_id, date, outcome_pending)` — the owner, who
  already reconstructs the flight's history from its status-change events
  before evicting, asserts whether the flight's outcome had been publicly
  recorded (Landed / Cancelled / ToBeSettled\*). When `true`, the eviction
  decrements `PendingOutcomes`, releasing the count settlement would have
  released; eviction is the flight's terminal transition either way.
- The `FlightEvicted` audit event carries the flag so indexers can reconcile
  the pending-outcome series, and the doc comment states that
  restore-and-settle is always the preferred path — eviction is the terminal
  escape hatch.
- Runbook guidance added to `spec/architecture.md` (function reference +
  known limitations): getting the flag wrong either strands the barrier or
  opens it early — both directions are owner judgment calls, recorded
  on-chain.

*Files:* `oracle_aggregator/src/{admin,events}.rs`, `spec/architecture.md`.
*Tests:* `test_evict_missing_flight_releases_pending_outcome` (new);
`test_evict_missing_flight_owner_path` extended to assert the counter is
untouched for a never-counted flight.

### CF5-L01 (part 1) — `remove_route` skips the retirement marker when the index lapsed
**Confirmed (Low).** The `RetiredFlight` reservation was written only when
the uniqueness index was present *and* pointed at the route being removed. If
the index had archived, removing the sole route for a `flight_id` left no
marker, so the id could immediately be re-whitelisted with a different
origin/destination while downstream `(flight_id, date)` policies from the old
route could still be live.

**Fix:** `remove_route` now treats an *absent* index as "this route was the
last known owner" and writes the retirement marker in that case too. The only
case that skips the marker is an index pointing at a *different* route — the
flight_id has since been claimed elsewhere, and reserving it here would block
the legitimate current owner (that owner's own removal writes its own
marker).

*Files:* `governance_module/src/routes.rs`.
*Tests:* `test_remove_route_reserves_flight_id_even_when_index_lapsed`,
`test_remove_stale_route_leaves_current_owner_unaffected` (both new).

---

## Partially adopted / documented

### CF5-L01 (part 2) — `route_status` self-heal can resurrect a stale owner
**By design; limitation documented.** The report recommended healing the
lapsed index only from `approved == true` entries. Not adopted, for two
reasons discovered in remediation:

1. Healing from a **disabled** route is deliberate, existing behavior (covered
   by `test_route_status_heals_missing_index_for_disabled_route`): a disabled
   route still owns its flight_id while paused, and the healed index is what
   prevents a conflicting route from claiming the id in the meantime.
2. The guard would not close the actual hazard: a stale duplicate left behind
   by a conflicting whitelist (possible only after a prior index lapse)
   remains `approved`, so it would pass an approval check anyway.

There is no local signal that distinguishes the legitimate owner from a stale
duplicate once the index is lost; prevention is the lockstep index/route TTL
extension already in place. The first-reader-wins semantics and its recovery
path (admin disables and removes the stale entry) are now documented at the
self-heal site in `governance_module/src/queries.rs`.

### CF5-L02 — Settlement-barrier liveness and cadence coupling
**Confirmed (Low); documented, override not adopted.**

- **Keeper-cadence invariant documented** (`spec/architecture.md`, Known
  Limitations): classification processes at most 25 flights per call, so at
  volume an hourly classifier keeps the barrier engaged for hours; under load
  the classifier must run at the same 5-minute cadence as the settler. The
  contracts accept any cadence; batch caps bound per-call cost.
- **Pause-set procedure documented** (`spec/architecture.md`, Emergency
  Stop): the keeper loops call pause-gated entry points cross-contract, so
  pausing the pool or oracle alone halts settlement wholesale and pins the
  barrier — pause and unpause all five contracts together.
- **On-chain barrier override — considered, not adopted:** a time-bound or
  owner-gated bypass would reintroduce exactly the stale-price LP entry/exit
  the barrier exists to prevent, on an operator's clock. The terminal escape
  hatch for a stuck flight is the CF5-M02 eviction path (which releases the
  flight's count after the owner confirms finality off-chain); everything
  short of that is restore-and-settle.

---

## General improvements

| # | Item | Status |
|---|------|--------|
| 1 | Controller event topics indistinguishable | ✅ Fixed — distinct verbs `bought` / `classified` / `settled` (was `ctrl` ×3); architecture doc + integration assertions updated. Indexer note: topic filters must be updated with this deploy |
| 2 | `TotalPayoutsDistributed` semantics | ✅ Documented — key comment + `get_stats` doc state it is gross claimable value (payoff × buyer_count), not vault outflow |
| 3 | Untyped `expect` panics | ✅ Fixed — `GovernanceModule` route lookups panic with `RouteNotFound` (#511); `cancel_withdrawal` with `RequestNotFound` (#721) |
| 4 | Duplicated TTL machinery | ✅ Fixed — flat/deadline TTL constants + `deadline_extension_ledgers` moved to `sentinel_types::ttl`; pool and oracle both consume the shared helper |
| 5 | Snapshot cadence drift | ✅ Fixed — once-per-day gate now compares calendar-day numbers (the storage key) instead of a rolling 24 h window; snapshots are also skipped while an outcome is pending so no NAV with unrecognized PnL is published |
| 6 | `collect()` missing instance-TTL renewal | ✅ Fixed — renews instance TTL like every other user path |
| 7 | `get_flights_by_status` unbounded | ✅ Documented — doc comment marks it off-chain/simulation-only; on-chain callers must use the bounded keeper batches |
| 8 | Magic `3600` in classify | ✅ Fixed — named `SECONDS_PER_HOUR` constant |
| 9 | Per-iteration TMA writes in queue drain | ✅ Fixed — requests priced via `convert_to_assets_with_tma` against a locally tracked running total (identical values; share supply is read live as burns update it); TMA persisted once after the loop |
| 10 | Misleading negative-input error | ✅ Fixed — `set_min_withdrawal_request` rejects negatives with `AmountMustBeNonNegative` (#722); zero remains the valid "disable" value |
| 11 | Pause-exemption asymmetry | ✅ Documented — `withdraw_recovered` doc explains why it is pause-gated (protocol revenue, no third party waiting) while the vault's `recover_uncollected` is pause-exempt (settles user-owed credits) |

---

## Interface changes in this pass

- `oracle_aggregator::evict_missing_flight` gained a third parameter
  `outcome_pending: bool`.
- `oracle_aggregator::FlightEvicted` event gained an `outcome_pending` field.
- Controller domain-event topics changed: `("sentinel", "ctrl")` →
  `("sentinel", "bought" | "classified" | "settled")`.
- New typed errors: controller `OracleDataUnavailable` (315), governance
  `RouteNotFound` (511), vault `RequestNotFound` (721) and
  `AmountMustBeNonNegative` (722). Callers previously matching host-panic
  strings (`"route not whitelisted"`, `"request_id not found"`) must match
  the error codes instead.

## Test suite

- New: `test_evict_missing_flight_releases_pending_outcome` (oracle),
  `test_remove_route_reserves_flight_id_even_when_index_lapsed` and
  `test_remove_stale_route_leaves_current_owner_unaffected` (governance),
  `test_snapshot_records_each_calendar_day` (vault),
  `snapshot_skipped_while_outcome_pending` (integration, group 2).
- Updated: evict call sites for the new signature; `should_panic`
  expectations moved to typed error codes; group 8 event-chain assertions
  updated to the new controller topics.
