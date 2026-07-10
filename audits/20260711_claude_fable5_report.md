# Claude Fable 5: Sentinel Soroban Findings Report

**Assessment date:** 11 July 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted Internal Security Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol |
| Network | Stellar |
| Smart contract platform | Soroban |
| Programming language | Rust |
| Repository | https://github.com/SentinelFi/sentinel_soroban_v3/tree/main |
| Branch | `main` |
| Commit | `708f4f2ea5f44dd5bc5792350afdfd6708aaf40a` |
| Snapshot date | 2026-07-11 |

---

## Executive Summary

This assessment reviewed all six Sentinel Protocol Soroban contracts in isolation and in composition (cross-contract calls, shared state, and trust assumptions between them), after first reviewing the architecture documents and all prior audit reports plus their remediation records. Findings already fixed, explicitly accepted, or deferred in prior rounds were excluded unless the underlying code or interaction materially changed.

The codebase is in strong shape. Authorization gates (`require_auth` plus stored-address checks), checked arithmetic (with `overflow-checks = true` in release), checks-effects-interactions ordering, the forward-only oracle state machine, TMA-basis share pricing, the aggregate solvency check, and the settlement barrier are all correctly implemented. Every money path traced (buy → lock → settle → claim/sweep; deposit → queue → collect) conserves funds. **No High-severity issues were found.**

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| CF5-M01 | Medium | "Archived entry reads as missing" model does not match Soroban's archival semantics | Designed failure/recovery paths are unreachable; keeper pipeline can halt differently than modeled |
| CF5-M02 | Medium | `evict_missing_flight` can permanently strand `PendingOutcomes`, freezing all vault entry/exit | Irreversible vault DoS reachable through a documented admin procedure |
| CF5-L01 | Low | Residual `flight_id` remapping windows when the governance uniqueness index diverges from route entries | Downstream bucket collision / legitimate route rendered unsellable |
| CF5-L02 | Low | Settlement-barrier liveness has no bounded fallback and its duration scales poorly | Vault entry/exit blocked for extended or indefinite windows |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 2 | 11 |

Informational items are listed under [General Improvements](#general-improvements): code quality, maintainability, and consistency suggestions with no direct security impact.

---

## Scope

### In Scope

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

Context reviewed prior to analysis:

- `spec/architecture.md`, `spec/simple_architecture.md`, `spec/learn_soroban.md`, `sequence_diagrams.md`
- All prior reports in `audits/` (2026-05-31, 2026-06-25, 2026-07-04 rounds) and `audits/remediations/`
- `spec/audit.md` internal findings register and status markers

### Out of Scope

- Unit-test files and test-only modules
- Mocks, including `contracts/mock_usdc` (testnet-only; permissionless mint previously accepted as C-03 / ASF-03)
- `contracts/integration_tests`, except as a test harness
- Fuzz targets
- Frontend and off-chain executor services (referenced only where contract behavior depends on keeper cadence)
- Deployment infrastructure and private operational systems
- Compromise of owner, administrator, keeper, controller, or oracle credentials

### Exclusions (previously accepted / deferred, verified unchanged)

The following known items were re-verified in code and excluded per the prior-audit record: capped monolithic instance-storage vectors and their capacity ceilings (active-flight lists, withdrawal queue, traveler index); lazy flight registration with tombstone / void / day-alignment mitigations; void-premium forfeiture; born-expired claim windows routed to `RecoveredBalance`; queue-active blocking of direct exits and strict-FIFO head blocking; dormant whitelist approval expiry; snapshot virtual-offset omission; single-key owner; `mock_usdc` permissionless mint behind the `testnet` feature.

---

# Detailed Findings

## CF5-M01 — "Archived entry reads as missing" model does not match Soroban's archival semantics

**Severity:** Medium
**Impact:** Designed failure/recovery paths are unreachable dead code; the keeper pipeline's real failure mode under archival differs from the modeled one
**Likelihood:** Certain (modeling mismatch), Low (triggering archival itself)
**Confidence:** High on the mismatch; the precise runtime behavior should be confirmed against the target protocol version

### Affected Components

- `contracts/oracle_aggregator/src/lifecycle.rs:758-787` (`prune_settled` missing-data branch)
- `contracts/oracle_aggregator/src/admin.rs:375-408` (`evict_missing_flight`)
- `contracts/oracle_aggregator/src/queries.rs` (`get_flight_data` fallback, `has_flight_data`)
- `contracts/controller/src/settle.rs` (`FlightConfigMissing` / `TtlMiss` skip paths, void guard via `has_flight_data`)
- `contracts/controller/src/purchase.rs:645-652` (buy gate on `get_flight_data` fallback)
- `contracts/governance_module/src/queries.rs:705-761` (`route_status` → `Unknown` for "archived" routes)
- `spec/learn_soroban.md` (documented mental model)

### Description

The code, its comments, the project's learning document, and all three prior audit rounds consistently assume that a TTL-expired **persistent** entry reads back as absent inside contract execution (`get → None`, `has → false`). That is not how Soroban treats persistent storage. An expired persistent entry is *archived*, not deleted. A transaction whose footprint touches an archived key never observes `None`:

- On current protocol (23+, hot archive), the entry is **automatically restored** with its original value when accessed, at additional fee.
- Under earlier archival semantics, the transaction **fails outright** at the footprint level until an explicit `RestoreFootprintOp` restores the entry.

In neither regime does contract code see a once-written key as missing. The Soroban SDK test environment panics on expired-entry access, which is why none of the archival-fallback branches is (or can be) exercised by the existing test suite — the `None`/`has == false` paths only fire for keys that were *never written*.

Consequences:

1. **Unreachable recovery machinery.** Much of the carefully designed archival handling is dead code as written: `prune_settled`'s `MissingFlightData` retention branch, `evict_missing_flight`'s `has() == false` precondition, the `FlightConfigMissing` skip paths in `classify_flights` / `execute_settlements`, the `has_flight_data` archived-vs-unregistered distinction, the controller's buy-gate `NotInitiated` fallback for archived oracle rows, and `route_status`'s "archived route reads `Unknown`" behavior.
2. **Different pipeline failure mode.** Under fail-until-restored semantics, a single expired `FlightData` or `FlightConfig` inside a keeper scan window makes the whole `classify_flights` / `execute_settlements` / `prune_settled` transaction fail rather than skip — the rotating cursor never advances past it, halting the settlement pipeline (and keeping the vault's settlement barrier engaged) until operations restores the entry. Under auto-restore semantics the pipeline self-heals at extra fee and the diagnostics never fire.
3. **Some modeled hazards cannot occur.** If archived entries *did* read as missing, two serious issues would exist that the current gates do not cover: a later `buy_insurance` would silently re-create an archived `FlightConfig` with `buyer_count = 0` (letting pre-archival buyers' claims — their `Buyer` keys still live — draw down funds backing other flights), and a buyer could purchase into a flight whose archived oracle row hides an already-public outcome. Under real archival semantics neither is reachable, but the buy path can cheaply harden against the entire class regardless (see below).

### Recommendation

- Empirically confirm archival behavior on the target protocol version (a testnet experiment with a deliberately expired persistent entry), then align code comments, the unreachable branches, the threat model, and the operations runbooks with the confirmed behavior.
- Ensure the executor handles restore preambles (`restorePreamble` from simulation) on keeper transactions so an archived entry in a scan window is restored rather than causing repeated keeper failures.
- Independent of the semantics outcome, add the cheap invariant to `buy_insurance`: if the pool already holds a `FlightConfig` for `(flight_id, date)`, require `oracle.has_flight_data(flight_id, date) == true` before admitting the purchase. This closes the archival-model-dependent late-buy window at the cost of one read.
- Add regression coverage using whatever archival simulation the SDK offers (or document explicitly that these branches are defense-in-depth for never-written keys only).

---

## CF5-M02 — `evict_missing_flight` can permanently strand `PendingOutcomes`, freezing all vault entry/exit

**Severity:** Medium
**Impact:** Irreversible denial of service on `deposit` / `mint` / `withdraw` / `redeem` / `process_withdrawal_queue`; recoverable only by emergency Wasm upgrade
**Likelihood:** Low (requires a multi-layer operational failure followed by a documented admin action)
**Confidence:** High (under the codebase's own archival model; see CF5-M01 for the semantics dependency)

### Affected Components

- `contracts/oracle_aggregator/src/admin.rs:375-408` (`evict_missing_flight`)
- `contracts/oracle_aggregator/src/storage.rs:120-142` (`increment_pending_outcomes` / `decrement_pending_outcomes`)
- `contracts/oracle_aggregator/src/lifecycle.rs:593-630` (`register_flight` idempotent no-op does not re-add to the active list)
- `contracts/risk_vault/src/auth.rs:22-41` (`settlement_pending` gate)

### Description

`PendingOutcomes` is incremented when an outcome first becomes public (`set_landed`, the registered-flight branch of `set_cancelled`, or the `NotInitiated` void path of `set_to_be_settled`) and decremented in exactly one place: `set_settled`. The vault blocks all entry/exit while the counter is non-zero.

If a flight whose outcome was already counted becomes unresolvable (its `FlightData` unavailable per whichever archival regime applies) and the owner frees its active-list slot with `evict_missing_flight`, the counter is never decremented — and there is no repair path:

- `set_settled` requires a valid `ToBeSettled* → Settled` transition on live data;
- the keeper loops only enumerate the oracle's active list, from which the flight has just been removed;
- `register_flight` no-ops on an existing key **without re-adding it to the active list**, so even restoring the archived entry afterwards can never re-enter the settlement pipeline.

`has_pending_outcomes()` then remains `true` forever. The vault's `deposit`, `mint`, `withdraw`, `redeem`, and `process_withdrawal_queue` are all blocked indefinitely; the only remaining exit for LPs is nothing at all, and the only recovery is an emergency contract upgrade.

The two mechanisms interacting here — the settlement barrier (NM-001, 2026-07-04 round) and the retain-and-evict flow (AA-OA-02, same round) — landed in the same remediation pass, and their interaction does not appear in any prior report. The prerequisites are heavy (roughly 120+ days of combined keeper and TTL-cron failure, followed by the owner invoking the eviction procedure the function's own documentation suggests for exactly this scenario), but the resulting state is a protocol-freezing dead end reached through a documented admin runbook step.

### Exploit / Failure Scenario

1. A flight reaches `Landed`, `Cancelled`, or `ToBeSettled*` — `PendingOutcomes` is incremented.
2. Settlement stalls long enough (keeper outage plus TTL-cron failure exceeding the 90-day settlement grace plus buffer) that the flight's `FlightData` archives.
3. The keeper pipeline can no longer resolve the flight; `prune_settled` emits `MissingFlightData` and retains the entry.
4. The owner, following the documented capacity-release procedure, calls `evict_missing_flight`.
5. The eviction succeeds; `PendingOutcomes` remains ≥ 1 with no decrement path.
6. All vault entry/exit is blocked permanently; queued withdrawal requests can never be priced or drained.

### Recommendation

Make the eviction path unable to orphan a counted outcome:

- persist per-flight "counted toward `PendingOutcomes`" state somewhere that survives the data entry (e.g. an instance-side set keyed by `(flight_id, date)`), and have `evict_missing_flight` decrement (or refuse) accordingly; or
- add an owner-gated, event-logged counter reconciliation entry point as an explicit break-glass tool; or
- allow restore-then-re-register to re-enter the active list so the normal settle path can complete and decrement.

Whichever direction is chosen, document in the runbook that a pending-state flight must be restored and settled, never evicted.

---

## CF5-L01 — Residual `flight_id` remapping windows when the governance uniqueness index diverges from route entries

**Severity:** Low
**Impact:** Downstream `(flight_id, date)` bucket collision (terms-mismatch bricking at best, bucket merging at worst); a legitimate route can be rendered `Unknown` by a permissionless caller
**Likelihood:** Low (requires the `FlightRoute` index to lapse independently of route entries despite the lockstep-extension design)
**Confidence:** High

### Affected Components

- `contracts/governance_module/src/routes.rs:571-626` (`remove_route`)
- `contracts/governance_module/src/queries.rs:722-735` (`route_status` index self-heal)
- `contracts/governance_module/src/storage.rs:117-132` (`extend_route_index_ttl`)

### Description

Two residuals of the AA-GM-01 / AA-GM-02 (2026-07-04) fixes, both requiring the `FlightRoute(flight_id)` uniqueness index to archive independently of the route entries it guards:

1. **Missing retirement marker.** `remove_route` writes the `RetiredFlight` reservation only when the index is present *and* points at the route being removed. If the index has lapsed, removing the sole route for a `flight_id` leaves no retirement marker, so the id can immediately be re-whitelisted with a different origin/destination while downstream `(flight_id, date)` state from the old route may still be live (policies book up to 90 days ahead with a claim window after settlement). Later purchases of the new route land in the old route's buckets — the pool's terms-mismatch guard bricks sales for those dates in the best case, and silently merges buyer populations if the resolved terms happen to match.

2. **Self-heal can resurrect a stale owner.** `route_status` recreates a missing index from whichever route entry is read first — including a stale or disabled duplicate — and the write is committed by *any* caller on a committing transaction. After repeated index lapses this can hand `flight_id` ownership back to a stale entry, turning the newer legitimate route `Unknown` (unsellable) until an admin disables and removes the stale record.

Both are edge residuals: the index and route entries are extended in lockstep on every touch, so divergence implies the off-chain TTL cron also failed. Note that under confirmed archival semantics (CF5-M01), index "absence" may not be observable at all, in which case both windows close on their own — this finding is contingent on the same semantics question.

### Recommendation

- In `remove_route`, write the retirement marker unconditionally whenever the removed route was ever approved, rather than only when it currently owns the index.
- In `route_status`, only self-heal the index from an entry with `approved == true`.
- Resolve jointly with CF5-M01: if archived entries auto-restore, document these branches as never-written-key defense only.

---

## CF5-L02 — Settlement-barrier liveness has no bounded fallback and its duration scales poorly

**Severity:** Low
**Impact:** Vault deposits, direct exits, and queue pricing blocked for extended — potentially indefinite — windows; capital inflow stalls at scale
**Likelihood:** Medium at meaningful flight volume; Low for the indefinite variants
**Confidence:** High

### Affected Components

- `contracts/risk_vault/src/auth.rs:22-41` (`settlement_pending` / `assert_no_settlement_pending`)
- `contracts/oracle_aggregator/src/storage.rs` (`PendingOutcomes`)
- `contracts/controller/src/settle.rs` (`classify_flights` / `execute_settlements`, `MAX_SETTLE_BATCH = 25`)
- Pause gates on `flight_pool_manager::settle_*` and `oracle_aggregator::set_to_be_settled`

### Description

The settlement barrier is a deliberate, previously audited trade-off (NM-001, 2026-07-04): while any flight outcome is public but unsettled, all vault entry/exit reverts. Three interaction effects deserve flagging as a group:

1. **No bounded fallback.** A single unsettleable flight — pool config unavailable, pool or oracle paused, keeper stalled — keeps the barrier on indefinitely. Every recovery path is operational; none is on-chain or time-bounded. (CF5-M02 is the irreversible extreme of this family.)
2. **Duration scales with cadence × batch size.** Classification processes at most `MAX_SETTLE_BATCH = 25` entries per call against an active list capped at 1,000. At the documented hourly classifier cadence, a day's clustered landings can keep the barrier engaged for many hours — potentially most of the time at sustained volume — making the withdrawal queue the only LP path and stalling deposits. The contracts permit arbitrary keeper cadence; this is an executor-configuration requirement that should be stated as an operational invariant, not left implicit.
3. **Partial pause pins the barrier.** Pausing the pool or the oracle alone makes the keeper loops revert wholesale (`settle_*` / `set_to_be_settled` are pause-gated and called cross-contract), which also keeps the barrier engaged. Pause and unpause must be operated as a set across contracts.

### Recommendation

- Document required keeper cadence as a function of active-flight volume (e.g. classify at the same 5-minute cadence as settlement under load).
- Consider an owner-gated, event-logged barrier override or per-flight exemption for stuck entries, designed together with the CF5-M02 counter fix.
- Document the pause-set requirement in the incident runbook.

---

# General Improvements

Non-security suggestions; no severity ranking.

1. **Controller event topics are indistinguishable.** `InsuranceBought`, `FlightClassified`, and `FlightSettledEvent` all publish under `["sentinel", "ctrl"]` (`contracts/controller/src/events.rs`), unlike every other contract's distinct-verb scheme. Indexers must decode payloads to tell them apart; use distinct second topics (`bought`, `classified`, `settled`).
2. **`TotalPayoutsDistributed` semantics.** The counter accumulates `payoff × buyer_count`, which includes the premium portion already held by the pool; the name implies vault outflow (`(payoff − premium) × count`). Document the definition or track both figures.
3. **Inconsistent error surface.** `cancel_withdrawal` fails via `expect("request_id not found")` and the governance route lifecycle via `expect("route not whitelisted")`, while sibling paths use typed `contracterror` codes. Clients get an opaque host panic instead of a decodable error; unify on typed errors.
4. **Duplicated TTL machinery.** `extend_flight_ttl_to`, `LEDGERS_PER_SECOND_*`, `TTL_BUFFER_LEDGERS`, and `MAX_PERSISTENT_TTL_LEDGERS` are copy-mirrored in `flight_pool_manager` and `oracle_aggregator`. They belong in `sentinel_types::ttl` next to the instance constants — the comment "mirrors the pool's" is exactly the drift hazard that crate exists to remove.
5. **Snapshot cadence drift.** The gate `now < last + 86_400` combined with key `now / 86_400` lets the snapshot time creep forward and skip calendar days in the daily series; gate on day-number change instead. Also consider skipping snapshots while `settlement_pending` — the recorded NAV includes unrecognized PnL.
6. **`collect()` does not extend instance TTL** while every sibling user path does — a minor consistency gap in the self-healing-TTL discipline.
7. **`get_flights_by_status` is unbounded.** One persistent read per active-list entry with no bound — fine as a simulation-only view, but that constraint deserves a doc comment so nothing on-chain ever calls it.
8. **Magic number.** The `3600` in `classify_flights`' delay computation should be a named `SECONDS_PER_HOUR` alongside the existing named constants.
9. **Per-iteration TMA writes.** `process_withdrawal_queue` persists `TotalManagedAssets` on every drained request so the storage-reading conversion helper stays consistent. Passing a running TMA into a parameterized helper would keep the lockstep pricing with a single final write.
10. **Misleading validation error.** `set_min_withdrawal_request` rejects negative input with `AmountMustBePositive` although zero is a valid "disable" value — a dedicated error (or `AmountMustBeNonNegative`) would be clearer.
11. **Pause-exemption asymmetry.** Vault `recover_uncollected` is deliberately pause-exempt (documented) while the analogous pool `withdraw_recovered` is pause-gated. Either align them or document why owner recovery differs per contract.

---

# Conclusion

Three rounds of prior audits and remediations have left the Sentinel contracts with correct authorization, conservation, and state-machine properties on every path traced; this assessment found no High-severity issues and no new fund-loss path.

The most consequential result is systemic rather than local: the protocol's archival threat model — "expired persistent entries read as missing" — does not match Soroban's actual archival semantics, which means a body of recovery and diagnostic code is unreachable as written and the true failure mode under archival differs from the one designed for (CF5-M01). Confirming the target protocol's behavior and realigning code, tests, and runbooks should be done before mainnet. The one concrete state-level defect (CF5-M02) sits at the intersection of two fixes from the same prior round and should be closed with a counter-safe eviction path. The remaining findings are low-likelihood residuals and operational-liveness couplings best addressed through small guards and runbook documentation.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, economic risks, or integration failures. The runtime behavior of archived persistent entries (CF5-M01) was assessed from protocol documentation and SDK behavior, not from a live-network experiment; the recommended testnet confirmation should be performed before acting on dependent findings.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of these assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

This assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial or investment advice;
- compliance certification;
- a substitute for professional security auditing services.
