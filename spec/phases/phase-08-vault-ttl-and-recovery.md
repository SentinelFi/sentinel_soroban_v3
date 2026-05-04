# Phase 8 — RiskVault TTL & Recovery

Status: complete
Started: 2026-05-03
Completed: 2026-05-03

---

## Goal

Two coupled TTL-hygiene improvements bundled in one phase, both edits live in
`contracts/risk_vault/src/lib.rs`:

1. **`ClaimableBalance(Address)` TTL + recovery (Improvement #3, HIGH severity).**
   Add 60-day TTL extension on every write to prevent silent archival of
   per-user pending USDC. Add a new owner-only `recover_uncollected` function
   (single function with `RecoveryMode { Recredit, Transfer }` enum) as the
   manual escape hatch if a balance archives anyway. Emit three new events
   (`vault.credited`, `vault.collected`, `vault.recovered`) so the off-chain
   indexer (Improvement #9) can maintain a list of addresses with non-zero
   balances — that list feeds the Phase 11 cron's secondary TTL defense
   (Cron #4 footprint, documented in Improvement #6).

2. **`SnapshotPrice(u64)` Persistent → Temporary (Improvement #7, LOW severity).**
   Daily share-price snapshots accumulate forever in Persistent today. Move
   them to Temporary with a 30-day TTL — recent snapshots stay queryable for
   on-chain reads, older ones expire cleanly with no archival rent. Off-chain
   historical analytics happen via events anyway.

This is a **medium-sized phase** — bigger than Phase 5 (smallest, ~17 lines)
but smaller than Phase 7 (largest, ~900 lines). Estimated diff: ~80–100
lines in `risk_vault/src/lib.rs` + ~150 lines of new tests +
~30-line architecture.md update.

After Phase 8 lands, only **Phase 10 (integration tests)** remains to close
`cargo test --workspace`.

## Dependencies

- **Phase 5 complete** — `VaultKey` enum already has Instance/Persistent
  tier-grouping comments. Phase 8 introduces a Temporary group.
- **No cross-contract dependencies.** Phase 8 is self-contained in
  `risk_vault`. Public API additions (`recover_uncollected`) are net-new;
  no existing consumers break.
- **No dependency on Phase 9.** Phase 9 already shipped the `warn.ttl_miss`
  event; Phase 8 ships the `vault.*` events. Both are independent on the
  contract side.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the Phase 8 commit at the end.
- `oz-stellar` — `risk_vault` already uses OZ `ownable` + `FungibleVault`.
  Skill loaded so the agent can sanity-check that the existing
  `#[only_owner]` pattern stays unchanged for the new `recover_uncollected`
  (no upgrade to RBAC needed).

### Docs to Fetch
- (Skip — in-repo precedent is authoritative. Phase 5 (tier flip + enum
  comments), Phase 6 (`Option<T>` field type + permissionless function),
  Phase 7 (mock_all_auths_allowing_non_root_auth for orchestrator tests)
  cover everything.)

### Project Files to Read
- `spec/dev_steps.md` Step 8 — canonical task list (extended this session
  with the three `vault.*` events spec).
- `spec/improvements.md` Improvement #3 (layered defense + events) and
  Improvement #7 (SnapshotPrice tier flip). Improvement #9 (indexer's
  `claimable_balances` table) for reference — Phase 8 just emits the
  events; the indexer is built later.
- `spec/architecture.md` `RiskVault` section — wire-format target. The
  section already mentions `recover_uncollected` (line ~169–171) but
  doesn't document its signature; Phase 8 adds the signature + events
  subsection.
- `contracts/risk_vault/src/lib.rs` — primary edit site (~450 lines after
  Phase 5). Key sites: `VaultKey` enum (Phase 5 added Instance/Persistent
  comments — extend with Temporary group), `process_withdrawal_queue`
  (credit + new TTL ext + new event), `collect()` (drain + new event),
  `snapshot()` (write — tier flip + new TTL ext), `get_snapshot_price()`
  (read — tier flip).
- `contracts/risk_vault/src/test.rs` — existing 14-test suite. New tests
  added alongside; existing tests should pass without modification (their
  pattern uses public API only).
- `contracts/governance_module/src/lib.rs`,
  `contracts/flight_pool_manager/src/lib.rs`, `contracts/oracle_aggregator/src/lib.rs` —
  reference for `#[contractevent]` event style (2-symbol prefix, indexed
  topics, `data_format = "single-value"` vs `"map"`).
- `contracts/controller/src/lib.rs` — Phase 9 added the `TtlMiss` event
  here; reference for the operational-warning category style (though
  Phase 8's `vault.*` events are domain events, not warnings — different
  topic prefix scheme).

## Pre-work Notes

> Decisions seeded from the planning conversation. Edit any line you disagree
> with before running `/start-phase 8`.

**Decisions confirmed by user:**

- **Q1a — single `recover_uncollected` function with `RecoveryMode` enum**
  (not two separate functions). Signature:
  ```rust
  #[contracttype]
  pub enum RecoveryMode { Recredit, Transfer }

  #[only_owner]
  pub fn recover_uncollected(
      e: &Env,
      user: Address,
      amount: i128,
      mode: RecoveryMode,
  );
  ```
  Single auth check, single audit surface. The `mode` enum is part of the
  `vault.recovered(addr, amount, mode)` event payload — wire format and
  function signature symmetric.
- **`recover_uncollected` SET semantics on Recredit** (not ADD). Owner
  reconstructs the full owed amount from event logs and writes it. If the
  user has a residual balance (rare — only if balance hadn't archived
  yet), SET overwrites; future `process_withdrawal_queue` credits ADD on
  top normally.

**Decisions clarified from spec / pre-decided (no input needed):**

- **TTL constants:**
  ```rust
  const CLAIMABLE_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12; // 1_036_800 — 60 days at 5s/ledger
  const SNAPSHOT_TTL_LEDGERS: u32 = 30 * 24 * 60 * 12;  // 518_400 — 30 days at 5s/ledger
  ```
- **3 new events** (already locked in `improvements.md` #3):
  - `vault.credited(addr, amount, new_balance)` — from `process_withdrawal_queue` after every credit.
  - `vault.collected(addr, amount)` — from `collect()` after the full drain.
  - `vault.recovered(addr, amount, mode)` — from `recover_uncollected`. `mode` carries the `RecoveryMode` enum value.
- **Event topic style:** 2-symbol prefix `["vault", <action>]` plus indexed `addr` topic. Matches Phase 4 `route.*` and Phase 6 `route.*` family. Distinct from controller's domain `["ctrl"]` events.
- **`VaultKey` enum tier-grouping comments** gain a Temporary group:
  ```rust
  pub enum VaultKey {
      // Instance — global single-row state
      Controller, TotalManagedAssets, LockedCapital, WithdrawalQueue, LastSnapshotTime,
      // Persistent — keyed multi-row state
      ClaimableBalance(Address),
      // Temporary — short-lived keyed state (auto-deletes on TTL expiry)
      SnapshotPrice(u64),
  }
  ```
- **SnapshotPrice migration concern:** N/A — pre-deployment phase. No live state to migrate.
- **`get_snapshot_price` semantics after Temporary:** unchanged on the surface — still returns `i128` with `.unwrap_or(0)`. Difference: expired entries naturally return None (= 0) instead of remaining at their original value. This is the *desired* behavior — old snapshots aren't supposed to be queryable after 30 days.
- **Test rewrite scope:** ADDITIVE only. Existing 14 tests should pass without modification — they use the public API and never touch storage tier directly. New tests add coverage for: ClaimableBalance TTL extension behavior + event emission, `recover_uncollected` happy paths (both modes) + auth panic, SnapshotPrice tier-flip round-trip + event-free snapshot.
- **Architecture.md update:** add an "Events emitted" subsection to the RiskVault section (parallel to Phase 9's Controller addition), and document the new `recover_uncollected` signature with the `RecoveryMode` enum.

**Implementation hints:**

- **`recover_uncollected` Recredit path** is essentially the same write pattern as `process_withdrawal_queue`'s credit step: SET the value + extend TTL. Reuse the TTL extension call. Emit `vault.recovered(user, amount, Recredit)` on success.
- **`recover_uncollected` Transfer path** does NOT touch `ClaimableBalance` storage at all — pure USDC transfer from vault to user, then emit `vault.recovered(user, amount, Transfer)`. The indexer's `vault.recovered(mode=transfer)` handler `DELETE`s the address from `claimable_balances` because the transfer presumably zeros their entitlement.
- **Auth on `recover_uncollected`:** use `#[only_owner]` decorator (matches `set_controller` pattern in `flight_pool_manager` post-Phase-3). No need for hand-rolled owner-check.
- **Event field naming consistency:** for `vault.credited`, `vault.collected`, `vault.recovered`, the address field should be named `addr` (or `user`?) consistently. Pick one and use throughout. Recommend `user` since `addr` is ambiguous.
- **`#[contractevent] data_format` choice:**
  - `vault.credited` has 2 non-topic fields (`amount`, `new_balance`) → `"map"`.
  - `vault.collected` has 1 non-topic field (`amount`) → `"single-value"`.
  - `vault.recovered` has 2 non-topic fields (`amount`, `mode`) → `"map"`.
- **Drop the redundant Persistent comment for `SnapshotPrice`** in the `VaultKey` enum — it's now Temporary.
- **Diff size estimate.** ~80–100 lines of lib.rs changes (event structs ~30, RecoveryMode enum ~5, recover_uncollected ~25, TTL extensions ~10, snapshot tier flip ~15, enum comment ~5). ~150 lines of new tests. ~30-line architecture.md update.

**Test plan additions (`risk_vault/src/test.rs`):**

- `test_claimable_balance_credited_event_fires` — process queue, assert event.
- `test_claimable_balance_collected_event_fires` — collect, assert event.
- `test_claimable_balance_ttl_extended_on_write` — write, verify TTL state via test-env introspection (or just functional via "doesn't archive after 30 days simulated").
- `test_recover_uncollected_recredit_sets_balance` — call with Recredit, assert ClaimableBalance is set + event fires.
- `test_recover_uncollected_transfer_moves_usdc` — call with Transfer, assert vault USDC balance decreases + user receives + event fires.
- `test_recover_uncollected_unauthorized` — non-owner calls → panics.
- `test_recover_uncollected_recredit_emits_correct_mode` — verify `mode = Recredit` on the event.
- `test_recover_uncollected_transfer_emits_correct_mode` — verify `mode = Transfer` on the event.
- `test_snapshot_uses_temporary_tier` — write snapshot, read it back within 30 days → returns price.
- `test_snapshot_expires_after_30_days` — write snapshot, fast-forward time past 30d, read → returns 0 (entry expired).
- `test_snapshot_no_event_emitted` — confirms snapshot doesn't emit any event (it's not in the indexer pipeline).

(~10–11 new tests, fitting the existing test-file style.)

**Phase rollover:**

- Per memory `feedback_phase_bundling`, the user runs `/start-phase 10`
  before `/complete-phase 8`. Don't block.
- Per memory `feedback_cargo_lock`, leave `Cargo.lock` dirty after
  destructive crate edits. None expected this phase (no crate adds/removes).
- After Phase 8: only Phase 10 (integration tests rewrite) remains to
  close `cargo test --workspace`. Phase 8 + Phase 10 can land in one
  branch / one commit theme ("close out the contract reorg").

---

## Subtasks

- [x] 1. **Add `RecoveryMode` enum** (`Recredit`, `Transfer`) with `#[contracttype]`. Place near other domain types in `risk_vault/src/lib.rs`.
- [x] 2. **Add three event structs** with `#[contractevent]`:
  - `Credited` — topics `["vault", "credited"]`, `#[topic] user`, data `amount` + `new_balance` (`map` format).
  - `Collected` — topics `["vault", "collected"]`, `#[topic] user`, data `amount` (`single-value` format).
  - `Recovered` — topics `["vault", "recovered"]`, `#[topic] user`, data `amount` + `mode: RecoveryMode` (`map` format).
- [x] 3. **Add TTL constants:** `CLAIMABLE_TTL_LEDGERS = 60 * 24 * 60 * 12` (60 days), `SNAPSHOT_TTL_LEDGERS = 30 * 24 * 60 * 12` (30 days). Place near existing TTL constants.
- [x] 4. **Update `VaultKey` enum tier-grouping comments**: move `SnapshotPrice(u64)` from the Persistent group into a new Temporary group (auto-deletes on TTL expiry). Instance and Persistent groups unchanged.
- [x] 5. **Modify `process_withdrawal_queue`**: after every `set(&VaultKey::ClaimableBalance(addr), &amount)`, call `extend_ttl(&VaultKey::ClaimableBalance(addr), CLAIMABLE_TTL_LEDGERS, CLAIMABLE_TTL_LEDGERS)` and emit `Credited { user: addr, amount: new_addition, new_balance: claimable + assets }`.
- [x] 6. **Modify `collect()`**: after the `usdc.transfer(...)` and `storage.persistent().remove(&key)`, emit `Collected { user: caller, amount: claimable }`.
- [x] 7. **Add `recover_uncollected(env, user, amount, mode)`** as `#[only_owner]`. Branch on `mode`:
  - `Recredit`: SET `ClaimableBalance(user) = amount`; extend TTL; emit `Recovered { user, amount, mode: Recredit }`.
  - `Transfer`: `usdc.transfer(vault, user, amount)`; no storage write; emit `Recovered { user, amount, mode: Transfer }`.
  - Assert `amount > 0` in both paths.
- [x] 8. **Modify `snapshot()`**: change `e.storage().persistent().set(&VaultKey::SnapshotPrice(day), &price)` to `e.storage().temporary().set(...)`, then call `extend_ttl(&VaultKey::SnapshotPrice(day), SNAPSHOT_TTL_LEDGERS, SNAPSHOT_TTL_LEDGERS)` on temporary storage. `LastSnapshotTime` (Instance) unchanged.
- [x] 9. **Modify `get_snapshot_price()`**: change `e.storage().persistent().get(...)` to `e.storage().temporary().get(...)`. The `.unwrap_or(0)` semantics stay — temporary entries return None (= 0) when expired or never written.
- [x] 10. **Add ~10 new tests** to `risk_vault/src/test.rs` per the test plan in Pre-work Notes. Existing 14 tests should pass unmodified — they use the public API only.
- [x] 11. **Update `architecture.md`** RiskVault section: add an "Events emitted" subsection (parallel to Phase 9's Controller addition) listing all three vault events with topic shapes; document the new `recover_uncollected` signature including the `RecoveryMode` enum; update the storage-tier table to mark `SnapshotPrice(u64)` as Temporary with the 30-day TTL; update `ClaimableBalance(Address)` row to mention 60-day TTL on writes + the 3-layer defense (on-write + Cron #4 secondary + recover_uncollected fallback).
- [x] 12. **Run gates.** `cargo build -p risk_vault` clean. `cargo test -p risk_vault` passes (existing 14 + ~10 new = ~24). Test snapshots auto-regenerate for any test that touches `ClaimableBalance` or `SnapshotPrice` storage layout — diff-inspect to confirm only structural changes (no behavioural drift).

### Gate

- `cargo build -p risk_vault` clean.
- `cargo test -p risk_vault` passes (~24/24 — 14 existing + ~10 new).
- `VaultKey` enum has Temporary group for `SnapshotPrice(u64)`.
- All three `vault.*` events fire with the documented topic + data shape (verified in unit tests).
- `recover_uncollected` is `#[only_owner]`-gated and supports both `RecoveryMode::Recredit` and `RecoveryMode::Transfer` paths.
- `architecture.md` RiskVault section reflects the new events, signature, and storage-tier table changes.
- `cargo test --workspace` STILL FAILS on `integration_tests` — that's expected, Phase 10 closes it.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-03

Starting phase. Lite prime complete. Context manifest loaded.

- **Skills loaded:** `git`, `oz-stellar`.
- **Docs to Fetch:** intentionally skipped per manifest — Phase 5/6/7/9 in-repo precedent is authoritative.
- **Project files read:** phase plan doc, full `risk_vault/src/lib.rs` (~452 lines), full `risk_vault/src/test.rs` (read in Phase 5 — 14 tests, public-API only, storage-tier-agnostic). `architecture.md` RiskVault section already in context.
- **Baseline confirmed:**
  - `VaultKey` enum at L8–21 has Phase 5's Instance/Persistent tier-grouping comments. Phase 8 adds Temporary group.
  - `process_withdrawal_queue` credit at L262–270 — no event today, no TTL extension.
  - `collect()` at L338–349 — no event today; drains via `usdc.transfer` + `storage.persistent().remove`.
  - `snapshot()` at L353–380 — writes `SnapshotPrice(day)` to persistent storage (line 374–376), no TTL extension.
  - `get_snapshot_price()` at L434–439 — reads from persistent storage.
  - No `recover_uncollected` exists yet — net-new function.
  - No event structs exist yet in this contract — net-new event surface.

**Implementation work (single session):**

- Subtasks 1–4 landed in one structural edit at the top of `risk_vault/src/lib.rs`: imports gained `contractevent`; `VaultKey` enum gained a new Temporary group with `SnapshotPrice(u64)` moved into it; new `RecoveryMode { Recredit, Transfer }` enum; three new event structs (`Credited`, `Collected`, `Recovered`) with the documented topic shapes; two new TTL constants (`CLAIMABLE_TTL_LEDGERS`, `SNAPSHOT_TTL_LEDGERS`) plus `INSTANCE_TTL_THRESHOLD`/`INSTANCE_TTL_EXTEND` (which I wired into the existing `extend_ttl` helper that was using literals).
- Subtask 5: `process_withdrawal_queue` credit block — after the persistent set, call `extend_ttl(CLAIMABLE_TTL_LEDGERS)` and publish `Credited { user, amount, new_balance }`. Refactored the local `claimable + assets` arithmetic into `new_balance` for both the storage write and the event payload.
- Subtask 6: `collect()` — after the persistent `remove`, publish `Collected { user, amount }`.
- Subtask 7: `recover_uncollected` added immediately after `collect()`. `#[only_owner]` decorator (matches the codebase pattern). `assert!(amount > 0)` guard in both paths. `Recredit` branch SETs the balance + extends TTL; `Transfer` branch directly transfers USDC. Single `Recovered { user, amount, mode }` publish at the end covers both paths.
- Subtask 8 + 9: `snapshot()` writes via `temporary()` + `extend_ttl(SNAPSHOT_TTL_LEDGERS)`; `get_snapshot_price()` reads via `temporary()`. `LastSnapshotTime` (Instance) untouched. Doc comments added explaining the tier rationale.
- Subtask 10: 10 new tests added at the end of `test.rs`. Hit the env.events() resets-per-invocation gotcha twice (Phases 4/9 precedent) — fixed by reordering the event check before any subsequent state read. All 24 tests pass (14 existing + 10 new).
- Subtask 11: architecture.md RiskVault section updated — `recover_uncollected` signature now includes `RecoveryMode` enum with both branches documented, storage-tier rationale rewritten with the 3-layer ClaimableBalance defense + SnapshotPrice expiry semantics, new "Events emitted" subsection added.

**Final gates — all green:**
- `cargo build -p risk_vault` ✓
- `cargo test -p risk_vault` ✓ (24/24 — 14 existing + 10 new)
- `VaultKey` enum has Temporary group for `SnapshotPrice(u64)` ✓
- All three `vault.*` events fire (verified in unit tests) ✓
- `recover_uncollected` `#[only_owner]`-gated, both `RecoveryMode` paths covered ✓
- `architecture.md` reflects new events + signature + tier table ✓
- `cargo test --workspace` still red on `integration_tests` — expected, Phase 10 closes it

All subtasks complete. Gate condition met. Ready for `/complete-phase 8`.

### Session 2026-05-03 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

**Modified:**
- `contracts/risk_vault/src/lib.rs` — `VaultKey` enum tier comments (Temporary group added); 3 event structs + `RecoveryMode` enum; 4 new constants (`INSTANCE_TTL_THRESHOLD/EXTEND` for the existing helper, `CLAIMABLE_TTL_LEDGERS`, `SNAPSHOT_TTL_LEDGERS`); `process_withdrawal_queue` TTL ext + `Credited` emit; `collect()` `Collected` emit; new `recover_uncollected(user, amount, mode)`; `snapshot()` Persistent → Temporary + TTL ext; `get_snapshot_price()` Persistent → Temporary; `extend_ttl()` rewired to use constants.
- `contracts/risk_vault/src/test.rs` — `Symbol` import; 10 new tests covering the event family, both `recover_uncollected` modes + auth + zero-amount panic, snapshot tier round-trip + 30-day expiry + no-event assertion.
- `contracts/risk_vault/test_snapshots/test/*.json` — auto-regenerated by test runner (existing test snapshots may shift due to event log changes; new ones for the 10 new tests).
- `spec/architecture.md` — RiskVault section: `recover_uncollected` signature with `RecoveryMode` enum + both-path docs; storage-tier rationale rewritten (3-layer ClaimableBalance defense + SnapshotPrice expiry semantics); new "Events emitted" subsection.
- `spec/phases/phase-08-vault-ttl-and-recovery.md` — work log, files modified, decisions, status `planned → in_progress`.
- `spec/progress.md` — row 8 status, Started date, Current Phase header.

**Created:**
- New test snapshots for the 10 new tests under `contracts/risk_vault/test_snapshots/test/`.

**Deleted:** nothing.

---

## Decisions Made

- **Q1a confirmed in code:** `recover_uncollected` is a single function with `RecoveryMode { Recredit, Transfer }` enum. Single `#[only_owner]` auth check; single `Recovered` event emit at the end of both paths. Mode-on-the-wire matches the indexer's expected event payload.
- **SET semantics on Recredit confirmed.** Implementation does `set(&key, &amount)`, not a read-modify-write add. Test `test_recover_uncollected_recredit_overwrites_existing` proves this — pre-existing balance gets replaced with the new amount.
- **`extend_ttl` helper modernized.** Replaced its hard-coded `120_960, 535_680` literals with the new `INSTANCE_TTL_THRESHOLD` / `INSTANCE_TTL_EXTEND` constants. Was a stylistic warning ("constant never used") but worth fixing while in the same file.
- **Test pattern reuse:** `count_events_with_topic` helper for vault tests mirrors the `count_events` helper from the governance test suite (Phase 4) — same shape (filter by 2-symbol topic prefix), local function rather than a shared utility because the test suites don't share a crate.
- **`env.events().all()` resets-per-invocation gotcha hit again** (3rd time in this phase plan: Phase 4 governance, Phase 9 controller, Phase 8 vault). Fix is mechanical reordering — assert events immediately after the emitting call before any state read. Documented in `project_codebase_patterns.md` from Phase 7.
- **`SnapshotPrice` semantics on Temporary:** `get_snapshot_price` continues to return `i128` (not `Option<i128>`) using `.unwrap_or(0)`. Expired entries return 0 — the test `test_snapshot_expires_after_30_days` confirms this is the desired behavior.
- **No `Snapshot` event emitted.** `snapshot()` writes to Temporary storage and emits no event. The indexer doesn't track snapshots (off-chain analytics use share-price reads via SDK). Test `test_snapshot_emits_no_event` asserts this stays the case.
- **All 14 existing risk_vault tests still pass without modification.** Phase 8 is purely additive at the public API level — new functions + new events; existing functions keep their signatures. The test fixture using `mock_all_auths()` (not the non-root variant) still works because risk_vault tests don't orchestrate 3-deep contract chains; Phase 7's mock_all_auths_allowing_non_root_auth requirement was specific to the controller.

---

## Completion Summary

**What was built:**
- Closed the **CRITICAL `ClaimableBalance` archival-rent risk** (Improvement #3) with a 3-layer defense: 60-day on-write TTL extension (live now), Phase 11 cron secondary defense (event-feed wired), and owner-only `recover_uncollected` manual fallback (live now).
- Added the `vault.credited` / `vault.collected` / `vault.recovered` event family, powering the off-chain indexer's `claimable_balances` table that the Phase 11 cron consumes.
- Flipped `SnapshotPrice(u64)` Persistent → Temporary with 30-day TTL (Improvement #7), eliminating archival rent on accumulating daily snapshots.

**Key decisions locked in:**
- `recover_uncollected(user, amount, mode: RecoveryMode)` — single function with `RecoveryMode { Recredit, Transfer }` enum. SET semantics on Recredit (not ADD).
- 2-symbol topic prefix `["vault", <action>]` + indexed `user` — matches the Phase 4 `route.*` family style.
- `data_format` per event: `Credited` and `Recovered` use `"map"` (multi-field); `Collected` uses `"single-value"` (one data field).
- `SnapshotPrice` reads return 0 (`unwrap_or(0)`) for expired entries — the desired behavior, not a bug.
- `extend_ttl` helper rewired to use the new `INSTANCE_TTL_THRESHOLD/EXTEND` constants instead of literal magic numbers.

**Files modified:**
- `contracts/risk_vault/src/lib.rs` — full surface: enum tier comments, RecoveryMode + 3 events + 4 constants, ClaimableBalance TTL ext + events on every state change, new recover_uncollected, SnapshotPrice tier flip.
- `contracts/risk_vault/src/test.rs` — 10 new tests + Symbol import + count_events helper.
- `contracts/risk_vault/test_snapshots/test/*.json` — 10 new snapshots; existing snapshots auto-regenerated where event log shape changed.
- `spec/architecture.md` — RiskVault section: signature update, 3-layer defense rationale, new "Events emitted" subsection.
- `spec/progress.md` — row 8 closed.

**For the next phase to know:**
- **Phase 10 (integration tests rewrite)** is the only remaining phase to close `cargo test --workspace`. After Phase 10, every workspace gate is green.
- Phase 10 needs to use `mock_all_auths_allowing_non_root_auth()` (from Phase 7) because integration tests orchestrate the full system — same 3-deep contract auth chain depth that controller tests had.
- Constructor changes from earlier phases break `integration_tests/src/tests/setup.rs` — Phase 10 fixes this to match the new 9-arg `Controller::__constructor` signature, drop `flight_pool` / `recovery_pool` references, and use the `FlightPoolManager` singleton.
- All `vault.*` events fire today; they're ready for the off-chain indexer (Improvement #9) to consume when that gets built (executor phase, after Phase 10).

**Known limitations / deferred items:**
- Phase 11 cron + indexer (off-chain executor work) consume the events but aren't built yet. The on-chain emission is in place; the consumer is future work.
- `cargo test --workspace` still fails on `integration_tests` until Phase 10.
- `Cargo.lock` not changed (no destructive crate edits).
