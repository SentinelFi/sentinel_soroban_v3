# Phase 5 — RiskVault `WithdrawalQueue` — Persistent → Instance

Status: complete
Started: 2026-05-03
Completed: 2026-05-03

---

## Goal

Move `VaultKey::WithdrawalQueue` from Persistent to Instance storage in
`risk_vault/src/lib.rs`. The queue is a single-row global FIFO of pending
underwriter withdrawal requests — shared state, not user-scoped — so it
belongs in Instance, not Persistent. The current Persistent placement
exposes a critical-path archival rent risk: if no underwriter activity
touches the queue's TTL window for ~30+ days, the entry archives and the
next `request_withdrawal` / `process_withdrawal_queue` / `cancel_withdrawal`
call fails with a restore-required error, freezing the entire underwriter
exit path until someone (likely the protocol) lands a restore tx. Instance
storage auto-extends with every `risk_vault` invocation (snapshot cron,
settlement cron, occasional underwriter ops), so the queue effectively
never lapses without bespoke cron coverage.

This is the smallest phase by far: ~7 access-site replacements + 3 enum
tier-grouping comments. Pure storage-tier hygiene with no API change, no
behaviour change, and no test changes expected. **CRITICAL severity per
`improvements.md` #2** — the fix is trivial; the bug it removes is not.

## Dependencies

- **Phase 4 complete** — workspace per-crate builds clean (`cargo build -p risk_vault` is
  green today; this phase only touches `risk_vault`).
- No new contract dependencies. No cross-crate edits.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the Phase 5 commit at the end.

### Docs to Fetch
- (Skip — in-repo precedent is stronger than external docs for this change.
  `flight_pool_manager` and `oracle_aggregator` already use `instance()` for
  global single-row state; mirror that pattern.)

### Project Files to Read
- `spec/dev_steps.md` Step 5 — canonical task list and verification block.
- `spec/improvements.md` Improvement #2 — motivation + severity rating.
- `spec/architecture.md` RiskVault section — already states the queue lives
  in Instance (this phase brings code into alignment with the doc, not the
  reverse).
- `contracts/risk_vault/src/lib.rs` — current implementation. 7 access sites
  to flip (4 reads + 3 writes — see Pre-work Notes for line numbers).
- `contracts/risk_vault/src/test.rs` — verify storage-tier-agnostic
  (~10 queue-API calls; uses public API only, never touches `persistent()`
  / `instance()` directly).
- `contracts/flight_pool_manager/src/lib.rs` — reference for the enum
  tier-grouping comment style (Instance / Persistent / Temporary section
  headers in `PoolKey`).

## Pre-work Notes

> Decisions seeded from the planning conversation. Edit any line you disagree
> with before running `/start-phase 5`.

**Decisions clarified from spec (no user input needed):**

- **Architecture.md is already correct** — line ~159 says the queue is
  stored in Instance. This phase brings code into alignment with the doc.
  No `architecture.md` edit needed.
- **Public API is unchanged** — `request_withdrawal`, `cancel_withdrawal`,
  `process_withdrawal_queue`, `get_withdrawal_queue`, `collect` keep the
  same signatures. Storage tier is invisible at the API level.
- **Existing tests are storage-tier-agnostic** — verified by grep:
  `risk_vault/src/test.rs` calls the public queue API ~10 times, never
  touches `persistent()` / `instance()` directly. Should pass without
  modification.
- **No manual `WithdrawalQueue` TTL extension exists today** — confirmed
  by grep. The generic `extend_ttl(e)` cron helper at lib.rs:382 only
  extends instance TTL globally. So dev_steps' "drop any manual extend_ttl
  for this key" subtask is a no-op (nothing to drop).
- **Enum tier-grouping comments — adopt the FlightPoolManager pattern.**
  `risk_vault::VaultKey` currently has no tier comments. Add
  Instance / Persistent / Temporary section headers like
  `flight_pool_manager::PoolKey` so future readers see at a glance which
  tier each variant lives in. Final layout after Phase 5:
  ```rust
  pub enum VaultKey {
      // Instance — global single-row state
      Controller,
      TotalManagedAssets,
      LockedCapital,
      WithdrawalQueue,        // moved here in Phase 5
      LastSnapshotTime,

      // Persistent — keyed multi-row state
      ClaimableBalance(Address),

      // Persistent — keyed by day (Phase 8 will move this to Temporary)
      SnapshotPrice(u64),
  }
  ```
  Note: `SnapshotPrice` is still Persistent at this point. Phase 8 moves
  it to Temporary; do NOT do that move here.

**Access sites to flip (`storage().persistent()` → `storage().instance()`):**

Verified by grep against `risk_vault/src/lib.rs`. All seven are simple
in-place replacements:
- Line 232–236 — read in `process_withdrawal_queue`
- Line 279–281 — write in `process_withdrawal_queue`
- Line 297–301 — read in `request_withdrawal`
- Line 309–311 — write in `request_withdrawal`
- Line 317–321 — read in `cancel_withdrawal`
- Line 330–332 — write in `cancel_withdrawal`
- Line 417–421 — read in `get_withdrawal_queue` query

(Line numbers as of Phase 4 close — may drift by a line or two depending
on intervening edits. The grep at start time is authoritative.)

**Implementation hints:**

- **Diff size.** ~7 line edits + 3 enum-comment lines = ~10-line diff.
  Smallest phase in the entire plan.
- **No new constants.** Don't introduce a tier-specific TTL constant for
  the queue — Instance auto-extends with the contract instance via the
  existing `extend_ttl(e)` cron helper. There's nothing to tune.
- **Test snapshots may need regeneration.** Existing test snapshots in
  `risk_vault/test_snapshots/` may include the queue's storage tier as
  part of the recorded state. If tests fail with snapshot mismatches,
  that's expected — re-record by running `cargo test` and committing the
  diffs. Do NOT manually edit the snapshot JSONs.
- **Sanity-check `total_managed_assets` interaction.** Looking at lib.rs:283
  — `process_withdrawal_queue` already writes `TotalManagedAssets` via
  `storage().instance()` on the same path that writes `WithdrawalQueue`.
  After this phase both are Instance, so they ride the same TTL. No
  ordering concern.

**Phase rollover:**

- Per memory `feedback_phase_bundling`, the user runs `/start-phase 6`
  before `/complete-phase 5`. Don't block.
- Per memory `feedback_cargo_lock`, leave `Cargo.lock` dirty after
  destructive crate edits. None expected this phase.
- This phase is small enough that bundling its commit with Phase 6
  (Oracle `ActiveFlightList` Persistent → Instance + prune) is a
  reasonable option — both are storage-tier migrations on the same
  theme. The user decides at commit time.

---

## Subtasks

- [x] 1. Grep `risk_vault/src/lib.rs` for `WithdrawalQueue`. Replace every `e.storage().persistent()` access (`.get`, `.set`, `.has`) with `e.storage().instance()` at the seven sites listed in Pre-work Notes. No other code changes.
- [x] 2. Confirm there is no manual `extend_ttl` call keyed on `VaultKey::WithdrawalQueue`. (Verified absent during planning; reconfirm in code at start time.)
- [x] 3. Update the `VaultKey` enum to add Instance / Persistent tier-grouping comments matching the `flight_pool_manager::PoolKey` style. Move `WithdrawalQueue` into the Instance group; leave `SnapshotPrice` in the Persistent group (Phase 8 moves it to Temporary, not now).
- [x] 4. Run `cargo build -p risk_vault` — must be clean.
- [x] 5. Run `cargo test -p risk_vault` — all queue-related tests must pass without modification (they use the public API only). If snapshot diffs appear, re-record and confirm the diffs only reflect the tier change.

### Gate

- `cargo build -p risk_vault` clean.
- `cargo test -p risk_vault` passes (all existing tests, no test code changes).
- `VaultKey` enum has tier-grouping comments matching the codebase pattern.
- No manual `WithdrawalQueue` TTL extension calls remain (confirmed absent at planning).
- `architecture.md` RiskVault section unchanged (already in sync).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-03

Starting phase. Lite prime complete. Context manifest loaded.

- **Skills loaded:** `git`.
- **Docs to Fetch:** intentionally skipped per manifest — in-repo precedent (`flight_pool_manager`, `oracle_aggregator`) is the authoritative reference for Instance-tier patterns.
- **Project files read:** `architecture.md` (full), `dev_steps.md` Step 5, `improvements.md` #2, `risk_vault/src/{lib,test}.rs`, plus the Phase 5 plan doc.
- **Baseline confirmed:** 7 `WithdrawalQueue` access sites all in `persistent()`; `VaultKey` enum has no tier comments; no manual TTL extension keyed on `WithdrawalQueue`; tests use public API only (12 tests, storage-tier-agnostic).
- **Gate readiness:** `cargo build -p risk_vault` is clean today (verified during planning). Target: same after edits, plus all tests still pass.

**Implementation work (single session):**

- Subtask 1: 7 access sites flipped from `persistent()` to `instance()` via three Edit calls (4 reads at 12-space indent in one `replace_all`; 2 writes at 12-space indent in another `replace_all`; the one 16-space write inside `process_withdrawal_queue`'s `if processed > 0` block as a single edit). Grep verified: zero remaining `persistent()` calls referencing `WithdrawalQueue`.
- Subtask 2: confirmed no-op. Only `extend_ttl` reference in lib.rs is the generic `extend_ttl(e)` cron helper at line 382 (instance-wide). Nothing keyed on `VaultKey::WithdrawalQueue` to drop.
- Subtask 3: `VaultKey` enum gained two section header comments — `// Instance — global single-row state (auto-extended with contract instance TTL)` and `// Persistent — keyed multi-row state`. `WithdrawalQueue` reordered to sit in the Instance group; `SnapshotPrice` stays in the Persistent group (Phase 8 moves it to Temporary, out of scope here).
- Subtask 4: `cargo build -p risk_vault` clean.
- Subtask 5: `cargo test -p risk_vault` — all 14 tests pass without source-code modification. Two test snapshots auto-regenerated by the harness (`test_cancel_withdrawal.1.json`, `test_withdrawal_queue_request_process_collect.1.json`); diff confirms the only change is the `WithdrawalQueue` ledger entry moving out of the Persistent ledger-entries block (now part of contract instance state). No behavioural surprises — the public API is tier-agnostic, so storage tier moves are invisible to test code.

**Final gates:**
- `cargo build -p risk_vault` ✓
- `cargo test -p risk_vault` ✓ (14/14 pass)
- `VaultKey` enum has tier-grouping comments matching the codebase pattern ✓
- No manual `WithdrawalQueue` TTL extension calls remain ✓
- `architecture.md` RiskVault section unchanged ✓ (already in sync; verified in pre-work)

All subtasks complete. Gate condition met. Ready for `/complete-phase 5`.

### Session 2026-05-03 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

**Modified:**
- `contracts/risk_vault/src/lib.rs` — 7 access sites `persistent()` → `instance()`; `VaultKey` enum tier-grouping comments + `WithdrawalQueue` reordered into Instance group.
- `contracts/risk_vault/test_snapshots/test/test_cancel_withdrawal.1.json` — auto-regenerated.
- `contracts/risk_vault/test_snapshots/test/test_withdrawal_queue_request_process_collect.1.json` — auto-regenerated.
- `spec/phases/phase-05-vault-withdrawal-queue.md` — work log, files-modified, decisions, status `planned → in_progress`.
- `spec/progress.md` — row 5 status `planned → in_progress`, Started date, Current Phase header.

**Created:** none.

**Deleted from contract:** nothing — only tier change + comments.

---

## Decisions Made

- **Tier-grouping enum layout.** `VaultKey` adopts the `flight_pool_manager::PoolKey` style with section header comments. Instance group: `Controller`, `TotalManagedAssets`, `LockedCapital`, `WithdrawalQueue`, `LastSnapshotTime`. Persistent group: `ClaimableBalance(Address)`, `SnapshotPrice(u64)`. Order within groups is arbitrary — comment groups, not strict ordering, are the readability lever.
- **`SnapshotPrice` stays Persistent in this phase.** Phase 8 moves it to Temporary with a 30-day TTL. Doing both moves in one phase would mix two unrelated changes; keeping them separate matches the dev_steps.md sequencing.
- **Auto-regenerated test snapshots are the right outcome.** The two queue-related test snapshots changed because the on-chain ledger entry layout for `WithdrawalQueue` shifted (Persistent standalone entry → part of contract instance). Diff inspection confirmed no behavioural change. No test source code edited.
- **Pre-work assumption that `cargo build -p risk_vault` is green today held up.** Phase 4's pleasant surprise (controller lib green) was contract-specific; risk_vault has always been independent of the deleted `flight_pool` / `recovery_pool` crates.

---

## Completion Summary

**What was built:**
- Closed a CRITICAL archival-rent risk on `risk_vault::WithdrawalQueue` by moving it from Persistent to Instance storage. The queue is now auto-extended whenever any `risk_vault` function runs (deposit, redeem, snapshot cron, settlement cron, etc.), eliminating the silent-archive failure mode that could freeze the underwriter exit path.
- `VaultKey` enum gained Instance/Persistent tier-grouping comments matching the `flight_pool_manager::PoolKey` style — future readers can see at a glance which tier each variant lives in.

**Key decisions locked in:**
- `WithdrawalQueue` lives in Instance — confirmed in code, matches `architecture.md` (which already specified Instance; this phase brought code into alignment).
- `SnapshotPrice` stays Persistent in this phase. Phase 8 moves it to Temporary; not bundled here.
- Auto-regenerated test snapshots are the right outcome for tier moves — no test source changes needed.

**Files modified:**
- `contracts/risk_vault/src/lib.rs` — 7 access sites flipped to `instance()`; enum tier-grouping comments.
- `contracts/risk_vault/test_snapshots/test/test_cancel_withdrawal.1.json` — auto-regenerated.
- `contracts/risk_vault/test_snapshots/test/test_withdrawal_queue_request_process_collect.1.json` — auto-regenerated.
- `spec/progress.md` — row 5 closed, Current Phase header updated.

**For the next phase to know:**
- Phase 6 is structurally identical (`oracle_aggregator::ActiveFlightList` Persistent → Instance + prune-on-settle). The same 3-Edit + enum-comment pattern from Phase 5 is reusable; Phase 6 just adds the prune logic on top.
- Phase 5's diff was tiny (~17 lines). Phase 5 + Phase 6 would bundle cleanly into one commit if the user prefers — both are storage-tier hygiene on the same theme.

**Known limitations / deferred items:**
- `ClaimableBalance` still has no TTL extension on writes — Phase 8 (Improvement #3) addresses that.
- `SnapshotPrice` still Persistent — Phase 8 moves it to Temporary.
- No `architecture.md` change this phase (already in sync).
- No `Cargo.lock` change (no destructive crate edits).
