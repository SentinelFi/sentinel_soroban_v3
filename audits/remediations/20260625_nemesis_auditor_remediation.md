# Nemesis AI Auditor Report — Remediation Summary

**Source report:** [`20260625_nemesis_auditor_report.md`](../20260625_nemesis_auditor_report.md)
**Remediation date:** 2026-07-01
**Scope:** 6 production contracts + `sentinel_types` (per the original report).
**Test status:** full workspace suite green after changes — **320 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

Each finding was first **validated against the source**, then either fixed or
documented-as-deferred with rationale. Three of the ten findings (NM-002,
NM-003, NM-006) are architectural and are deferred to dedicated, separately
reviewed changes — half-implementing them inline would risk a worse defect than
the one being closed (see rationale per finding).

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| NM-001 | High | Confirmed | ✅ Fixed (day-aligned policy identity) |
| NM-002 | High | Confirmed | 🟡 Deferred (architectural — vault accounting rewrite) |
| NM-003 | High | Confirmed | 🟡 Deferred (architectural — settlement-epoch redesign) |
| NM-004 | Medium | Confirmed | ✅ Fixed (aggregate-liability solvency check) |
| NM-005 | Medium | Confirmed | ✅ Fixed (batch sizes reduced below footprint limit) |
| NM-006 | Medium | Confirmed | 🟡 Deferred (architectural — storage sharding) |
| NM-007 | Medium | Confirmed | ✅ Fixed (index TTL synced + conditional removal) |
| NM-008 | Medium | Confirmed | ✅ Fixed (deadline-derived FlightData TTL) |
| NM-009 | Low | Confirmed | ✅ Fixed (reject empty booking interval) |
| NM-010 | Low | Confirmed | ✅ Fixed (invalid resolved terms → not Active) |

---

## Fixed

### NM-001 — Arbitrary timestamps create duplicate claims for one physical flight
**Confirmed (High).** `buy_insurance` accepted any `u64 date`, while the
off-chain executor resolves flights at calendar-day granularity (`dateToString`
→ `YYYY-MM-DD`). One physical flight could therefore be minted as many on-chain
policies — one per distinct intraday timestamp — each independently claimable
against the same real outcome, draining the vault.

**Fix:** `buy_insurance` now requires `date` to be **day-aligned** (a multiple
of `SECONDS_PER_DAY = 86_400`, i.e. midnight UTC); otherwise it reverts with
`Error::DateNotDayAligned`. This makes the on-chain identity `(flight_id, date)`
match the executor's day-level resolution, so a physical flight maps to exactly
one `(flight_id, day)` tuple. Combined with the existing per-traveler
single-policy guard in `add_buyer` (`Error::AlreadyBuyer`), a traveler is capped
at one policy per physical flight per day, and the duplication-drain vector is
closed. The governance `FlightRoute(flight_id)` uniqueness index already pins one
`(origin, dest)` per flight number, so `(flight_id, day)` is unambiguous.
*Files:* `controller/src/{constants,purchase,error}.rs`.
*Test:* `test_buy_insurance_panics_on_non_day_aligned_date`.

> **Interface note:** callers (frontend / executor) must now pass the flight's
> scheduled day at midnight UTC (`floor(ts / 86_400) * 86_400`). This enforces
> what the day-level executor already assumed.
>
> **Residual (recommended follow-up, not a drain vector):** this does not add a
> canonical oracle-attested flight registry, and there is still no refund path
> for a policy bought against a `(flight_id, day)` that never receives oracle
> data (collateral stays locked until manual owner action). The executor should
> also select the exact provider record by scheduled departure and reject
> ambiguous days with more than one departure for a flight number. These are
> defense-in-depth items for a future phase.

### NM-004 — Solvency ratio not enforced on aggregate liabilities
**Confirmed (Medium).** The check compared only the *new* payoff against free
capital (`free >= payoff * ratio / 100`). Because free capital already nets out
prior locks, a ratio above 100% eroded toward 100% as policies accumulated.

**Fix:** the gate now enforces the configured ratio against **aggregate**
liabilities: `tma >= ceil((locked_capital + new_payoff) * ratio / 100)`, using
checked arithmetic and rounding the requirement up so the reserve is never
under-provisioned by integer truncation. Collateral locking itself is unchanged
(still `payoff` per buy), so settlement decrements stay matched — only the
admission test is stricter. At the default/minimum ratio of 100 the behavior is
identical to before. Requires two reads (`get_total_managed_assets`,
`get_locked_capital`) added to the controller's vault client interface.
*Files:* `controller/src/{purchase,interfaces}.rs`.
*Test:* `solvency_ratio_enforced_on_aggregate_liabilities` (200% ratio, 1000
capital backs at most 500 of exposure; the 11th buy is rejected).

### NM-005 — Configured batches exceed transaction footprint limits
**Confirmed (Medium).** The bounded-scan constants added in the previous
remediation pass were too large for Soroban's 100-entry transaction footprint
once fixed contract-instance/invocation entries and cross-contract reads were
counted (`prune_settled` at batch 100 needed ~103 entries; `classify`/`settle`
touch oracle + pool state per flight). An oversized keeper call reverts without
advancing its cursor.

**Fix:** reduced the batch constants well below the measured limits:
- `controller::MAX_SETTLE_BATCH` 100 → **25** (each settled flight touches
  oracle `FlightData` + pool `FlightConfig` r/w plus vault/pool instance state,
  so the footprint is ~2× the batch plus overhead).
- `oracle_aggregator::MAX_PRUNE_BATCH` 100 → **60** (footprint ≈ inspected + a
  handful of fixed entries; 60 leaves comfortable headroom under the measured
  97-entry success boundary).

The rotating cursors still guarantee full coverage of the active list across
repeated keeper calls. `risk_vault::MAX_QUEUE_BATCH` (50) was left as-is: each
processed request touches one distinct `ClaimableBalance` persistent key plus
fixed instance entries, keeping its footprint under the limit.
*Files:* `controller/src/constants.rs`, `oracle_aggregator/src/constants.rs`.

> The exact safe maxima depend on the network's resource-limit model; these are
> conservative values and should be reconfirmed with resource-enforced tests
> before mainnet, as the report recommends.

### NM-007 — FlightRoute uniqueness index expires independently from live routes
**Confirmed (Medium).** `route_status` and the route mutations re-extended the
`Route(flight_id, origin, dest)` key but not the separate
`FlightRoute(flight_id)` uniqueness index. The index could archive while the
route stayed hot, after which a second `whitelist_route` saw no index and
accepted a conflicting `(origin, dest)` for the same flight number — colliding
downstream `(flight_id, date)` state. `remove_route` also deleted the index
unconditionally, which could strip a *newer* route's ownership.

**Fix:**
- Added `extend_route_index_ttl(flight_id)` (no-op if the index is absent) and
  call it alongside every route-key extension: in `route_status` (read path) and
  in `disable_route` / `enable_route` / `update_route_terms`. `whitelist_route`
  already writes + extends the index. The index now lives at least as long as the
  route it guards.
- `remove_route` now deletes `FlightRoute(flight_id)` **only when its stored
  `(origin, dest)` matches the route being removed**, so removing an older route
  can no longer reopen a flight number that a newer route owns.
*Files:* `governance_module/src/{storage,routes,queries}.rs`.

### NM-008 — FlightData can archive before a permitted long-dated flight
**Confirmed (Medium).** `register_flight` / lifecycle writes extended
`FlightData` by a flat ~31 days, but a flight may be insured up to 90 days before
departure. A long-dated record could archive before the oracle ever reported on
it, after which every lifecycle write panics (`"flight not registered"`),
blocking settlement and stranding collateral.

**Fix:** mirrored the pool's deadline-derived helper as
`oracle_aggregator::extend_flight_ttl_to(flight_id, date, deadline)`, sizing the
extension to cover the flight `date` plus a ~30-day settlement buffer (clamped to
the network max persistent TTL, floored at the prior 31-day extension). All
oracle lifecycle writes (`register_flight`, `set_estimated_arrival`,
`set_landed`, `set_cancelled`, `set_to_be_settled`) now use it with the flight
date as the deadline. Once the date is in the past the term floors to the flat
31 days — exactly right for a flight about to settle. This makes long-dated
records self-sufficient on-chain rather than dependent on a not-yet-implemented
key-level TTL cron. `set_settled` still does not extend (settled entries expire
naturally).
*Files:* `oracle_aggregator/src/{constants,storage,lifecycle}.rs`.

### NM-009 — Maximum minimum-lead setting creates an empty booking interval
**Confirmed (Low).** `min_lead_time` could equal `MAX_BOOK_AHEAD_SECS` (both 90
days). With `now + min_lead < date <= now + MAX_BOOK_AHEAD` the interval is empty,
so every purchase reverts while the configuration still looked valid.

**Fix:** `assert_min_lead_time` now rejects `seconds >= MAX_BOOK_AHEAD_SECS` with
a dedicated `Error::MinLeadTimeLeavesNoBookingWindow`, applied in both the
constructor and `set_min_lead_time`. The now-redundant `MAX_MIN_LEAD_TIME_SECS`
constant was removed in favor of comparing directly against the booking horizon.
*Files:* `controller/src/{constants,admin,error}.rs`.
*Tests:* `test_set_min_lead_time_equal_to_booking_horizon_panics`,
`test_set_min_lead_time_just_below_horizon_ok` (and the updated
`test_set_min_lead_time_above_max_panics`).

### NM-010 — Mutable defaults can leave an invalid route reported as active
**Confirmed (Low).** A partially-defaulted route valid at write time can resolve
to invalid economics (e.g. `payoff <= premium`) after a later `set_defaults`,
with no revalidation. The pool's registration guard already prevents fund loss,
but `route_status` kept reporting the route as `Active`, so the controller would
proceed into a downstream registration revert and the route looked sellable to
the frontend.

**Fix:** added a non-panicking `resolved_terms_valid()` check; `route_status`
now returns `RouteStatus::Disabled` (instead of `Active`) whenever an approved
route's resolved terms are economically invalid. The controller already handles
`Disabled` by rejecting the buy cleanly (`Error::RouteDisabled`). The
FlightPoolManager `payoff > premium` guard is retained as defense in depth.
*Files:* `governance_module/src/{storage,queries}.rs`.
*Test:* `test_route_status_disabled_when_defaults_make_terms_invalid`.

---

## Deferred / architectural (with rationale)

These three are confirmed real but require dedicated, separately reviewed changes
with their own invariant tests. They are intentionally **not** half-fixed here.

### NM-002 — Claimable withdrawal liabilities continue backing outstanding shares — 🟡 Deferred
**Validated as real** (also reported by Codex CAI/cosminmarian H-01/AuditAgent
AA-RV-01, with a working PoC). `process_withdrawal_queue` burns shares and
decrements `TotalManagedAssets` but leaves the owed tokens physically in the
vault as a `ClaimableBalance`. The OpenZeppelin `Vault` conversion math
(`convert_to_shares_with_rounding` / `convert_to_assets_with_rounding`) prices
shares off `Vault::total_assets()` = the vault's **physical token balance**,
which still includes those owed-but-uncollected funds — inflating NAV and
letting existing holders extract value from a later depositor.

**Why deferred:** verified against the `stellar-tokens` 0.7.1 source that the
conversion helpers call the inherent `Vault::total_assets`, **not** the
`FungibleVault` trait method — so overriding `total_assets()` on `RiskVault` does
**not** change deposit/mint/withdraw/redeem pricing (the same conclusion the
2026-05-31 CertiK VF-09 pass reached). A correct fix means either reimplementing
the full ERC-4626 conversion (rounding directions + decimals-offset inflation
protection) against a net-asset basis, or routing processed withdrawals into a
separate escrow whose balance is excluded from pricing. Both are high-risk vault
rewrites that must be their own reviewed change with dedicated
inflation/rounding/invariant tests; a partial inline attempt could reintroduce
an inflation-attack hole.
**Recommended fix:** track `TotalClaimableLiabilities` and price every
conversion on `net_assets = physical_balance − claimable_liabilities`, asserting
(via tests) that creating/collecting a claimable balance never moves the
exchange rate of unrelated shares.

### NM-003 — Public flight outcomes give LPs a free option before settlement — 🟡 Deferred
**Validated as real.** Oracle outcome publication, classification, and the
vault's financial settlement happen in separate, publicly observable
transactions. An informed LP can `redeem` at the pre-loss share price after a
`Cancelled`/`Landed` outcome is visible but before `execute_settlements` books
the loss, dumping it onto passive LPs (and the inverse for premium income).

**Why deferred:** the only robust remedies are architectural — settlement-epoch
vault accounting (queue deposits/withdrawals and finalize against a
post-settlement price), an outcome-reservation that books the pending loss when
the oracle first publishes it, or a withdrawal cooldown longer than the maximum
oracle-to-settlement interval. Each is a significant redesign of vault entry/exit
timing and interacts with NM-002's accounting fix; it should be designed and
reviewed alongside it, not bolted on.
**Recommended fix:** introduce settlement epochs (or immediate pending-loss
reservation on first public disclosure) so LP entry/exit prices are bound to the
risk period the shares actually underwrote.

### NM-006 — Monolithic vectors impose hard protocol/user capacity limits — 🟡 Deferred
**Validated as real.** `OracleAggregator::ActiveFlightList`,
`FlightPoolManager::ActiveFlightList`, and each `Controller::TravelerFlights`
are single Soroban values rewritten on every append; they hit the 65,536-byte
contract-data entry limit at ~1,600–1,640 entries, capping protocol-wide flight
registration and per-address purchases.

**Why deferred:** the NM-005 batch fix removes the *processing* DoS, but the
*storage-entry-size* ceiling needs the collections re-shaped into individually
keyed records / bounded pages with head-tail pointers and paginated reads —
across three contracts, touching registration, settlement, pruning, and the
read API. That is a storage-layout migration of its own, consistent with the
project's prior decision to defer unbounded-growth items of this class (CertiK
VF-11, `spec/audit.md` M-01). It should land as a focused, separately reviewed
refactor with resource-enforced boundary tests and a migration path for existing
entries.
**Recommended fix:** replace each monolithic vector with keyed entries
(`X(index)` + a count/cursor and a reverse index for O(1) swap-removal) and
paginated reads; derive historical views from events.

---

## Files changed

Source (10):
`controller/src/{constants,purchase,admin,error,interfaces}.rs`,
`oracle_aggregator/src/{constants,storage,lifecycle}.rs`,
`governance_module/src/{storage,routes,queries}.rs`.

Tests (5):
`controller/src/test.rs`,
`governance_module/src/test.rs`,
`integration_tests/src/tests/{setup,group2_capital,group3_withdrawal,group4_parallel,group7_governance}.rs`.
