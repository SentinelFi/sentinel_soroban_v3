# Nethermind AuditAgent GovernanceModule Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_auditagent_ai_governance_module_report.md`](../20260704_auditagent_ai_governance_module_report.md)
**Audited commit:** `6b0db9e` (main)
**Remediation date:** 2026-07-10
**Test status:** full workspace suite green — **353 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-GM-01 | Medium | Confirmed | ✅ Fixed (index verified on every purchase-facing read; self-healing when archived) |
| AA-GM-02 | Medium | Confirmed | ✅ Fixed (removed flight_ids reserved for 160 days) |
| AA-GM-03 | Low | Confirmed | ✅ Fixed (later buyers transact at the first buyer's snapshotted terms) |
| AA-GM-04 | Low | Confirmed | ✅ Mitigated (route TTL 60 → 120 days); key-level TTL executor remains an ops item |
| AA-GM-05 | Low | Confirmed | ✅ Fixed (instance TTL renewed on route reads and mutations) |

---

## Fixed

### AA-GM-01 — Route and uniqueness-index archival can create conflicting active routes
**Confirmed (Medium).** The route record (`Route(flight_id, origin, dest)`) and
the uniqueness index (`FlightRoute(flight_id)`) are separate persistent keys
that can archive and be restored independently. If the index lapsed, a
conflicting route could be whitelisted for the same `flight_id`; if the old
route entry was then restored, `route_status` returned it as `Active` without
checking ownership — two physical routes sharing one downstream
`(flight_id, date)` namespace.

**Fix — verify on read, heal on divergence** (the report's recommendations
2–3, keeping the two-key layout):

- `route_status` now verifies the index before advertising a route: if the
  index maps the `flight_id` to a **different** origin/dest, the record is a
  stale duplicate and reports `Unknown` (not purchasable — the Controller
  rejects the buy cleanly); if the index is **absent** (archived), it is
  recreated from the live route entry, restoring the uniqueness guard. Since
  every purchase flows through `route_status`, the index can no longer
  silently diverge on any sellable route.
- `enable_route` applies the same discipline before returning a route to the
  purchasable set: it recreates a missing index or panics with
  `FlightIdAlreadyMapped` when another route has claimed the id.
- If two route entries do coexist after a divergence, exactly one — the index
  owner — is sellable; the loser is inert rather than colliding.

*Files:* `governance_module/src/{queries,routes}.rs`.
*Tests:* `test_route_status_rejects_route_when_index_points_elsewhere`,
`test_route_status_heals_missing_index`,
`test_enable_route_heals_missing_index_and_rejects_conflict` — covering the
independently-archived and independently-restored cases the report asks for.

### AA-GM-02 — Removed flight IDs can be reused while downstream state remains live
**Confirmed (Medium).** `remove_route` freed the `flight_id` immediately, so
governance could remap it to a different physical route while unresolved or
future-dated policies from the old route still lived in FlightPoolManager and
OracleAggregator — whose state carries no origin/dest. Matching terms would
merge two physical flights into one outcome record; differing terms would
deterministically revert new sales.

**Fix — retirement reservation** (the report's options 1 + 4): `remove_route`
now writes a `RetiredFlight(flight_id) → (origin, dest, retired_until)`
marker alongside freeing the index. `whitelist_route` rejects mapping the id
to a **different** origin/dest with `FlightIdRetired` until `retired_until`;
re-adding the identical route (undoing a removal) stays allowed, since
downstream state then belongs to the same physical route. The reservation is
`FLIGHT_ID_RETIREMENT_SECS` = 160 days — the 90-day booking horizon plus the
claim-expiry window and settlement slack, i.e. the longest lifetime any
policy sold under the old route can have. The marker's own TTL (168 days of
ledgers) outlives the deadline so archival cannot reopen the id early.

*Files:* `governance_module/src/{routes,storage,constants,error}.rs`.
*Tests:* `test_removed_flight_id_reserved_against_remapping` (blocked during
the window, allowed after), `test_removed_route_can_be_readded_during_retirement`;
the pre-existing `test_remove_route_frees_flight_id_mapping` was updated to
the new semantics (freed only after retirement).

### AA-GM-03 — Route term changes can deny later purchases for registered flights
**Confirmed (Low).** FlightPoolManager snapshots terms at the first
registration of a `(flight_id, date)` and rejects mismatched re-registration.
Because the Controller priced every buyer off the *current* governance terms,
any route/defaults change after the first purchase made all later purchases
of that date revert.

**Fix** (the report's "query that returns the already-registered terms"
option, implemented in the Controller): `buy_insurance` now reads the pool's
existing flight config first; if the `(flight_id, date)` is already
registered, the purchase is priced at the **snapshotted** premium/payoff/delay
instead of the current route terms. Governance term changes therefore apply
only to not-yet-registered flight dates, and every buyer of one physical
flight transacts at identical terms — arguably the correct economics as well
as the availability fix. The route must still be `Active` for the sale to
proceed, so disabling a route still halts sales immediately.

*Files:* `controller/src/purchase.rs`, `controller/src/interfaces.rs`.
*Test:* `test_second_buyer_transacts_at_snapshotted_terms_after_term_change` —
doubles the default premium after the first buy and proves the second buyer
succeeds while paying the original premium.

### AA-GM-05 — Active route operations do not preserve contract instance TTL
**Confirmed (Low).** Only owner-only admin functions renewed the instance
TTL; the purchase-facing `route_status` path and the route mutations did not,
so sustained traffic could keep route keys alive while the instance itself
(defaults, admin flags, ownership) drifted toward archival if the external
TTL cron failed.

**Fix:** `route_status` and all five route mutations (`whitelist_route`,
`disable_route`, `enable_route`, `remove_route`, `update_route_terms`) now
renew the instance TTL, exactly as the report recommends — ongoing use is now
sufficient to keep the contract alive, with the external extender retained as
defense in depth. (Read-only simulations don't persist the extension, so
frontend queries are unaffected.)

*Files:* `governance_module/src/{queries,routes}.rs`.

---

## Mitigated

### AA-GM-04 — Inactive persistent routes silently become unknown
**Confirmed (Low).** An approved route idle for the full TTL archives and
becomes indistinguishable from a never-whitelisted route (`Unknown`), halting
its sales until restored. Committed reads/writes renew the key, but the
production TTL executor currently extends contract instances only.

**Mitigations:**

- `ROUTE_TTL_LEDGERS` raised from 60 to **120 days** — route entries are tiny
  (rent negligible) and a doubled window makes archival require four months
  of zero committed traffic on the route.
- Every committed purchase attempt already renews the route and index keys
  (`route_status` read path), so any route with even occasional sales never
  approaches the window.
- A distinct "archived" status is not representable on-chain (a missing key
  reads identically to a never-written one), so the report's "distinct
  operational state" option is not implementable at the contract layer;
  off-chain indexers can distinguish via the `route_listed`/`route_removed`
  event history.

> **Deferred (operational, documented):** key-level TTL extension for
> approved routes in the off-chain TTL executor (folding `Route(...)` and
> `FlightRoute(...)` keys into its `ExtendFootprintTTLOp` footprint from the
> indexer's route enumeration) — already the documented plan in the code
> comments; the executor gap is an ops backlog item, not a contract change.

*Files:* `governance_module/src/constants.rs`.

---

## Files changed in this pass

Source: `governance_module/src/{routes,queries,storage,constants,error}.rs`
(AA-GM-01/02/04/05); `controller/src/{purchase,interfaces}.rs` (AA-GM-03).
Tests: `governance_module/src/test.rs`, `controller/src/test.rs`.
Docs: `spec/architecture.md` (function-reference notes for route removal and
term updates).
