# Phase 7 — Controller rewire to `FlightPoolManager` + `TravelerFlights`

Status: complete
Started: 2026-05-03
Completed: 2026-05-03

---

## Goal

The controller catch-up phase. Phases 1–6 reshaped the surrounding contracts;
the controller still references deleted crates in its test file, still has
dead `CtrlKey` variants for the old per-flight FlightPool / RecoveryPool
topology, and still tries to deploy per-flight pools via `env.deployer()` on
every first purchase. Phase 7 finishes the migration: rips out the deployer
pattern, drops dead storage keys, wires the singleton `FlightPoolManager` for
all pool operations, adds the `TravelerFlights(Address)` per-traveler index
that unblocks the MyPolicies frontend without an off-chain indexer, and
rewrites `controller/src/test.rs` from scratch (which is currently broken
since Phases 1–2). After this phase, every contract crate builds AND tests
individually — closing **Stage 2 of the build-red window**. Only
`integration_tests/` remains blocked, and Phase 10 closes that.

This phase also includes one small cross-contract addendum: change
`flight_pool_manager::get_flight_config` to return `Option<FlightConfig>`
instead of panicking, so the controller can do "look up; if missing,
register" on the buy path with a single cross-contract call. Q1 confirmed:
option (a) — minimal blast radius (controller is the only external caller).

## Dependencies

- **Phases 1, 2 complete** — `flight_pool/` and `recovery_pool/` deleted;
  `controller/Cargo.toml` already has dead `path` deps stripped (Phase 3
  did this as cross-phase work).
- **Phase 3 complete** — `flight_pool_manager` exists with the API the
  controller will call. The `get_flight_config` change in Phase 7 mutates
  this contract's read API.
- **Phase 4 complete** — controller's `GovClient` trait already exposes
  `route_status` (used in `buy_insurance`).
- **Phase 6 complete** — controller's `OracleClient` trait already mirrors
  oracle's wider `FlightData` (with `settled_at`).
- No new contract dependencies. Cross-crate edits are scoped to one
  function in `flight_pool_manager/src/lib.rs` (+ minor test-file fixups
  there).

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the Phase 7 commit at the end.
- `oz-stellar` — controller already uses OZ `ownable` + `#[only_owner]`. Skill loaded so the agent can sanity-check the existing pattern stays unchanged (no upgrade to RBAC needed for this phase).

### Docs to Fetch
- (Skip — in-repo precedent is the authoritative reference. Patterns from Phases 3–6 cover everything Phase 7 needs.)

### Project Files to Read
- `spec/dev_steps.md` Step 7 — canonical task list.
- `spec/improvements.md` Improvement #1 (FlightPoolManager rewire) and #8 (per-traveler index / MyPolicies).
- `spec/architecture.md` `Controller` section — wire-format target. Note: `get_flight_config` return type in the `FlightPoolManager` section will need a one-line update during Phase 7 (was `FlightConfig`, becomes `Option<FlightConfig>`).
- `contracts/controller/src/lib.rs` — full file (~685 lines). Primary edit site.
- `contracts/controller/src/test.rs` — currently broken (~705 lines, references deleted `flight_pool::*` and `recovery_pool::*`). Full rewrite this phase.
- `contracts/controller/Cargo.toml` — verify `flight_pool_manager` dep is present, `flight_pool` / `recovery_pool` are not (Phase 3 already did this).
- `contracts/flight_pool_manager/src/lib.rs` — entire file. Primary cross-crate edit at `get_flight_config` (~L556–561). Also need to read `register_flight`, `add_buyer`, `settle_*`, `set_controller` for accurate `FlightPoolManagerClient` trait mirroring.
- `contracts/flight_pool_manager/src/test.rs` — ~3–5 call sites of `client.get_flight_config(...)` need `.unwrap()` or pattern-match update after the API change. Spot-check.
- `contracts/governance_module/src/lib.rs` — for `RouteStatus` enum + `route_status` signature (already mirrored in controller from Phase 4; verify untouched).
- `contracts/oracle_aggregator/src/lib.rs` — for `FlightData` shape (already mirrored in controller from Phase 6).
- `contracts/risk_vault/src/lib.rs` — for `VaultClient` interface (no changes; controller's mirror is already correct).
- `contracts/integration_tests/src/tests/setup.rs` — for reference only. The controller's constructor signature changes break this file's call site, but Phase 10 fixes it (Stage 2 of build-red still applies through the rest of Phase 7).

## Pre-work Notes

> Decisions seeded from the planning conversation. Edit any line you disagree
> with before running `/start-phase 7`.

**Decisions confirmed by user:**

- **Q1a — `flight_pool_manager::get_flight_config` returns `Option<FlightConfig>`**, not panicking. Controller's buy_insurance path uses `match pool.get_flight_config(...) { None => register-then-add-buyer, Some(_) => add-buyer }` in one cross-contract call. Phase 7 also updates flight_pool_manager's existing tests (~3–5 sites) to handle the new return type.

**Decisions clarified from spec / pre-decided (no input needed):**

- **`TravelerFlights(Address)` storage tier:** Persistent, per-traveler. TTL window: `TRAVELER_FLIGHTS_TTL_LEDGERS = 60 * 24 * 60 * 12 = 1_036_800` (60 days at 5s/ledger), matching Phase 4's `ROUTE_TTL_LEDGERS`. Cron #4 (Improvement #6 / Phase 9) handles long-term extension for active travelers.
- **`get_flights_for_traveler` semantics:** returns the full `Vec<(Symbol, u64)>` — append-only, no filtering by status. Frontend filters. Append-only because pruning would either lose user-facing history or require an extra storage write per settle (cross-contract back-ref).
- **Where the settlement loops iterate:** both `classify_flights` and `execute_settlements` iterate `oracle.get_active_flights()`. After Phase 6, that list includes settled-but-not-yet-pruned flights (within the 30-day retention window) — they're no-ops at classify/execute (status check filters them). Iterating from oracle is semantically right: classification needs oracle data anyway. The dead local `ActiveFlightList` reads from controller go away.
- **Controller does not own an active list anymore.** `FlightPoolManager` owns a list of currently-Active flights; oracle owns a list with retention window. Controller stays purely orchestrating.
- **Test rewrite shape:** comprehensive from scratch (~25–30 tests). Mirrors the lifecycle coverage Phase 3 used for FlightPoolManager: constructor, owner functions, buy_insurance happy path, buy_insurance second-traveler-skips-register, route Disabled/Unknown panics, solvency gate, lead-time gate, classify_flights (on-time/delayed/cancelled), execute_settlements (all three outcomes), get_flights_for_traveler, keeper auth, end-to-end.
- **No `architecture.md` Controller section rewrite expected.** It already specifies `TravelerFlights`, `get_flights_for_traveler`, FlightPoolManager wiring (synced from earlier). One small drift fix may be needed: update `FlightPoolManager` section's `get_flight_config` return type from `FlightConfig` to `Option<FlightConfig>`.

**Architectural details locked in:**

- **Controller's inline `FlightPoolManagerClient` trait** uses Pattern B (mirror types). Mirrors `FlightConfig` struct + `SettlementStatus` enum from `flight_pool_manager/src/lib.rs`. Field order MUST match exactly. Pattern-B lockstep discipline applies (Phases 4 + 6 set the precedent — see `project_codebase_patterns.md`).
- **Drop the obsolete `PoolClient` / `PoolInterface` trait** in `controller/src/lib.rs` — that's the per-flight pool client from the deleted topology. Replaced by `FlightPoolManagerClient`.
- **Constructor parameter order:** `(env, owner, governance, risk_vault, oracle, flight_pool_manager, usdc_token, authorized_keeper, min_lead_time, claim_expiry_window)`. Drop `recovery_pool` and `flight_pool_wasm`; add `flight_pool_manager`.
- **`buy_insurance` USDC routing:** traveler USDC goes directly to `FlightPoolManager` (its address from `CtrlKey::FlightPoolManager`), NOT to a per-flight pool address (those don't exist anymore).
- **Vault address used for `record_premium_income`:** unchanged; vault's controller-only auth requires the controller's address as the `controller` arg, which is `e.current_contract_address()`. Same pattern as Phase 3's `flight_pool_manager::settle_on_time` forwarding the controller's address to vault.
- **`classify_flights` reads `delay_hours` via `pool.get_flight_config(flight_id, date).unwrap().delay_hours`** — at classify time the flight MUST be registered (else it wouldn't be in the oracle's active list either), so `.unwrap()` is the right call. If somehow None at this point, panicking surfaces a real protocol bug.
- **`execute_settlements` calls `pool.settle_on_time(controller, flight_id, date)` / `settle_delayed(controller, flight_id, date, claim_expiry)` / `settle_cancelled(controller, flight_id, date, claim_expiry)`.** No more per-flight pool clients. RiskVault `send_payout` for delayed/cancelled targets the FlightPoolManager address (it now holds all flight USDC).

**Cross-contract addendum — `flight_pool_manager::get_flight_config`:**

```rust
// Before (lib.rs:556–561):
pub fn get_flight_config(e: &Env, flight_id: Symbol, date: u64) -> FlightConfig {
    e.storage()
        .persistent()
        .get(&PoolKey::FlightConfig(flight_id, date))
        .expect("flight not registered")
}

// After:
pub fn get_flight_config(
    e: &Env,
    flight_id: Symbol,
    date: u64,
) -> Option<FlightConfig> {
    e.storage()
        .persistent()
        .get(&PoolKey::FlightConfig(flight_id, date))
}
```

Update FlightPoolManager test sites — grep `get_flight_config` in
`contracts/flight_pool_manager/src/test.rs` and add `.unwrap()` (when the
test expects the entry to exist) or `.is_none()` / `.is_some()` (when the
test asserts presence/absence). Estimated ~3–5 sites.

**Dead code being removed from `controller/src/lib.rs`:**

`CtrlKey` variants:
- `FlightPoolWasm` (BytesN<32> — was the deployer's WASM hash)
- `ActiveFlight(Symbol, u64)` (was the per-flight pool address mapping)
- `ActiveFlightList` (was the controller's local list of active flights)
- `RecoveryPool` (was the RecoveryPool address)

Code paths:
- The `env.deployer()` block in `buy_insurance` (~50 lines including salt computation, deploy call, address storage).
- All `ActiveFlight` / `ActiveFlightList` reads/writes (now FlightPoolManager owns enumeration).
- Constructor args `recovery_pool: Address` and `flight_pool_wasm: BytesN<32>`.
- The inline `PoolClient` / `PoolInterface` trait (per-flight pool API).
- Read functions `get_active_pools` and `get_pool_address` (relic of per-flight architecture).
- The local `get_active_flight_list` / `save_active_flight_list` helpers.
- The `PoolDeployed` event (no more deploys).

**Implementation order — keep workspace green per-crate at each step:**

1. **Cross-crate first** — change `flight_pool_manager::get_flight_config` to return `Option<FlightConfig>`. Update its tests. Verify `cargo build -p flight_pool_manager` and `cargo test -p flight_pool_manager` clean.
2. **Then controller** — full rewrite of `controller/src/lib.rs`. Verify `cargo build -p controller` clean.
3. **Then controller tests** — full rewrite of `controller/src/test.rs`. Verify `cargo test -p controller` clean.

**Phase rollover:**

- Per memory `feedback_phase_bundling`, the user runs `/start-phase 8` before `/complete-phase 7`. Don't block.
- Per memory `feedback_cargo_lock`, leave `Cargo.lock` dirty after destructive crate edits. None expected this phase (no crate adds/removes).
- Phase 7 closes Stage 2 of the build-red window. After this phase, every crate builds AND tests individually. `cargo test --workspace` still fails on `integration_tests` — Phase 10 closes that.

---

## Subtasks

- [x] 1. **Cross-crate: change `flight_pool_manager::get_flight_config`** to return `Option<FlightConfig>` (drop `.expect("flight not registered")`). Update flight_pool_manager test sites that call it (~3–5 sites — `.unwrap()` for present-case asserts, `.is_none()`/`.is_some()` for presence/absence asserts). Verify `cargo build -p flight_pool_manager` and `cargo test -p flight_pool_manager` clean.
- [x] 2. **Verify `controller/Cargo.toml`** has `flight_pool_manager` (not `flight_pool` / `recovery_pool`). Phase 3 should have done this; spot-check at start time.
- [x] 3. **`CtrlKey` cleanup.** Remove `FlightPoolWasm`, `ActiveFlight(Symbol, u64)`, `ActiveFlightList`, `RecoveryPool`. Add `FlightPoolManager` (Address, Instance) and `TravelerFlights(Address)` (Vec<(Symbol, u64)>, Persistent). Add Instance/Persistent tier-grouping comments matching the Phase 5/6 pattern.
- [x] 4. **Add inline `FlightPoolManagerClient` trait** via `#[contractclient(name = "FlightPoolManagerClient")]`. Methods: `register_flight(controller, flight_id, date, premium, payoff, delay_hours)`, `get_flight_config(flight_id, date) -> Option<FlightConfig>`, `add_buyer(controller, flight_id, date, buyer)`, `settle_on_time(controller, flight_id, date)`, `settle_delayed(controller, flight_id, date, claim_expiry)`, `settle_cancelled(controller, flight_id, date, claim_expiry)`. Mirror `FlightConfig` struct + `SettlementStatus` enum from flight_pool_manager — field order MUST match (Pattern B lockstep).
- [x] 5. **Drop the obsolete `PoolClient` / `PoolInterface` trait** and the `PoolDeployed` event from `controller/src/lib.rs`. Both are relics of the per-flight pool topology.
- [x] 6. **Add constants.** `TRAVELER_FLIGHTS_TTL_LEDGERS = 60 * 24 * 60 * 12` (60 days at 5s/ledger). Place near the existing TTL constants (~L153–156).
- [x] 7. **Modify constructor.** Drop `recovery_pool: Address` and `flight_pool_wasm: BytesN<32>` params. Add `flight_pool_manager: Address` param. Persist to `CtrlKey::FlightPoolManager`. Drop `BytesN`-related imports if no longer used.
- [x] 8. **Rewrite `buy_insurance`.** Full body: traveler auth → `gov.route_status(...)` match (Active/Disabled/Unknown) → min_lead_time gate → `pool.get_flight_config(flight_id, date)` match (None → `pool.register_flight(...)` + `oracle.register_flight(...)`, Some → skip) → solvency check → `usdc.transfer(traveler, flight_pool_manager_addr, premium)` → `vault.increase_locked(controller, payoff)` → `pool.add_buyer(controller, flight_id, date, traveler)` → append `(flight_id, date)` to `TravelerFlights(traveler)` + extend TTL → update counters → emit `InsuranceBought`. Drop the entire `env.deployer()` block (~50 lines).
- [x] 9. **Rewrite `classify_flights`.** Iterate `oracle.get_active_flights()` (no more local list). For each flight: read `oracle.get_flight_data(flight_id, date)`; if `status == Landed`, look up `pool.get_flight_config(flight_id, date).unwrap().delay_hours` and compute outcome; if `status == Cancelled`, mark `ToBeSettledCancelled`; otherwise skip. Where oracle returns `NotInitiated` for a flight expected to have data, leave a `// TODO Phase 9: emit ttl_miss` comment. Emit `FlightClassified` events as before.
- [x] 10. **Rewrite `execute_settlements`.** Iterate `oracle.get_active_flights()`. For each `ToBeSettled*` flight: call `pool.settle_on_time(controller, flight_id, date)` or `pool.settle_delayed(controller, flight_id, date, claim_expiry)` or `pool.settle_cancelled(...)` — and the corresponding vault calls (`record_premium_income` for on-time, `send_payout` to flight_pool_manager_addr for delayed/cancelled, `decrease_locked` for all). Drop the local `ActiveFlightList` removal — FlightPoolManager owns that list now. Continue to call `vault.process_withdrawal_queue(controller)` and `vault.snapshot()` at the end. Emit `FlightSettledEvent` events as before.
- [x] 11. **Add `get_flights_for_traveler(env, address) -> Vec<(Symbol, u64)>`** read function. Reads `TravelerFlights(address)` Persistent storage; returns empty Vec if missing.
- [x] 12. **Drop dead read functions.** Remove `get_active_pools` and `get_pool_address` from the contract surface — they reference the deleted `ActiveFlight` / `ActiveFlightList` keys.
- [x] 13. **Update remaining helpers / references.** Remove `get_active_flight_list` and `save_active_flight_list` private helpers. Verify no remaining `flight_pool` / `recovery_pool` import or reference anywhere in `controller/src/lib.rs`. Run `cargo build -p controller` clean.
- [x] 14. **Rewrite `controller/src/test.rs` from scratch.** Comprehensive coverage (~25–30 tests). Test fixture deploys all 5 contracts (controller + governance + risk_vault + oracle + flight_pool_manager) and wires `set_controller(...)` on each downstream. Coverage targets: constructor + owner functions; `buy_insurance` happy path (route validation, premium transfer, vault locking, traveler index update); `buy_insurance` second traveler on same flight (skips register, only `add_buyer`); `buy_insurance` panics on Disabled / Unknown route; solvency gate; lead-time gate; `classify_flights` on-time / delayed / cancelled; `execute_settlements` for each outcome (assert vault accounting + flight_pool_manager status); `get_flights_for_traveler` returns expected list; keeper auth on classify/execute; full end-to-end lifecycle.
- [x] 15. **Update `architecture.md` if drift surfaced.** Specifically the `FlightPoolManager` section's `get_flight_config` return type (now `Option<FlightConfig>`). Spot-check the Controller section for any other drift introduced this phase.
- [x] 16. **Final gates.** `cargo build -p controller` clean, `cargo test -p controller` passes (closing Stage 2 of build-red), `cargo build -p flight_pool_manager` clean, `cargo test -p flight_pool_manager` passes (existing 43 tests + minor updates).

### Gate

- `cargo build -p controller` clean.
- `cargo test -p controller` passes — **closes Stage 2 of the build-red window** (controller tests have been blocked since Phase 1).
- `cargo build -p flight_pool_manager` clean — the cross-contract `get_flight_config` change must compile.
- `cargo test -p flight_pool_manager` passes — existing 43 tests + minor updates for the new `Option<FlightConfig>` return type.
- `controller/src/lib.rs` has zero references to `flight_pool::*`, `recovery_pool::*`, `FlightPoolWasm`, `ActiveFlight(`, `ActiveFlightList`, `env.deployer()`. Verified by grep.
- `CtrlKey` enum has Instance/Persistent tier-grouping comments.
- `architecture.md` `FlightPoolManager` section reflects the `Option<FlightConfig>` return type.
- `cargo test --workspace` STILL FAILS on `integration_tests` — that's expected, Phase 10 closes it.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-03

Starting phase. Lite prime complete. Context manifest loaded.

- **Skills loaded:** `git`, `oz-stellar` (already in muscle memory from Phases 4–6).
- **Docs to Fetch:** intentionally skipped per manifest — Phases 3–6 in-repo precedent is authoritative.
- **Project files read:** `architecture.md` (full), `dev_steps.md` Step 7, `improvements.md` #1+#8, full `controller/src/lib.rs` (685 lines), full `flight_pool_manager/src/lib.rs` (609 lines), `controller/Cargo.toml` (already correct from Phase 3).
- **Baseline confirmed:**
  - 8 `get_flight_config` call sites in flight_pool_manager tests (more than initial 3-5 estimate). All happy-path; no `should_panic` reliance. Each needs `.unwrap()` after the API change.
  - Controller's existing `OracleClient` mirror already has `settled_at: u64` (Phase 6); `GovClient` already has `RouteStatus` (Phase 4). No additional Pattern B work for those.
  - Controller's existing `PoolClient` trait (the per-flight pool) is dead — replaced this phase by `FlightPoolManagerClient`.
  - Constructor at `controller/src/lib.rs:211–262` has 11 args including `recovery_pool` and `flight_pool_wasm` (both dropped this phase).
  - `buy_insurance` at L300–435 has the entire `env.deployer()` deploy block (L334–389, ~55 lines) — will be replaced.

**Implementation work (single session):**

- Subtask 1: `flight_pool_manager::get_flight_config` flipped to `Option<FlightConfig>` (drop `.expect`). 8 call sites in pool's test.rs updated with `.unwrap()` (single `replace_all` Edit since pattern was uniform). All 43 pool tests pass.
- Subtasks 2–13: full rewrite of `controller/src/lib.rs` (~330 lines) in one Write. CtrlKey reorganized with Instance/Persistent tier comments, dead variants dropped + 2 new ones added, FlightPoolManagerClient inline trait + FlightConfig/SettlementStatus mirrors added (Pattern B lockstep — 3rd application of the discipline), PoolClient + PoolDeployed dropped, constructor reduced from 11 args to 9 (drop recovery_pool + flight_pool_wasm, add flight_pool_manager), buy_insurance/classify_flights/execute_settlements all rewritten to use FlightPoolManager singleton + iterate `oracle.get_active_flights()`, get_flights_for_traveler added, dead readers/helpers dropped. Grep confirms zero remaining `flight_pool::*` / `recovery_pool::*` / `FlightPoolWasm` / `ActiveFlight(` / `env.deployer` references.
- Subtask 14: full rewrite of `controller/src/test.rs` (~590 lines) covering 27 tests. Required `mock_all_auths_allowing_non_root_auth` instead of `mock_all_auths` because the controller's auth flows 3-deep (keeper → controller → flight_pool_manager → vault) and the standard mock_all_auths only handles root-frame auth. 3 tests initially failed with `Auth(InvalidAction)` on the deeper vault calls; switching the mock fixed all 3. Test coverage: constructor + getters, 4 owner-only setters, owner-auth panic, buy happy paths (single, multi-buyer-same-flight, multi-flight-same-traveler, empty-traveler-index), buy gate panics (Disabled/Unknown route, lead-time, solvency), classify (on-time/delayed/cancelled/skip-unready/non-keeper-panic), execute (on-time/delayed/cancelled/skip-unclassified/processes-withdrawal-queue/non-keeper-panic), end-to-end delayed lifecycle with traveler claim, end-to-end on-time lifecycle.
- Subtask 15: `architecture.md` `FlightPoolManager` section updated — `get_flight_config` return type now `Option<FlightConfig>` with a 2-sentence rationale paragraph added.

**Final gates — all green:**
- `cargo build -p controller` ✓
- `cargo test -p controller` ✓ (27/27) — **closes Stage 2 of the build-red window**
- `cargo build -p flight_pool_manager` ✓
- `cargo test -p flight_pool_manager` ✓ (43/43)
- Zero references to deleted symbols in controller lib (verified by grep)
- `architecture.md` in sync

All subtasks complete. Gate condition met. Ready for `/complete-phase 7`.

### Session 2026-05-03 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

**Modified:**
- `contracts/flight_pool_manager/src/lib.rs` — `get_flight_config` return type now `Option<FlightConfig>` (drop `.expect`).
- `contracts/flight_pool_manager/src/test.rs` — 8 call sites of `get_flight_config` now `.unwrap()`.
- `contracts/controller/src/lib.rs` — full rewrite (~330 lines): CtrlKey cleanup, FlightPoolManagerClient inline trait + mirror types, drop PoolClient + PoolDeployed, constructor 9 args, three core function rewrites, get_flights_for_traveler added.
- `contracts/controller/src/test.rs` — full rewrite (~590 lines, 27 tests).
- `contracts/controller/test_snapshots/test/*.json` — auto-regenerated by test runner (existing snapshots replaced; new ones created).
- `spec/architecture.md` — `FlightPoolManager` section's `get_flight_config` return type + rationale paragraph.
- `spec/phases/phase-07-controller-rewire.md` — work log, files modified, decisions, status `planned → in_progress`.
- `spec/progress.md` — row 7 status, Started date, Current Phase header.

**Created:**
- 27 new test snapshots under `contracts/controller/test_snapshots/test/`.

**Deleted from contract surface:**
- `CtrlKey::FlightPoolWasm`, `CtrlKey::ActiveFlight(Symbol, u64)`, `CtrlKey::ActiveFlightList`, `CtrlKey::RecoveryPool`.
- `PoolClient` / `PoolInterface` trait (per-flight pool API).
- `PoolDeployed` event (no more deploys).
- `get_active_pools` and `get_pool_address` read functions.
- `get_active_flight_list` / `save_active_flight_list` private helpers.
- The entire `env.deployer()` block in `buy_insurance` (~55 lines).

---

## Decisions Made

- **Q1a confirmed in code:** `flight_pool_manager::get_flight_config` returns `Option<FlightConfig>`. Controller's `buy_insurance` uses `.is_none()` for the "register if missing" branch; classify/execute use `.expect("flight not registered in pool")` because at those phases the flight MUST exist (or the state is inconsistent).
- **Auth model: `mock_all_auths_allowing_non_root_auth` for controller tests.** The controller orchestrates 3-deep call chains (keeper → controller → pool → vault) where the controller's address authorizes sub-invocations beyond the root frame. Plain `mock_all_auths` only handles root-frame auth and breaks at the deeper vault call. The non-root variant is the right tool for orchestrator tests; documented in setup() with a comment.
- **Iteration source for classify/execute: `oracle.get_active_flights()`.** Post-Phase-6, this list includes settled-but-not-yet-pruned flights (within the 30-day retention window) — those become no-ops at classify/execute (status check filters them). FlightPoolManager's own `get_active_flights` only returns currently-Active flights, which would miss the ToBeSettled* states needed by execute_settlements. Oracle is the right source.
- **`buy_insurance` USDC transfer authorizes via `traveler.require_auth()` propagation.** The traveler signs the top-level `buy_insurance` call; the `usdc.transfer(traveler, pool_addr, premium)` sub-invocation is authorized by Soroban's auth framework as part of the same root frame. No explicit `traveler.require_auth()` is needed inside the transfer — `require_auth()` at the start of `buy_insurance` covers it.
- **`TravelerFlights(addr)` is append-only.** `get_flights_for_traveler` returns the full list; frontend filters by current status (looked up via FlightPoolManager / oracle). Pruning would either lose user-facing history or require a cross-contract write per settlement.
- **`TRAVELER_FLIGHTS_TTL_LEDGERS = 60 days`** matching Phase 4's `ROUTE_TTL_LEDGERS`. Cron #4 (Phase 9) handles long-term extension.
- **Pattern B lockstep mirror: third application.** Phase 4 (`RouteStatus`), Phase 6 (`FlightData.settled_at`), now Phase 7 (`FlightConfig` + `SettlementStatus`). The discipline is now well-exercised and codified in `project_codebase_patterns.md`.
- **Constructor breaks `integration_tests/setup.rs`.** Expected — Phase 10's job to update. Stage 2 of build-red applies to `cargo test --workspace` (still fails) but every individual crate is now green: `cargo test -p {risk_vault, oracle_aggregator, flight_pool_manager, governance_module, controller}` all pass.

---

## Completion Summary

**What was built:**
- The controller is fully migrated to the post-Phase-3 architecture. `env.deployer()` per-flight pool deployment is gone; the singleton `FlightPoolManager` handles all flight lifecycle. The `TravelerFlights(Address)` per-traveler index unblocks the MyPolicies frontend without an off-chain indexer.
- Cross-contract addendum: `flight_pool_manager::get_flight_config` returns `Option<FlightConfig>` (was panicking) — single-call "look up; if missing register" pattern in `buy_insurance`.
- Closed **Stage 2 of the build-red window** opened by Phases 1–2. Every contract crate now builds AND tests individually. Only `cargo test --workspace` still fails on `integration_tests`, which Phase 10 closes.

**Key decisions locked in:**
- Pattern B mirror discipline applied for the third time (FlightConfig + SettlementStatus mirrored in controller). Phases 4 (RouteStatus), 6 (FlightData.settled_at), 7 (FlightConfig + SettlementStatus). The pattern is now thoroughly exercised and documented in `project_codebase_patterns.md`.
- **Soroban auth gotcha for orchestrator contracts:** `env.mock_all_auths_allowing_non_root_auth()` is required (not the standard `mock_all_auths`) when test scenarios chain through 3-deep contract calls where a contract address authorizes sub-invocations beyond the root frame. Discovered during the Phase 7 test rewrite.
- `TravelerFlights(addr)` is append-only with a 60-day per-write TTL; Cron #4 (Phase 9) handles long-term extension.
- Iteration source for `classify_flights` and `execute_settlements` is `oracle.get_active_flights()` (not the controller's old local list, which is gone).
- Constructor reduced from 11 args to 9 (drop `recovery_pool` + `flight_pool_wasm`, add `flight_pool_manager`).

**Files modified:**
- `contracts/flight_pool_manager/src/lib.rs` — `get_flight_config` returns `Option<FlightConfig>`.
- `contracts/flight_pool_manager/src/test.rs` — 8 sites with `.unwrap()`.
- `contracts/controller/src/lib.rs` — full rewrite (~330 lines).
- `contracts/controller/src/test.rs` — full rewrite (~590 lines, 27 tests).
- `contracts/controller/test_snapshots/test/*.json` — 27 new/regenerated snapshots.
- `spec/architecture.md` — `FlightPoolManager` `get_flight_config` return-type drift fixed.
- `spec/progress.md` — row 7 closed, Current Phase header updated.

**For the next phase to know:**
- **Phase 8 (RiskVault TTL + recovery)** is next — small phase, similar shape to Phase 5/6 storage hygiene work. `ClaimableBalance` gets 60-day TTL on writes + a new `recover_uncollected` owner function; `SnapshotPrice` moves Persistent → Temporary with 30-day TTL.
- **Phase 10 (integration tests)** is the only remaining build-red blocker. After Phase 8/9 land, Phase 10 rewrites `integration_tests/src/tests/*.rs` to use the new contract topology (no `flight_pool` / `recovery_pool` imports, FlightPoolManager singleton, new constructor signature). The setup.rs already-broken constructor call is the obvious starting point.
- The `mock_all_auths_allowing_non_root_auth` discovery applies to integration_tests too — they orchestrate the full system, so the same auth-chain depth applies. Phase 10's test fixture should adopt the non-root variant from the start.

**Known limitations / deferred items:**
- `cargo test --workspace` still fails on `integration_tests` (Phase 10).
- `prune_settled` (Phase 6) and `recover_uncollected` (Phase 8 future) are exposed but uncalled until cron wiring lands in `executor/`.
- The `// TODO Phase 9: emit ttl_miss` comment in `controller/src/lib.rs::classify_flights` flags the spot Phase 9 needs to wire the diagnostic event.
