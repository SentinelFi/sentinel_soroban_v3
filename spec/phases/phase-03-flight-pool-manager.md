# Phase 3 — Add `contracts/flight_pool_manager/`

Status: complete
Started: 2026-05-02
Completed: 2026-05-02

---

## Goal

Build the `FlightPoolManager` singleton — one contract that holds every
flight's config, every buyer, all locked premiums, and the recovered-balance
accounting that previously lived in `RecoveryPool`. Replaces the deleted
`flight_pool/` and `recovery_pool/` (Phases 1 + 2). After this phase, the
workspace re-resolves: per-crate `cargo build -p <name>` works for everything
except `controller` and `integration_tests`, and `Cargo.lock` regenerates with
the orphan `flight_pool` / `recovery_pool` package entries gone (Stage 1 of
the build-red close — see `MEMORY` `project_phase3_contract_reorg`).

## Dependencies

- **Phase 1** complete — `flight_pool/` deleted.
- **Phase 2** complete — `recovery_pool/` deleted.

This phase touches three other contract crates' `Cargo.toml` files (not their
`.rs` files):

- `contracts/controller/Cargo.toml` — strip dead `flight_pool` /
  `recovery_pool` `path` deps; add `flight_pool_manager` dep.
- `contracts/integration_tests/Cargo.toml` — same strip + add.

The `.rs` rewires for those two crates are still owned by **Phase 7**
(controller) and **Phase 10** (integration_tests) and must NOT be touched
here.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the commit and for `git show HEAD~1:contracts/flight_pool/src/{lib,test}.rs` to recover the deleted reference (see Pre-work Notes).
- `oz-stellar` — to confirm that no OZ crate (e.g. `stellar-access::ownable`) supersedes the hand-rolled Owner/Admin pattern used by `governance_module` and `risk_vault`. Default decision is to match the existing in-repo pattern (see Pre-work Notes), but skill should be loaded so the agent can sanity-check.

### Docs to Fetch
- https://developers.stellar.org/docs/build/smart-contracts — Soroban contract patterns (storage tiers, auth, events, cross-contract clients).
- https://developers.stellar.org/docs/build/smart-contracts/example-contracts — example contracts for token transfer + state machine patterns.

### Project Files to Read
- `spec/dev_steps.md` — Step 3 (canonical task list, including the lockfile-cleanup addendum) and Step 7 / Step 10 Cargo.toml notes referencing this phase's pre-work.
- `spec/architecture.md` — full FlightPoolManager section (storage layout, function specs, USDC flow, payout math, storage-tier rationale) and Controller section (so the agent knows which functions Controller will call into).
- `spec/improvements.md` — Improvement #1 (motivation + per-contract impact).
- `contracts/Cargo.toml` — workspace `members` (this phase adds `flight_pool_manager`).
- `contracts/governance_module/src/lib.rs` + `Cargo.toml` — reference for Owner / Admin auth pattern (the simple `owner.require_auth()` + stored-equality check).
- `contracts/risk_vault/src/lib.rs` + `Cargo.toml` — reference for Controller-only auth, USDC `TokenClient` usage, internal client patterns. Critically: `record_premium_income` is the function FlightPoolManager calls during `settle_on_time`.
- `contracts/oracle_aggregator/src/lib.rs` — reference for state-machine + persistent-storage-keyed-by-tuple patterns (closely analogous to `FlightConfig(Symbol, u64)` + status transitions).
- `contracts/controller/Cargo.toml` — to be edited for the cross-phase strip.
- `contracts/integration_tests/Cargo.toml` — to be edited for the cross-phase strip.

## Pre-work Notes

> Decisions already made and seeded below. Edit any line you disagree with
> before running `/start-phase 3`.

**Decisions confirmed by user:**

- **`claimed_count` placement** — field on `FlightConfig`, NOT a separate persistent key. Incremented inside `claim()` (which already loads `FlightConfig` for status / payoff / claim_expiry checks, so the extra write is essentially free). Read inside `sweep_expired()` for the `payoff × (buyer_count − claimed_count)` computation.
- **Test suite scope** — comprehensive from scratch (~25 tests). Mirrors the lifecycle coverage of the deleted `flight_pool/src/test.rs` (recoverable via `git show HEAD~1:contracts/flight_pool/src/test.rs`) plus new tests for the recovery surface (`withdraw_recovered`, `RecoveredBalance` reads, `sweep_expired` + double-sweep guard).
- **`Owner` key** — `PoolKey::Owner` in Instance storage, owner-auth via `owner.require_auth()` + stored-equality assertion. Match `governance_module` / `risk_vault` pattern. Do NOT introduce `stellar-access::ownable` here unless `oz-stellar` skill confirms it is the codebase standard (it is not, as of Phase 2 close).

**Decision required at implementation time (architecture has a gap):**

- **`Buyer` key TTL at `add_buyer` time.** Architecture's storage-tier table says "TTL set to `claim_expiry + 30 days` on write — no cron needed", but `add_buyer` runs *before* `settle_*` sets `claim_expiry`, so at write time `claim_expiry` is unknown. Recommended fix: at `add_buyer`, set `Buyer` TTL to a fixed conservative constant — **180 days** — sufficient to outlast the worst case of (90-day flight book-ahead + 60-day claim window + 30-day safety). Do NOT attempt to re-extend Buyer TTL after settlement (that would require iterating buyers, which is the thing the protocol avoids). Document the 180-day choice as a code comment on the constant.

**Other implementation hints:**

- **`sweep_expired` double-sweep guard.** After computing `unclaimed = payoff × (buyer_count − claimed_count)` and crediting `RecoveredBalance`, set `claimed_count = buyer_count` on `FlightConfig` so subsequent `sweep_expired` calls compute `unclaimed = 0`. No separate `Swept` boolean key needed.
- **`settle_on_time` with zero buyers.** If `buyer_count == 0`, `premium × buyer_count = 0`. Skip the `record_premium_income` call entirely (don't transfer 0). The status flip + `ActiveFlightList` prune still happens.
- **Settlement does NOT pull funds from RiskVault.** For `settle_delayed` / `settle_cancelled`, FlightPoolManager only flips status + records `claim_expiry` + prunes the active list. The Controller separately calls `RiskVault.send_payout(...)` targeted at FlightPoolManager (per `architecture.md` Controller section). FlightPoolManager just trusts the USDC will be there when `claim()` runs.
- **Events.** Mirror the deleted `flight_pool` event coverage: `register`, `add_buyer`, `settle_on_time`, `settle_delayed`, `settle_cancelled`, `claim`, `sweep`, `withdraw_recovered`. Use the same `(symbol, symbol)` topic style + structured data tuple as the existing in-repo contracts (governance_module / risk_vault are good references).
- **No OZ vault / token integration.** FlightPoolManager doesn't issue shares or wrap tokens; it just calls a USDC `TokenClient` for transfers. The `oz-stellar` skill is loaded only as a sanity check on the auth pattern.

**Build-red status during this phase:**

- Workspace cannot resolve at the *start* of the phase (Phases 1+2 left orphan path-deps in `controller/` and `integration_tests/` Cargo.toml). The strip step (subtask 13) is what makes the workspace resolve again — do NOT try to run `cargo build -p flight_pool_manager` before subtask 13 succeeds; it will cascade-fail through controller's manifest.
- After subtask 13: per-crate `cargo build -p <name>` works for everything except controller and integration_tests. Whole-workspace `cargo build` (no `-p`) still fails — closes at Phases 7 + 10.

**Phase rollover:**

- The user is bundling Phases 1–3 into one branch / one merge. Don't volunteer a `/commit` between subtasks; let the user batch it at the end.

---

## Subtasks

- [x] 1. **Read reference patterns.** Inspected `governance_module/src/lib.rs`, `risk_vault/src/lib.rs`, `oracle_aggregator/src/lib.rs` (+ `test.rs`), `mock_usdc/src/lib.rs`, plus `controller/Cargo.toml` and `integration_tests/Cargo.toml` (for the strip) and `integration_tests/src/tests/setup.rs` (for the cross-contract client pattern). Skipped `git show HEAD~1:contracts/flight_pool/...` — the in-repo references gave full coverage. Confirmed: OZ stellar-access ownable IS the codebase standard; oracle_aggregator is the closest structural template.

- [x] 2. **Create crate skeleton.** `contracts/flight_pool_manager/Cargo.toml`, `src/lib.rs`, `src/test.rs` created. Added `flight_pool_manager` to `[workspace] members` between `oracle_aggregator` and `controller`. Cargo.toml carries `risk_vault` as a regular dep (for the auto-gen client) and `mock_usdc` as a dev-dep (for tests).

- [x] 3. **Implement storage types.** `PoolKey` enum, `FlightConfig` struct (with `claimed_count: u32`), `SettlementStatus` enum all in lib.rs. `#[contracttype]` derives applied.

- [x] 4. **Implement `__constructor` and `set_controller`.** Constructor sets `Owner` (via OZ `ownable::set_owner`), `UsdcToken`, `RiskVault`, initializes `RecoveredBalance: 0`. `set_controller` is `#[only_owner]` + one-time-write assertion, matching `risk_vault` and `oracle_aggregator` patterns.

- [x] 5. **Implement `register_flight` and `add_buyer`.** `register_flight` writes `FlightConfig` with `status: Active, buyer_count: 0, claimed_count: 0, claim_expiry: 0` and appends to `ActiveFlightList`. `add_buyer` panics on duplicate, increments `buyer_count`, sets Buyer TTL to `BUYER_TTL_LEDGERS = 3_110_400` (180 days) with a code comment explaining the choice.

- [x] 6. **Implement settlement entry points.** All three controller-auth + status-must-be-Active + prune from list. `settle_on_time` transfers `premium × buyer_count` USDC to vault then calls `vault.record_premium_income(controller, total_premium)` — passing the controller's address (not the pool's own) so the vault's auth assertion passes. `settle_delayed` / `settle_cancelled` share an internal helper `settle_with_claim_window`.

- [x] 7. **Implement `claim`.** Traveler-auth, full status + expiry + policy + double-claim guards, increments `claimed_count`, transfers `payoff`.

- [x] 8. **Implement `sweep_expired`.** Public, status + expiry guards, `unclaimed = payoff × (buyer_count − claimed_count)` formula, idempotent re-entry by setting `claimed_count = buyer_count` after first sweep (no separate `Swept` flag).

- [x] 9. **Implement `withdraw_recovered`.** `#[only_owner]`, balance-floor assertion, transfers USDC to `ownable::get_owner()`. (`amount > 0` guard added too.)

- [x] 10. **Implement read functions.** `get_flight_config` (panics on missing per oracle's "expect" pattern), `has_policy`, `has_claimed`, `get_active_flights`, `get_recovered_balance`. Bonus reads: `get_controller`, `get_usdc_token`, `get_risk_vault`.

- [x] 11. **Wire events.** Six event types via `#[contractevent]`. Two data-format groups: `single-value` (1 data field — BuyerAdded, ExpiredSwept, RecoveredWithdrawn) and `map` (multi-field — FlightRegistered, FlightSettled, PayoutClaimed). Single-string topic prefix per event (`register`, `buyer`, `settle`, `claim`, `sweep`, `withdraw`); `flight_id` + `date` (or `owner` for withdraw) as `#[topic]` fields.

- [x] 12. **Write the comprehensive test suite.** 43 tests in `src/test.rs`, covering all paths in the original plan (init, register, add_buyer, settle_on_time/delayed/cancelled, claim, sweep_expired, withdraw_recovered, read functions, event spot checks). Bumped beyond the ~25 estimate because edge cases naturally produced more tests (e.g. on_time + claim, settle_delayed_past_expiry, etc.).

- [x] 13. **Cross-phase Cargo.toml strip.** `controller/Cargo.toml`: removed `flight_pool` + `recovery_pool` `path` deps from `[dev-dependencies]`, added `flight_pool_manager`. Same edit in `integration_tests/Cargo.toml`. No `.rs` files touched.

- [x] 14. **Lockfile regen.** Auto-regenerated when `cargo build -p flight_pool_manager` ran. Verification: 191 `[[package]]` entries total, **0** named `flight_pool`, **0** named `recovery_pool`, **1** named `flight_pool_manager`, **0** dependency lines referencing the deleted crates.

- [x] 15. **Build + test verification.** `cargo build -p flight_pool_manager` clean. `cargo test -p flight_pool_manager` → **43 passed; 0 failed**. Bonus: whole-workspace `cargo build` (no `-p`) actually succeeds — the deleted-crate references in controller/integration_tests are inside test modules / dev-deps so non-test builds skip them. `cargo test --workspace` correctly fails on `controller/src/test.rs` + `integration_tests/src/tests/setup.rs` (Phase 7 / Phase 10's territory).

### Gate

All four must hold:

1. `contracts/flight_pool_manager/` exists with `Cargo.toml`, `src/lib.rs`, `src/test.rs`, and is registered in `contracts/Cargo.toml` `[workspace] members`.
2. `cargo build -p flight_pool_manager` succeeds; `cargo test -p flight_pool_manager` runs the comprehensive test suite (~25 tests) all green.
3. `Cargo.lock` regenerated — no `flight_pool` or `recovery_pool` package entries; no `dependencies` lists reference them.
4. `controller/Cargo.toml` and `integration_tests/Cargo.toml` have the strip + add applied; their `.rs` files are unchanged from the post-Phase-2 state.

The whole-workspace `cargo build` failure is expected and out of scope — it remains the gate for Phases 7 + 10.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-02

Starting phase. Lite prime + manifest loaded.
- Skills loaded: `git` (deferred to bundle commit), `oz-stellar` (sanity check — confirmed in-repo standard IS OZ stellar-access via reading governance_module + risk_vault + oracle_aggregator + mock_usdc; preferences.md was right).
- Project files read: `spec/phases/phase-03-flight-pool-manager.md` (status confirmed `planned`), `contracts/risk_vault/src/lib.rs`, `contracts/governance_module/src/lib.rs`, `contracts/oracle_aggregator/src/lib.rs`, `contracts/oracle_aggregator/src/test.rs` (test pattern), `contracts/mock_usdc/src/lib.rs`, `contracts/risk_vault/Cargo.toml`, `contracts/oracle_aggregator/Cargo.toml`, `contracts/controller/Cargo.toml` (for the strip), `contracts/integration_tests/Cargo.toml` (for the strip), `contracts/integration_tests/src/tests/setup.rs` (for the cross-contract client pattern).
- Web docs: skipped initial WebFetch — in-repo references give complete patterns; will fetch only if a specific Soroban API needs verification.
- **Pattern decisions confirmed from reference contracts:**
  - OZ ownable: `use stellar_access::ownable::{self as ownable, Ownable}` + `use stellar_macros::only_owner` + `#[only_owner]` on owner-only fns + `ownable::set_owner(e, &owner)` in `__constructor` + `impl Ownable for X {}`.
  - Hand-rolled `require_controller(e, &caller)` helper for controller-only fns (matches risk_vault + oracle_aggregator).
  - TTL constants module-level: `PERSISTENT_TTL_THRESHOLD: u32 = 120_960`, `PERSISTENT_TTL_EXTEND: u32 = 535_680`. Plus a new `BUYER_TTL_LEDGERS: u32 = 3_110_400` (180 days at 5s/ledger) per Pre-work Notes.
  - Events via `#[contractevent(topics = [...], data_format = "single-value")]` struct + `.publish(e)` (matches oracle_aggregator).
  - Cross-contract calls via auto-generated client from a `path` dep: `risk_vault::RiskVaultClient::new(e, &vault_addr)` (confirmed in `integration_tests/src/tests/setup.rs`). So `flight_pool_manager/Cargo.toml` will declare `risk_vault = { path = "../risk_vault" }` as a regular dep.
  - Storage tier: `instance()` for global, `persistent()` for keyed. Errors: `assert!(cond, "msg")` style.
- Phase 1 + Phase 2 already complete; workspace `members` is `[mock_usdc, governance_module, risk_vault, oracle_aggregator, controller, integration_tests]`. Phase 3 will add `flight_pool_manager` to that list.

**Issues hit during implementation (and resolved):**

1. **`#[contractevent]` data_format error.** Initial draft used `data_format = "single-value"` on events with multiple non-topic data fields; soroban-sdk-macros panicked with a confusing "found keyword self" error. Resolution: looked at the macro source (`~/.cargo/registry/.../soroban-sdk-macros-23.5.3/src/derive_event.rs`); valid values are `"single-value"`, `"vec"`, `"map"`. Switched the three multi-data events (FlightRegistered, FlightSettled, PayoutClaimed) to `"map"`; the others stayed `"single-value"`.

2. **Topics array can have multiple elements only when each is a literal string Symbol.** Initially used `topics = ["pool", "register"]` to namespace events under a "pool" prefix; this also produced the macro error. Switched to single-string topics (`["register"]`, `["buyer"]`, etc.). The `flight_id` and `date` fields carry the per-event identity via `#[topic]` so the namespace prefix wasn't load-bearing.

3. **Cross-contract auth on `vault.record_premium_income`.** First draft passed `&e.current_contract_address()` (the pool's own address) as the controller arg; the vault's `assert!(controller == stored_controller)` failed because the vault stores the test's controller address. Fix: forward the original `controller: Address` arg from `settle_on_time` straight through to the vault. Auth propagates correctly because the controller's auth is already required at the pool's entry. Added a code comment on the call site explaining the indirection.

4. **Test compile errors on event introspection.** Three issues: (a) needed `use soroban_sdk::IntoVal` to call `into_val()` on Symbol; (b) Soroban `Vec` doesn't impl `FromIterator`, so `.collect::<Vec<_>>()` failed — replaced with manual `count` loop; (c) Soroban `Val` doesn't impl `PartialEq`, so comparing `topics.get(0) == Some(symbol_val)` fails — converted topic Vals back to `Symbol` via `Symbol::try_from_val(...)` and compared the resulting Symbols.

All four issues are pure Soroban-SDK 23 quirks; none required changing the contract design.

### Session 2026-05-02 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

> Populated by the agent during work.

**Created:**
- `contracts/flight_pool_manager/Cargo.toml`
- `contracts/flight_pool_manager/src/lib.rs` (~430 lines: storage types, 6 event structs, 17 contract methods + helpers)
- `contracts/flight_pool_manager/src/test.rs` (~700 lines: 43 tests)
- 43 test snapshots auto-generated under `contracts/flight_pool_manager/test_snapshots/test/*.json`

**Modified:**
- `contracts/Cargo.toml` — added `"flight_pool_manager"` to `[workspace] members`
- `contracts/controller/Cargo.toml` — `[dev-dependencies]`: removed `flight_pool` + `recovery_pool`, added `flight_pool_manager`
- `contracts/integration_tests/Cargo.toml` — `[dev-dependencies]`: same strip + add
- `contracts/Cargo.lock` — auto-regenerated; orphan `flight_pool` + `recovery_pool` package entries dropped, `flight_pool_manager` entry added
- `spec/progress.md` — Phase 3 row → `in_progress`, Current Phase pointer
- `spec/phases/phase-03-flight-pool-manager.md` — status flip + Work Log + this section + Decisions

**Intentionally not modified:**
- All `.rs` files in `controller/` and `integration_tests/` — Phase 7 / Phase 10 territory.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

- **`claimed_count` lives on `FlightConfig`** (per Pre-work Notes Decision A). No separate `ClaimedCount(Symbol, u64)` key — incremented in `claim()` (which already loads/saves `FlightConfig` for status / payoff / claim_expiry checks).
- **Buyer key TTL = 180 days = 3,110,400 ledgers** at `add_buyer` time. Architecture's "claim_expiry + 30d" wording is unreachable because `add_buyer` runs before `claim_expiry` is set; 180d covers the worst-case 90d flight book-ahead + 60d claim window + 30d safety. No re-extension needed (we cannot iterate buyers post-settlement). Documented as a code comment on the `BUYER_TTL_LEDGERS` constant.
- **`sweep_expired` double-sweep guard via setting `claimed_count = buyer_count`** after first sweep. Idempotent — subsequent calls compute `unclaimed = 0` and return. No separate `Swept` boolean key.
- **`settle_on_time` with zero buyers does NOT touch the vault.** No transfer, no `record_premium_income` call. Status flip + ActiveFlightList prune still happen.
- **`record_premium_income` is invoked with the original `controller` address** (forwarded from `settle_on_time`'s arg), not `e.current_contract_address()`. The vault's controller-auth assertion checks against its stored controller (the actual Controller contract), not against the calling pool. Auth propagates correctly through the cross-contract call chain.
- **OZ `stellar-access::ownable` is the codebase standard for `Owner` access control.** Confirmed by reading governance_module + risk_vault + oracle_aggregator + mock_usdc — all four use it. `#[only_owner]` macro on `set_controller` and `withdraw_recovered`. `impl Ownable for FlightPoolManager {}` at the bottom of the file. preferences.md's "always use OZ when available" applies here.
- **Cross-contract calls use auto-generated client from `path` dep.** `flight_pool_manager/Cargo.toml` declares `risk_vault = { path = "../risk_vault" }` as a regular dep; lib.rs uses `risk_vault::RiskVaultClient::new(e, &vault_addr)`. Same pattern as `integration_tests/src/tests/setup.rs`.
- **Event format split: `single-value` + `map`.** Soroban-SDK 23's `#[contractevent]` requires `data_format = "single-value"` for events with one non-topic field, `"map"` (or `"vec"`) for multiple. Three events use `map` (FlightRegistered, FlightSettled, PayoutClaimed); three use `single-value` (BuyerAdded, ExpiredSwept, RecoveredWithdrawn).

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.

**Built:** `contracts/flight_pool_manager/` — singleton contract that absorbs the deleted `flight_pool/` (per-flight buyer accounting, settlement, claim) and `recovery_pool/` (sweep + RecoveredBalance + owner withdraw) surface. ~430 lines of Rust + 700 lines of tests + 43 auto-generated test snapshots. All 43 tests green.

**Stage 1 of the build-red close is complete.** The cross-phase Cargo.toml strip (controller + integration_tests dev-deps swapped from `flight_pool` / `recovery_pool` to `flight_pool_manager`) re-resolves the workspace; `Cargo.lock` regenerated with no orphan entries. Per-crate `cargo build -p <name>` and `cargo build` (no -p) both work. `cargo test --workspace` still fails on `controller/src/test.rs` and `integration_tests/src/tests/setup.rs` — those are Phase 7 and Phase 10's territory and remain Stage 2 of the build-red close.

**Key decisions locked in** (full list in Decisions Made):

- `claimed_count` is a field on `FlightConfig` (not a separate key).
- Buyer key TTL is a fixed 180-day constant (180 days at 5s/ledger = 3,110,400 ledgers); no per-settlement re-extension because the contract cannot iterate buyers.
- `sweep_expired` is idempotent via `claimed_count = buyer_count` after first sweep — no separate `Swept` flag.
- `settle_on_time` with zero buyers does not touch the vault.
- Cross-contract auth: when calling `vault.record_premium_income`, FlightPoolManager forwards the original `controller: Address` arg, not its own contract address. The vault's stored controller is the actual Controller contract; the auth check passes because controller's auth propagates through the cross-contract call chain.
- OZ `stellar-access::ownable` confirmed as the codebase standard (matches governance, vault, oracle, mock_usdc).
- Soroban-SDK 23 `#[contractevent]`: `data_format = "map"` for events with multiple non-topic data fields, `"single-value"` for one. Topics array must be single-string prefixes (multi-element fails to compile).

**Files created or modified (final):**
- Created: `contracts/flight_pool_manager/Cargo.toml`, `src/lib.rs`, `src/test.rs`, plus 43 test snapshot JSONs.
- Modified: `contracts/Cargo.toml` (workspace member added), `contracts/controller/Cargo.toml` (dev-dep strip + add), `contracts/integration_tests/Cargo.toml` (same), `contracts/Cargo.lock` (auto-regenerated), `spec/progress.md`, this phase file.
- Intentionally not modified: any `.rs` file in `controller/` or `integration_tests/` — those are Phase 7 / Phase 10 territory.

**Heads-up for next phase (Phase 4 — governance routes Persistent → Instance):**
- Workspace is now buildable per-crate. `cargo build -p governance_module` and `cargo test -p governance_module` will work end-to-end.
- The relevant existing test file is `governance_module/src/test.rs`. Storage-tier change is a mechanical grep-and-replace — switch every `storage().persistent()` call site that touches `DataKey::Route(...)` or `DataKey::RouteList` to `storage().instance()`.

**Known limitations / deferred:**
- `cargo test --workspace` still fails on dead `flight_pool` / `recovery_pool` imports in controller/integration_tests test files. Closes at Phase 7 and Phase 10.
