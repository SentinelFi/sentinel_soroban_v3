# cosminmarian53 Soroban Auditor Report — Remediation Summary

**Source report:** [`20260625_cosminmarian53_soroban_auditor_report.md`](../20260625_cosminmarian53_soroban_auditor_report.md)
**Remediation date:** 2026-07-01
**Scope:** 6 production contracts + `sentinel_types` (per the original report).
**Test status:** full workspace suite green after changes — **321 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

This report overlaps substantially with the Nemesis assessment of the same
commit. Three findings were already resolved in that pass and are cross-
referenced below; one (**M-01**) is new and is fixed here; one (**H-01**) and
the queue-capacity lead remain architectural deferrals.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| H-01 | High | Confirmed | 🟡 Deferred (architectural — vault accounting rewrite) |
| M-01 | Medium | Confirmed | ✅ Fixed (controller records premium income directly) |
| M-02 | Medium | Confirmed | ✅ Already fixed (route index TTL synced) |
| M-03 | Medium | Confirmed | ✅ Already fixed (aggregate-liability solvency check) |
| Lead | — | Confirmed | 🟡 Deferred (architectural — queue storage sharding) |

---

## Fixed in this pass

### M-01 — Missing nested authorization prevents on-time settlement
**Confirmed (Medium).** During on-time settlement the Controller invoked
`FlightPoolManager::settle_on_time`, which transferred the held premiums to the
vault and then itself called the vault's controller-only
`record_premium_income`, passing the Controller's address. Soroban does **not**
propagate the Controller's authorization to a sub-invocation the *pool*
initiates — the Controller is not the direct caller of that vault call and never
constructed an explicit auth entry for it. In production this means every
on-time flight **with at least one buyer** reverts at settlement, leaving
premiums stuck in the pool and collateral locked. The existing tests masked it
by enabling non-root contract-auth mocking
(`mock_all_auths_allowing_non_root_auth`).

**Fix (the report's preferred restructure — each contract authorizes only its
direct caller):**
- `FlightPoolManager::settle_on_time` now **transfers the premiums and returns
  the transferred total** (`-> i128`); it no longer calls the vault. (A contract
  is implicitly authorized to move its own token balance, so the pool→vault
  *transfer* is fine; only the controller-gated *accounting* call was the
  problem.)
- `Controller::execute_settlements` captures that return value and calls
  `RiskVault::record_premium_income(controller, premium_income)` **directly**, so
  the Controller is the direct, authorizing caller the vault's
  `require_controller` check expects.

Because this removes the only place a non-root **contract** authorization was
required anywhere in the system, the entire test suite was switched from
`mock_all_auths_allowing_non_root_auth()` to plain **`mock_all_auths()`**. The
suite — including end-to-end on-time settlement — passing under root-frame-only
auth is the proof the production auth path is now correct, exactly the
no-`mock_all_auths`-style coverage the report asked for.
*Files:* `flight_pool_manager/src/settle.rs`,
`controller/src/{settle,interfaces}.rs`,
test setups in `controller/src/test.rs`,
`integration_tests/src/tests/{setup,group2_capital}.rs`.
*Tests:* `on_time_settlement_records_premium_income_via_controller` (group 6,
asserts premium income is credited to the vault and collateral released under
plain auth); updated `flight_pool_manager::test_settle_on_time_with_buyers_*`
(settle returns the transferred total and moves the premium to the vault without
itself touching TMA); the whole suite now runs without non-root contract-auth
mocking.

---

## Already fixed (Nemesis pass on the same commit)

### M-02 — Route uniqueness index expires independently from the active route
**= Nemesis NM-007.** Already remediated in
[`20260625_nemesis_auditor_remediation.md`](20260625_nemesis_auditor_remediation.md):
`route_status` and every route mutation now refresh the `FlightRoute(flight_id)`
index TTL in lockstep with the route key, and `remove_route` deletes the index
only when its stored `(origin, dest)` matches the route being removed (so it
can't strip a newer route's ownership). No further change required.

### M-03 — Solvency ratio not enforced across aggregate liabilities
**= Nemesis NM-004.** Already remediated: `buy_insurance` now requires
`total_managed_assets >= ceil((locked_capital + new_payoff) * ratio / 100)` with
checked arithmetic and upward rounding, holding the configured margin across the
whole book rather than against the newest payoff alone. Covered by
`solvency_ratio_enforced_on_aggregate_liabilities`. No further change required.

---

## Deferred / architectural (with rationale)

### H-01 — Claimable liabilities inflate remaining shares (theft from later depositors) — 🟡 Deferred
**= Nemesis NM-002 / AuditAgent AA-RV-01.** Validated as real, with the same
dynamically-reproduced PoC. `process_withdrawal_queue` burns shares and
decrements `TotalManagedAssets` but leaves the owed tokens physically in the
vault as a `ClaimableBalance`; the OpenZeppelin `Vault` conversion math prices
shares off the vault's **physical token balance** (verified against
`stellar-tokens` 0.7.1 — the conversion helpers call the inherent
`Vault::total_assets`, not the overridable trait method), so owed-but-
uncollected funds inflate NAV and let existing holders extract value from a
later depositor.

**Why deferred:** a correct fix requires either reimplementing the full ERC-4626
conversion against a net-asset basis
(`net_assets = physical_balance − total_claimable_liabilities`) or routing
processed withdrawals into a separate escrow excluded from pricing — both
high-risk vault-accounting rewrites that must be their own reviewed change with
dedicated inflation/rounding/invariant tests. A partial inline attempt could
reintroduce an inflation-attack hole. Tracked with the full rationale in the
Nemesis remediation (NM-002).

### Lead — Withdrawal queue can grow beyond effective batching — 🟡 Deferred
**Same class as Nemesis NM-006 / AuditAgent AA-RV-03.** `process_withdrawal_queue`
caps work at 50 requests per call but still loads and rewrites the entire
`WithdrawalQueue` vector, which shares the single contract-instance entry and is
therefore bounded by Soroban's 65,536-byte limit (~385 requests in the assessed
configuration). The report itself downgraded this to a lead because no concrete
on-chain failure threshold was demonstrated and every request requires owned,
positive-value shares.

**Why deferred:** the robust fix is to replace the monolithic queue with
individually-keyed requests plus head/tail pointers (so processing advances a
bounded prefix without rewriting unrelated entries) and a per-address active-
request cap — a storage-layout migration that belongs with the broader
monolithic-vector sharding work (NM-006), not a point patch. The existing
`MAX_QUEUE_BATCH` bound already prevents the per-call processing cost from
growing unbounded.

---

## Note on the report's rejected candidates

The report's own "rejected/lead" section flagged a **FlightData TTL vs.
long-horizon settlement** mismatch as out of scope (deferred executor concern).
That mismatch was independently fixed in the Nemesis pass (NM-008): the oracle
now extends `FlightData` TTL to cover the flight date plus a settlement buffer,
so a long-dated record no longer archives before the oracle reports on it.

---

## Files changed

Source (3):
`flight_pool_manager/src/settle.rs`,
`controller/src/{settle,interfaces}.rs`.

Tests (4):
`flight_pool_manager/src/test.rs`,
`controller/src/test.rs`,
`integration_tests/src/tests/{setup,group2_capital,group6_authorization}.rs`.
