# Phase 10 — Integration tests rewrite

Status: complete
Started: 2026-05-03
Completed: 2026-05-03

---

## Goal

The final phase of the Phase 3 contract reorg. Rewrite the
`integration_tests/` crate end-to-end against the new contract topology
(post-Phases 1–9): no `flight_pool` / `recovery_pool` references, singleton
`FlightPoolManager`, new `Controller::__constructor` 9-arg signature,
`mock_all_auths_allowing_non_root_auth` for the 3-deep auth chains the
controller orchestrates, and full coverage of the new surfaces — `vault.*`
events, `prune_settled`, `recover_uncollected`, `TravelerFlights` index,
`warn.ttl_miss` diagnostic.

After this phase, **`cargo test --workspace` is green** for the first time
since Phase 1. Stage 2 + the integration_tests blocker close together.
The next protocol step (Phase 11+ executor / frontend work) finally has a
green workspace to build against.

This is a **large phase** by line count — comparable to Phase 7 in scope —
because the test rewrite is comprehensive (~60 tests across 8 files),
exercises every contract surface end-to-end, and includes the test fixture
overhaul. Estimated diff: ~1,500–2,000 lines across `setup.rs` rewrite +
6 existing group rewrites + 2 new groups (governance, events).

## Dependencies

- **Phase 1, 2 complete** — `flight_pool/` and `recovery_pool/` deleted.
- **Phase 3 complete** — `flight_pool_manager` exists with the API the
  tests will call. `integration_tests/Cargo.toml` already has the right
  dev-deps (`flight_pool_manager` added; `flight_pool` / `recovery_pool`
  removed).
- **Phase 4–9 complete** — every contract surface this phase exercises is
  finalised (`route_status` from gov, `prune_settled` + `settled_at` from
  oracle, controller's `FlightPoolManagerClient` + `TravelerFlights`,
  vault's `recover_uncollected` + `vault.*` events, controller's
  `warn.ttl_miss`).
- No new contract dependencies. This is a pure test-rewrite phase.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the Phase 10 + final-merge commit at the end.
- `oz-stellar` — sanity-check OZ Vault test patterns (deposit, redeem, share-burn semantics).

### Docs to Fetch
- (Skip — in-repo precedent is authoritative. Phases 3, 7, 8 unit-test
  patterns are the closest reference for multi-contract test fixtures.)

### Project Files to Read
- `spec/dev_steps.md` Step 10 — canonical task list (the deletion + rewrite
  checklist).
- `spec/architecture.md` — full file. Integration tests verify the
  end-to-end behaviour the architecture documents.
- `spec/improvements.md` — for the indexer / cron context (Improvements
  #3, #6, #9). Tests don't build the indexer/cron, but they verify the
  on-chain events + functions those consume.
- `contracts/integration_tests/src/tests/setup.rs` — current 225-line
  fixture; broken since Phase 1. Full rewrite this phase.
- `contracts/integration_tests/src/tests/{group1_lifecycle, group2_capital, group3_withdrawal, group4_parallel, group5_edge_cases, group6_authorization}.rs` — 6 existing group files (~700 lines). All broken; all rewritten.
- `contracts/integration_tests/src/tests/mod.rs` — module declarations. Add `group7_governance` and `group8_events`.
- `contracts/integration_tests/Cargo.toml` — verify dev-deps still correct (Phase 3 set them; spot-check).
- ALL contract source files in `contracts/`:
  - `governance_module/src/lib.rs` — for `route_status` / `RouteStatus` / `whitelist_route` / `disable_route` / `enable_route` / `remove_route` / `update_route_terms` / `set_defaults` / `add_admin`.
  - `flight_pool_manager/src/lib.rs` — for `register_flight` / `add_buyer` / `claim` / `settle_*` / `sweep_expired` / `withdraw_recovered` / `get_flight_config` (now Option) / `set_controller`.
  - `oracle_aggregator/src/lib.rs` — for `set_estimated_arrival` / `set_landed` / `set_cancelled` / `set_to_be_settled` / `set_settled` / `prune_settled` / `get_active_flights` / `get_flight_data` (now with `settled_at`).
  - `risk_vault/src/lib.rs` — for `deposit` / `redeem` / `request_withdrawal` / `cancel_withdrawal` / `process_withdrawal_queue` / `collect` / `recover_uncollected` (with `RecoveryMode`) / `snapshot` / `set_controller` / vault.* events.
  - `controller/src/lib.rs` — for `__constructor` (9-arg) / `buy_insurance` / `classify_flights` / `execute_settlements` / `get_flights_for_traveler` / `TtlMiss` event / `set_keeper`.
- `contracts/controller/src/test.rs` — closest precedent for multi-contract fixture (Phase 7). Reuses the `mock_all_auths_allowing_non_root_auth` pattern Phase 10 needs.
- `contracts/risk_vault/src/test.rs` — reference for `count_events_with_topic` helper Phase 10 will reuse.

## Pre-work Notes

> Decisions seeded from the planning conversation. Edit any line you disagree
> with before running `/start-phase 10`.

**Decisions confirmed:**

- **Comprehensive scope.** ~60 tests across 8 files (6 existing groups + 2 new). Goal is end-to-end coverage of every contract surface modified in Phases 1–9. The implementation can land file-by-file; mark progress in the Work Log per group.
- **Test fixture uses `mock_all_auths_allowing_non_root_auth()`** (per Phase 7 codebase memory). Plain `mock_all_auths()` doesn't propagate contract auth through 3-deep chains (`keeper → controller → pool → vault`).
- **Existing 6-group structure preserved** + 2 new groups added. Map by theme, not by phase. Existing group naming convention (`groupN_<theme>.rs`) kept.
- **Snapshot tests will all auto-regenerate** (every test re-records on first pass since the existing snapshots reference deleted contracts). Diff-inspect a sampling to confirm only structural changes; they're not load-bearing.

**File structure (post-Phase-10):**

```
contracts/integration_tests/src/tests/
├── mod.rs                       # add group7, group8
├── setup.rs                     # full rewrite
├── group1_lifecycle.rs          # rewrite — full flight lifecycle outcomes
├── group2_capital.rs            # rewrite — vault accounting, solvency
├── group3_withdrawal.rs         # rewrite — underwriter exit + recover_uncollected
├── group4_parallel.rs           # rewrite — multi-buyer, multi-flight
├── group5_edge_cases.rs         # rewrite — prune, sweep, TTL, snapshot expiry
├── group6_authorization.rs      # rewrite — auth panics across all contracts
├── group7_governance.rs         # NEW — route lifecycle, terms updates, admins
└── group8_events.rs             # NEW — end-to-end event chain verification
```

**setup.rs rewrite — TestEnv + helpers:**

- `TestEnv` deploys 5 contracts: `governance_module`, `risk_vault`, `oracle_aggregator`, `flight_pool_manager`, `controller` (in dependency order).
- Wires `set_controller(ctrl_addr)` on the three downstream contracts that need it: `vault`, `oracle`, `flight_pool_manager`.
- Whitelists the default test route `("AA100", "JFK", "LAX")` with default terms.
- Seeds an underwriter with `DEPOSIT_AMOUNT = 1000 USDC` for solvency coverage.
- Drops the dead fields: `recovery_addr`, `flight_pool_wasm_hash`. Adds `pool_addr`, `pool` (FlightPoolManagerClient).
- Helpers — match the controller test fixture style:
  - `buy(traveler)` — mints PREMIUM USDC + calls `controller.buy_insurance(...)`.
  - `oracle_on_time()`, `oracle_delayed()`, `oracle_cancelled()` — drives oracle through the relevant status transitions.
  - `classify_and_settle()` — calls `controller.classify_flights(keeper)` then `execute_settlements(keeper)`.
  - `advance_time(seconds)` — bumps ledger timestamp.
  - `count_events_with_topic(prefix0, prefix1)` — reuses Phase 8's helper.

**Constants (mostly unchanged from current setup.rs):**

```rust
pub const PREMIUM: i128 = 10_0000000;       // 10 USDC
pub const PAYOFF: i128 = 50_0000000;        // 50 USDC
pub const DELAY_HOURS: u32 = 3;
pub const FLIGHT_DATE: u64 = 1_710_500_000;
pub const MIN_LEAD_TIME: u64 = 3_600;
pub const CLAIM_EXPIRY_WINDOW: u64 = 5_184_000; // 60 days
pub const DEPOSIT_AMOUNT: i128 = 1_000_0000000; // 1000 USDC
pub const INITIAL_TIMESTAMP: u64 = 1_710_400_000;
pub const EST_ARRIVAL: u64 = 1_710_500_000;
pub const ACTUAL_ON_TIME: u64 = 1_710_501_800; // 30min late
pub const ACTUAL_DELAYED: u64 = 1_710_510_800; // 3h late
```

**Test inventory — ~60 tests across 8 files:**

### group1_lifecycle.rs — three settlement outcomes (~10 tests)
- `lifecycle_on_time` — premium → vault as yield, no payout, traveler keeps no USDC.
- `lifecycle_delayed` — vault sends `(payoff - premium) * buyers` to pool, traveler claims `payoff`.
- `lifecycle_cancelled` — same money flow as delayed, oracle path is `Active → Cancelled`.
- `lifecycle_marginal_on_time` — actual delay = `delay_hours - 1s` → on-time path.
- `lifecycle_marginal_delayed` — actual delay = exactly `delay_hours` (boundary) → delayed path.
- `claim_after_delayed_succeeds`.
- `claim_after_cancelled_succeeds`.
- `claim_panics_on_time` — `flight not in claimable status`.
- `claim_panics_double_claim` — second `claim()` panics `already claimed`.
- `claim_panics_after_expiry` — past `claim_expiry`, panics `claim window closed`.

### group2_capital.rs — money flow + solvency (~8 tests)
- `solvency_gate_blocks_undercollateralized_purchase` — vault free_capital < required → `insufficient vault capital`.
- `solvency_gate_with_ratio_150` — owner sets ratio to 150 → required = `payoff × 1.5`.
- `lead_time_gate_blocks_short_notice` — `flight_date < now + min_lead_time`.
- `usdc_transfer_traveler_to_pool_on_buy` — exact balance shifts.
- `vault_locks_collateral_on_buy` — `locked_capital += payoff` per buy.
- `vault_unlocks_collateral_on_settle` — `locked_capital == 0` after the only flight settles.
- `total_managed_assets_invariant_through_lifecycle` — TMA only moves on the documented mutators.
- `payouts_distributed_counter_tracks_payouts` — increments only on delayed/cancelled.

### group3_withdrawal.rs — underwriter lifecycle + recovery (~8 tests)
- `deposit_then_immediate_redeem_within_free_capital`.
- `redeem_blocked_when_capital_locked` — `exceeds free capital`.
- `request_withdrawal_processed_after_settle` — queue → settle → process credits ClaimableBalance.
- `collect_after_credit` — drains balance, transfers USDC.
- `cancel_withdrawal_returns_shares`.
- `recover_uncollected_recredit_path` — owner SETs balance, user collects.
- `recover_uncollected_transfer_path` — owner direct USDC transfer, no storage write.
- `recover_uncollected_unauthorized_panics`.

### group4_parallel.rs — multi-actor, multi-flight (~7 tests)
- `multiple_buyers_same_flight` — buyer_count and money math scale.
- `multiple_flights_independent_settlements` — flight A delayed, B on-time in same execute tick.
- `traveler_index_across_multiple_flights` — `get_flights_for_traveler` returns all in order.
- `traveler_with_multiple_routes`.
- `same_traveler_double_buy_same_flight_panics` — `already a buyer` from FlightPoolManager.
- `concurrent_underwriters_share_payout_burden`.
- `five_travelers_same_flight_lifecycle`.

### group5_edge_cases.rs — prune, sweep, TTL, snapshot (~9 tests)
- `prune_settled_after_30d_evicts_aged_flights`.
- `prune_settled_idempotent`.
- `prune_settled_callable_by_anyone` — random non-keeper address calls and succeeds.
- `prune_settled_no_op_before_retention_window`.
- `sweep_expired_after_claim_window` — credits `RecoveredBalance`.
- `sweep_expired_idempotent`.
- `withdraw_recovered_by_owner` — drains `RecoveredBalance` to owner.
- `snapshot_expires_after_30d` — `get_snapshot_price` returns 0.
- `ttl_miss_emitted_on_classify_with_missing_oracle_data`.

### group6_authorization.rs — auth panics across the surface (~10 tests)
- `non_keeper_classify_panics`.
- `non_keeper_execute_panics`.
- `non_oracle_set_estimated_panics`.
- `non_oracle_set_landed_panics`.
- `non_owner_set_keeper_panics`.
- `non_owner_recover_uncollected_panics`.
- `non_owner_set_defaults_panics`.
- `non_controller_register_flight_on_pool_panics`.
- `non_controller_increase_locked_on_vault_panics`.
- `set_controller_one_time_write_panics_on_second_call` — for each of vault/oracle/pool.

### group7_governance.rs — gov flows (~8 tests, NEW group)
- `whitelist_route_then_buy_succeeds`.
- `disable_route_blocks_new_purchase` — `route is disabled`.
- `enable_after_disable_unblocks_purchase`.
- `unknown_route_blocks_purchase` — `route not whitelisted`.
- `update_terms_doesnt_affect_existing_flights` — flight registered with old terms; new buys see new terms.
- `set_defaults_changes_resolved_terms_for_use_default_routes`.
- `admin_can_whitelist_and_disable`.
- `remove_route_strict_requires_disable_first`.

### group8_events.rs — end-to-end event chain (~6 tests, NEW group)
- `buy_path_emits_full_chain` — single `buy_insurance` produces: `route.listed` (if first), FPM `register`, oracle `flight`, FPM `buyer`, controller `ctrl` (InsuranceBought).
- `classify_emits_FlightClassified_and_oracle_status_event`.
- `settle_emits_full_chain` — controller FlightSettledEvent + FPM FlightSettled + oracle status.
- `vault_credited_collected_chain_via_underwriter_lifecycle`.
- `vault_recovered_recredit_and_transfer_modes_emit_correct_mode`.
- `ttl_miss_warn_event_topic_shape`.

**Implementation hints:**

- **Order of file-by-file work:** setup.rs first (everything else is broken until it compiles). Then group1 (lifecycle is the biggest dependency for everything else). Then groups 2–8 in any order — they share the fixture but don't share state.
- **`mock_all_auths_allowing_non_root_auth` is NOT optional.** Plain `mock_all_auths` will fail with `Auth(InvalidAction)` on the first 3-deep chain — same trap Phase 7 hit. `setup.rs` MUST use the non-root variant.
- **`count_events_with_topic` helper:** copy from `risk_vault/src/test.rs` (Phase 8). Place in `setup.rs` so all groups can use it.
- **Event-test ordering reminder** (Phases 4 / 8 / 9 all hit this): `env.events().all()` returns events from the most-recent contract invocation only. In tests asserting events, do the event check IMMEDIATELY after the emitting call, before any subsequent state read.
- **`#[allow(dead_code)]` on the TestEnv struct** — many tests use only some fields; the existing setup already does this. Keep it.
- **Don't introspect storage tier directly.** Tests work via the public API. The Phase 5 / 6 / 8 tier moves are invisible to API callers.
- **Snapshot regeneration is OK and expected.** Old snapshots reference deleted `flight_pool` contract ledger entries. New snapshots will reflect the FlightPoolManager singleton state. No need to manually edit them — the test runner regenerates.
- **Diff size estimate.** ~250 lines for setup.rs + ~1,500–2,000 lines for the 8 group files combined. Largest test rewrite of the project.

**Phase rollover:**

- Per memory `feedback_phase_bundling`, the user runs `/start-phase 11`
  before `/complete-phase 10`. Don't block. (Phase 11 is executor work
  — different scope from Phase 3 contract reorg.)
- Per memory `feedback_cargo_lock`, leave `Cargo.lock` dirty after
  destructive crate edits. None expected this phase.
- **Phase 10 closes the entire Phase 3 contract reorg.** After this lands:
  - `cargo test --workspace` is green.
  - All ~150 unit tests + ~60 integration tests pass.
  - Stage 2 build-red is fully closed.
  - The system is ready for Phase 11+ (executor / frontend / deploy).
  - This is a natural commit boundary — the user may want to bundle Phase
    8 / 9 / 10 into one final commit theme ("close out Phase 3 contract
    reorg"), or commit Phase 10 alone with a "Phase 3 reorg complete"
    commit message.

---

## Subtasks

- [x] 1. **Verify `integration_tests/Cargo.toml`** still has the correct dev-deps (`flight_pool_manager` present, `flight_pool` / `recovery_pool` absent). Phase 3 should have done this; spot-check.
- [x] 2. **Rewrite `setup.rs`** from scratch. New `TestEnv` deploys 5 contracts (gov, vault, oracle, FPM, controller in dep order); wires `set_controller` on vault/oracle/FPM; whitelists default route; seeds underwriter capital. Drops `recovery_addr`, `flight_pool_wasm_hash`. Uses `mock_all_auths_allowing_non_root_auth()` (NOT plain `mock_all_auths`). Adds helpers: `buy`, `oracle_on_time/delayed/cancelled`, `classify_and_settle`, `advance_time`, `count_events_with_topic`. Verify `cargo build -p integration_tests` clean before moving on.
- [x] 3. **Rewrite `group1_lifecycle.rs`** — ~10 tests covering on-time / delayed / cancelled lifecycles + claim panics + boundary cases per Pre-work Notes inventory.
- [x] 4. **Rewrite `group2_capital.rs`** — ~8 tests covering money flow + solvency + lead-time gates + counter invariants.
- [x] 5. **Rewrite `group3_withdrawal.rs`** — ~8 tests covering underwriter deposit / withdraw / queue / collect + Phase 8's `recover_uncollected` (both modes + auth).
- [x] 6. **Rewrite `group4_parallel.rs`** — ~7 tests covering multi-buyer same flight, multi-flight independent settlement, multi-route same traveler, double-buy panic.
- [x] 7. **Rewrite `group5_edge_cases.rs`** — ~9 tests covering Phase 6's `prune_settled` + Phase 3's `sweep_expired` / `withdraw_recovered` + Phase 8's snapshot 30d expiry + Phase 9's `ttl_miss`.
- [x] 8. **Rewrite `group6_authorization.rs`** — ~10 tests covering auth panics across all 5 contracts (keeper / oracle / controller / owner gates).
- [x] 9. **Add `group7_governance.rs`** (new file) — ~8 tests covering Phase 4's gov surface end-to-end (whitelist / disable / enable / remove / update_terms / set_defaults / admin add+remove).
- [x] 10. **Add `group8_events.rs`** (new file) — ~6 tests verifying the full event chain for buy / classify / settle / underwriter lifecycle / `recover_uncollected` modes / `ttl_miss`.
- [x] 11. **Update `mod.rs`** to declare the two new modules: `pub mod group7_governance;` `pub mod group8_events;`.
- [x] 12. **Run final gates.** `cargo test -p integration_tests` green for the full ~60-test suite. `cargo test --workspace` green (closes the last build-red blocker). Diff-inspect a sampling of auto-regenerated snapshots to confirm only structural changes.
- [x] 13. **(Optional) Architecture.md sanity check.** Walk the architecture doc end-to-end and confirm any pre-deployment claim is now backed by a green integration test. No edits expected — this is the doc-quality gate.

### Gate

- `cargo build -p integration_tests` clean.
- `cargo test -p integration_tests` green for the full suite (~60 tests).
- **`cargo test --workspace` green** — this is the canonical gate for the entire Phase 3 contract reorg. Stage 2 build-red is fully closed.
- All 5 contracts deployed in `setup.rs`, no `flight_pool` / `recovery_pool` references anywhere.
- Test fixture uses `mock_all_auths_allowing_non_root_auth()`.
- 8 test files (1 setup + 6 rewritten groups + 2 new groups) plus updated `mod.rs`.
- Snapshot diffs are structural-only (no behavioural drift introduced).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-03

Starting phase. Lite prime complete. Context manifest loaded.

- **Skills loaded:** `git`, `oz-stellar`.
- **Docs to Fetch:** intentionally skipped per manifest — Phases 3, 7, 8, 9 in-repo precedent is authoritative.
- **Project files read:** phase plan doc, all 5 contract source files, `controller/src/test.rs` (multi-contract fixture template), `risk_vault/src/test.rs` (count_events_with_topic helper template), existing 6 broken integration_tests group files.

**Implementation work (single session):**

- **Subtask 1:** Cargo.toml verified correct (Phase 3 cleanup persists).
- **Subtask 2:** `setup.rs` full rewrite. 5-contract deploy in dep order (gov → vault → oracle → FPM → controller); wire `set_controller` on vault/oracle/FPM; whitelist default AA100/JFK/LAX route; seed underwriter with 1000 USDC. Drops `recovery_addr` and `flight_pool_wasm_hash`. Adopts `mock_all_auths_allowing_non_root_auth()` per Phase 7 precedent. Helpers: `buy`, `buy_flight`, `oracle_on_time`, `oracle_delayed`, `oracle_cancelled`, `classify_and_settle`, `advance_time`. Two free-function helpers exposed for all groups: `count_events_with_topic` (2-symbol prefix match) and `count_events_with_single_prefix` (1-symbol prefix match — Phase 3 events use single-prefix style). 187 lines.
- **Subtask 3:** `group1_lifecycle.rs` — 10 tests landing on-time / delayed / cancelled, claim happy paths, claim guards (on-time, double-claim, post-expiry), boundary delay tests (delay = limit-1s, delay = exactly limit).
- **Subtask 4:** `group2_capital.rs` — 8 tests covering solvency gate (with custom env without underwriter), solvency_ratio=150, lead-time gate, USDC transfer balance shifts, vault collateral lock/unlock, TMA invariant through lifecycle, payouts-distributed counter.
- **Subtask 5:** `group3_withdrawal.rs` — 8 tests covering deposit→redeem, redeem-when-locked panic, request_withdrawal→process→credit→collect, cancel_withdrawal returns shares, recover_uncollected (Recredit + Transfer), unauthorized recover panics.
- **Subtask 6:** `group4_parallel.rs` — 7 tests covering multi-buyer (3, 5 travelers same flight), multi-flight independent settlements, multi-route per-traveler index, double-buy panic, concurrent underwriters' payout dilution math.
- **Subtask 7:** `group5_edge_cases.rs` — 9 tests covering `prune_settled` (after 30d / idempotent / permissionless / no-op before window), `sweep_expired` (idempotent), `withdraw_recovered`, snapshot 30-day expiry (returns 0), `warn.ttl_miss` event on classify with NotInitiated.
- **Subtask 8:** `group6_authorization.rs` — 10 tests covering keeper-gated controller fns, oracle-gated functions (with prerequisite state setup), owner-gated owner fns (with fresh non-mocked envs), controller-gated downstream fns, one-time set_controller writes for vault/pool/oracle.
- **Subtask 9:** `group7_governance.rs` (NEW) — 8 tests covering whitelist→buy, disable blocks purchase, enable unblocks, unknown route blocks, term updates don't affect existing flights, defaults change resolves UseDefault routes, admin role, remove_route strict (split into 2 separate tests since `catch_unwind` doesn't work on Soroban Env).
- **Subtask 10:** `group8_events.rs` (NEW) — 6 tests covering full buy event chain, classify chain, settle chain, vault.credited+collected via underwriter lifecycle, vault.recovered for both modes, ttl_miss topic shape.
- **Subtask 11:** `mod.rs` updated with `mod group7_governance;` and `mod group8_events;`.
- **Subtask 12:** Final gate run. Hit two compile errors initially:
  1. `Ledger as _` trait import missing in setup.rs + 2 group files. Fixed by changing `testutils::Ledger` to `testutils::Ledger as _`.
  2. `std::panic::catch_unwind` doesn't work on Soroban `Env` (UnwindSafe issues). Replaced with two separate `#[test] #[should_panic]` + happy-path tests in group7.
  Then one runtime test failure: `concurrent_underwriters_share_payout_burden` had wrong TMA-decrease math (subtracted full payoff instead of `payoff - premium` since premium stays in pool). Fixed.
- **Subtask 13:** architecture.md sanity check — no doc-level drift surfaced; the Phase 4–9 architecture updates earlier this session matched the test surface exactly.

**Final gates — all green:**
- `cargo test -p integration_tests` ✓ (68/68)
- **`cargo test --workspace` ✓** — first time green since Phase 1
  - controller: 28 tests
  - flight_pool_manager: 43 tests
  - governance_module: 30 tests
  - integration_tests: 68 tests
  - mock_usdc: 6 tests
  - oracle_aggregator: 29 tests
  - risk_vault: 24 tests
  - **Total: 228 tests**
- `cargo build -p integration_tests` ✓
- All 5 contracts deployed in setup.rs ✓
- Zero `flight_pool` / `recovery_pool` references in any source file ✓
- 8 test files (1 setup + 6 rewritten + 2 new) + updated mod.rs ✓

All subtasks complete. Gate condition met. **Ready for `/complete-phase 10` — closes the entire Phase 3 contract reorg.**

### Session 2026-05-03 — Completed

Phase validated by user. All gate conditions met. **Phase 3 contract reorg fully closed.**

---

## Files Created / Modified

**Modified:**
- `contracts/integration_tests/src/tests/setup.rs` — full rewrite (~187 lines).
- `contracts/integration_tests/src/tests/group1_lifecycle.rs` — full rewrite (~218 lines, 10 tests).
- `contracts/integration_tests/src/tests/group2_capital.rs` — full rewrite (~190 lines, 8 tests).
- `contracts/integration_tests/src/tests/group3_withdrawal.rs` — full rewrite (~155 lines, 8 tests).
- `contracts/integration_tests/src/tests/group4_parallel.rs` — full rewrite (~227 lines, 7 tests).
- `contracts/integration_tests/src/tests/group5_edge_cases.rs` — full rewrite (~167 lines, 9 tests).
- `contracts/integration_tests/src/tests/group6_authorization.rs` — full rewrite (~200 lines, 10 tests).
- `contracts/integration_tests/src/tests/mod.rs` — added 2 new module declarations.
- `contracts/integration_tests/test_snapshots/tests/**/*.json` — auto-regenerated for all tests (existing ones reset, new ones created).
- `spec/progress.md` — row 10 status, Started date, Current Phase header.

**Created:**
- `contracts/integration_tests/src/tests/group7_governance.rs` — new file (~230 lines, 8 tests).
- `contracts/integration_tests/src/tests/group8_events.rs` — new file (~180 lines, 6 tests).
- 60+ new test snapshots under `contracts/integration_tests/test_snapshots/tests/group{7,8}/`.

**Deleted from contracts:** nothing (test rewrites only).

---

## Decisions Made

- **Test fixture uses `mock_all_auths_allowing_non_root_auth()`** — confirmed in code. Plain `mock_all_auths()` would have failed the same way Phase 7's controller tests initially failed. The non-root variant is mandatory for any orchestrator-style test where contract auth flows through 3+ deep call chains.
- **Existing 6-group structure preserved** + 2 new groups added (group7_governance, group8_events). Groups stay theme-based: lifecycle / capital / withdrawal / parallel / edge_cases / authorization / governance / events.
- **`catch_unwind` is incompatible with Soroban `Env`** — the Env contains many `UnsafeCell` types that aren't `UnwindSafe`. Replaced the panic-and-then-success test pattern with two separate tests (`#[should_panic]` for the panic case + happy-path test for the success case). Documented in `remove_route_*` tests in group7.
- **Free-function helpers in setup.rs** instead of methods on TestEnv — `count_events_with_topic` and `count_events_with_single_prefix` need to live outside the impl block because some tests construct standalone Envs (for fresh-env auth tests). Both helpers take `&Env` and `&Address` so they work in either context.
- **Two prefix flavors needed** — Phase 3 events (`flight_pool_manager`) use single-symbol prefixes (`["register"]`, `["buyer"]`); Phase 4/8/9 events use 2-symbol prefixes (`["route", "listed"]`, `["vault", "credited"]`, `["warn", "ttl_miss"]`). Hence two helpers, each tailored to one prefix style.
- **Test math corrected for `concurrent_underwriters_share_payout_burden`**: TMA decreases by `(payoff - premium) × buyers` on delayed/cancelled settlement, not `payoff × buyers`. The premium stays in the pool from the original buy; the vault only sends the difference.
- **Per-traveler `Vec` ordering preserved**: `get_flights_for_traveler` returns flights in insertion order (first buy → first entry). Test `traveler_index_across_multiple_flights` verifies this directly.
- **Snapshot 30-day expiry test uses both `timestamp` and `sequence_number` advancement**: Soroban's TTL only takes effect when the ledger sequence advances enough. Bumping just `timestamp` is insufficient; the test bumps `sequence_number += 30 * 24 * 60 * 12 + 1`.

---

## Completion Summary

**What was built:**
- Full rewrite of the `integration_tests/` crate — 8 test files, 68 tests, ~1,575 lines of test code. Setup fixture deploys all 5 contracts (gov, vault, oracle, FPM, controller) with `mock_all_auths_allowing_non_root_auth()` for the 3-deep auth chains the controller orchestrates. Six existing groups rewritten end-to-end; two new groups (`group7_governance`, `group8_events`) added.
- **`cargo test --workspace` green** for the first time since Phase 1. Stage 2 of the build-red window fully closed; no remaining workspace test failures.
- **228 total tests across the workspace passing** (controller 28 + flight_pool_manager 43 + governance_module 30 + integration_tests 68 + mock_usdc 6 + oracle_aggregator 29 + risk_vault 24).

**Key decisions locked in:**
- Test fixture uses `mock_all_auths_allowing_non_root_auth()` — mandatory for orchestrator tests with 3-deep contract auth chains. Documented as the standard for any test fixture deploying the controller.
- 6-group structure preserved + 2 new groups added (governance, events). Theme-based, not phase-based.
- `catch_unwind` is unusable on Soroban `Env` (`UnsafeCell` interior mutability breaks `UnwindSafe`) — split panic-and-success tests into separate `#[should_panic]` + happy-path tests.
- Two event-counting helper variants needed: 2-symbol-prefix (Phase 4/8/9 events) and 1-symbol-prefix (Phase 3 events). Both live as free functions in `setup.rs` so standalone-Env tests can reuse them.

**Files modified:**
- `contracts/integration_tests/src/tests/setup.rs` — full rewrite.
- `contracts/integration_tests/src/tests/group{1..6}_*.rs` — full rewrite of all 6 existing groups.
- `contracts/integration_tests/src/tests/mod.rs` — 2 new module declarations.
- `contracts/integration_tests/test_snapshots/tests/**/*.json` — auto-regenerated for all 68 tests.
- `spec/progress.md` — row 10 closed, Current Phase header reflects all-done state.

**Files created:**
- `contracts/integration_tests/src/tests/group7_governance.rs` — 8 new tests.
- `contracts/integration_tests/src/tests/group8_events.rs` — 6 new tests.
- 60+ new test snapshots.

**For the next phase to know:**
- **Phase 3 contract reorg is fully closed.** Every contract and every test is green. The system is ready for the next strategic move (executor / frontend / deploy / mainnet).
- Subsequent phases (Phase 11+ executor work, frontend, deploy) can build on a solid green workspace.
- The off-chain executor (Phase 11) needs to wire up:
  - Cron #1 (FlightDataFetcher) — calls oracle's `set_estimated_arrival` / `set_landed` / `set_cancelled`.
  - Cron #2 (FlightClassifier) — calls `controller.classify_flights(keeper)`.
  - Cron #3 (SettlementExecutor) — calls `controller.execute_settlements(keeper)`.
  - Cron #4 (TTL extender, Improvement #6) — `ExtendFootprintTTLOp` with footprint covering route / FlightConfig / FlightData / TravelerFlights / ClaimableBalance keys; address lists sourced from off-chain indexer (Improvement #9).
  - Permissionless `prune_settled` — natural fit for either Cron #3 or Cron #4.
- Off-chain indexer (Improvement #9) needs to consume `route.*` / `vault.*` events and feed Cron #4's footprint.
- Frontend can use `controller.get_flights_for_traveler(addr)` for MyPolicies (no off-chain indexer needed for that read).

**Known limitations / deferred items:**
- Executor + indexer + frontend are all out of scope for the contract reorg. Phase 3 was strictly contracts; Phase 11+ picks up the off-chain work.
- The `warn.ttl_miss` event has no consumer yet — Phase 11's TTL cron is the natural consumer.
- The `vault.*` events have no consumer yet — Phase 11's indexer.
- `Cargo.lock` left dirty per memory `feedback_cargo_lock` — let next build regenerate.
