# Phase 2 — Delete `contracts/recovery_pool/`

Status: complete
Started: 2026-05-02
Completed: 2026-05-02

---

## Goal

Remove the standalone `RecoveryPool` contract crate and unregister it from the
workspace. Recovery accounting (sweeping unclaimed expired payouts, owner
withdrawal of swept funds) is being absorbed into the new `FlightPoolManager`
singleton as the `RecoveredBalance` instance entry plus `sweep_expired` /
`withdraw_recovered` functions (per `spec/dev_steps.md` Step 2 and
`spec/improvements.md` Improvement #1). After this phase, no separate
recovery contract exists; FlightPoolManager (Phase 3) will own the surface.

## Dependencies

Phase 1 (delete `flight_pool/`) is complete. The workspace is already in the
known build-red window from Phase 1; this phase extends that window — it does
not open a new one. The fixers downstream are the same set of phases:

- `controller/Cargo.toml` + `controller/src/lib.rs` + `controller/src/test.rs` → Phase 7
- `integration_tests/Cargo.toml` + `integration_tests/src/tests/setup.rs` → Phase 10

(No `group5_edge_cases.rs` reference for `RecoveryPool` — only `setup.rs`
in the integration_tests crate. No `risk_vault` references at all.)

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the commit at the end of the phase

### Docs to Fetch
None. Pure-deletion step; no Soroban authoring guidance needed.

### Project Files to Read
- `spec/dev_steps.md` — Step 2 (canonical task list and gate for this phase)
- `spec/improvements.md` — Improvement #1 (motivation; recovery accounting move)
- `contracts/Cargo.toml` — workspace manifest where `recovery_pool` is registered
- `contracts/recovery_pool/` — full directory listing, so the agent confirms what is being removed before deletion
- Files containing downstream `recovery_pool` / `RecoveryPool` references (so the agent can verify the post-deletion grep matches the expected leave-in-place set):
  - `contracts/controller/Cargo.toml`
  - `contracts/controller/src/lib.rs`
  - `contracts/controller/src/test.rs`
  - `contracts/integration_tests/Cargo.toml`
  - `contracts/integration_tests/src/tests/setup.rs`

## Pre-work Notes

> Fill this in before running `/start-phase 2`. Suggested defaults below — keep,
> edit, or replace.

- **Build is already red from Phase 1.** This phase widens the breakage but
  does not change the resolution path: Phases 3, 7, 10 close it. Do not add
  any temporary stub crate to keep `cargo build` green.
- **Cargo.lock handling.** Same default as Phase 1: leave the lockfile dirty;
  the next successful build (after Phase 3 + 7 + 10) regenerates it. Do not
  hand-edit unless there is a specific reason.
- **`contracts/recovery_pool/target/`** (build artifacts, if present) is
  removed with `rm -rf contracts/recovery_pool/`. No separate `cargo clean`
  needed.
- **Snapshot files** (`contracts/recovery_pool/test_snapshots/`) are deleted
  too. Not referenced by other crates.
- **Gate-text caveat.** `dev_steps.md` Step 2 says verification is
  `cargo build -p recovery_pool` failing with "package not found". With
  flight_pool already gone, the workspace cannot resolve at all, so the cargo
  command will fail earlier in the dependency chain (likely still pointing at
  the flight_pool path failure from Phase 1). Treat the verification as: (a)
  directory is gone on disk, (b) `recovery_pool` is removed from
  `[workspace] members`, (c) grep audit shows zero unexpected references.
  The cargo build failure is informational only.
- **Do not touch** the dangling references in controller and integration_tests
  — they belong to Phases 7 and 10 respectively. The grep at the end is a
  verification step, not a fix step.

---

## Subtasks

- [x] 1. Confirm `contracts/recovery_pool/` exists and list its contents (sanity check before destructive action).
- [x] 2. Run `rm -rf contracts/recovery_pool/` from the repo root.
- [x] 3. Edit `contracts/Cargo.toml` — remove `"recovery_pool",` from the `[workspace] members` array. Leave the rest of the array intact.
- [x] 4. Decide on Cargo.lock per Pre-work Notes; default is to leave it for the next successful build.
- [x] 5. Grep the workspace for `recovery_pool` and `RecoveryPool` (excluding `target/`). Verify the only remaining hits are in the expected files: controller (Cargo.toml + lib.rs + test.rs), integration_tests (Cargo.toml + setup.rs). Record the exact match list in the Work Log.
- [x] 6. Run `cargo build -p recovery_pool` from `contracts/`. Record the exact output in the Work Log. Expected to fail (cascade from Phase 1's flight_pool path-dep failure or a similar resolution error). The build failure is informational; the real proof of deletion lives in subtasks 1–5.
- [x] 7. (Do not commit yet.) Note in the Work Log that the workspace remains build-red — extending the window opened in Phase 1, closes at Phases 3 + 7 + 10.

### Gate

`contracts/recovery_pool/` does not exist on disk. The `recovery_pool` entry
is gone from `contracts/Cargo.toml`'s `[workspace] members` array. The grep
audit from subtask 5 shows zero unexpected references (only the 5 expected
downstream files, each owned by Phase 7 or Phase 10).

The cargo-build verification is informational only in this phase because
Phase 1 already prevents workspace resolution; do not gate on its specific
error text.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-02

Starting phase. Lite prime complete. Context manifest loaded.
- Docs fetched: none (manifest specifies none for this pure-deletion step).
- Skills loaded: `git` skill noted (only invoked at commit-time, deferred per subtask 7).
- Project files read: `spec/dev_steps.md` (Step 2), `spec/architecture.md` (System Overview, cached), `spec/preferences.md` (cached), `spec/progress.md`, `contracts/Cargo.toml` (post-Phase-1 state), `contracts/recovery_pool/` directory listing.
- Pre-work Notes accepted as written.
- Note: Phase 1 is still marked `in_progress` in `progress.md` (user has not yet called `/complete-phase 1`). Phase 2's `/start-phase` check authorized this run because Phase 2 itself is `planned`. The Phase 1 deletion is on disk and Cargo.toml; functionally Phase 2 has the post-Phase-1 baseline it expects.
- Working tree carries: pre-Phase-1 reorder (commands + dev_steps.md + progress.md + spec/phases/), Phase 1 deletion (flight_pool/ + Cargo.toml edit), and Phase 1 / Phase 2 status flips. All uncommitted by design — user is bundling.

**Subtask 1 — sanity listing.** `contracts/recovery_pool/` contained: `Cargo.toml` (396 B), `src/lib.rs` (2,814 B), `src/test.rs` (4,176 B), `test_snapshots/test/`. No `target/` build artifacts present.

**Subtask 2 — deletion.** `rm -rf .../contracts/recovery_pool` succeeded. Confirmation `ls` returned "No such file or directory" (exit 1, expected).

**Subtask 3 — workspace edit.** `contracts/Cargo.toml` `members` array now: `[mock_usdc, governance_module, risk_vault, oracle_aggregator, controller, integration_tests]`. Order preserved; only the `"recovery_pool",` line removed. (`"flight_pool",` was already removed by Phase 1.)

**Subtask 4 — Cargo.lock.** Left untouched per Pre-work Notes default. Stale `recovery_pool` entry remains alongside the stale `flight_pool` entry from Phase 1; both will regenerate on the next successful build (after Phases 3 + 7 + 10 land).

**Subtask 5 — grep audit.** Ran `grep -rln "recovery_pool\|RecoveryPool"` across `contracts/` and `spec/`, excluding `target/`. Result (5 contract files, all expected; spec files are documentation):

Contracts:
- `contracts/controller/Cargo.toml` — Phase 7 cleans up
- `contracts/controller/src/lib.rs` — Phase 7 cleans up
- `contracts/controller/src/test.rs` — Phase 7 cleans up
- `contracts/integration_tests/Cargo.toml` — Phase 10 cleans up
- `contracts/integration_tests/src/tests/setup.rs` — Phase 10 cleans up

Spec docs (expected, not in scope of audit): `architecture.md`, `dev_steps.md`, `improvements.md`, `learn_soroban.md`, `phases/phase-01-delete-flight-pool.md`, `phases/phase-02-delete-recovery-pool.md`, `progress.md`.

Audit clean — zero unexpected references.

**Subtask 6 — verification.** `cargo build -p recovery_pool` (from `contracts/`) output:

```
error: failed to load manifest for workspace member `.../contracts/controller`
referenced by workspace at `.../contracts/Cargo.toml`

Caused by:
  failed to load manifest for dependency `flight_pool`
Caused by:
  failed to read `.../contracts/flight_pool/Cargo.toml`
Caused by:
  No such file or directory (os error 2)
```

Cargo cascades through the *flight_pool* path-dep failure from Phase 1 before it ever evaluates `recovery_pool` — exactly the behaviour predicted in Pre-work Notes. Informational only; the gate sits on subtasks 1–5.

**Subtask 7 — build-red window extended.** Whole-workspace `cargo build` was already red after Phase 1 and remains red after Phase 2. Closes at Phase 7 (controller path-deps removed) + Phase 10 (integration_tests path-deps removed). The new contract from Phase 3 is needed to give Phase 7 something to point at; Phase 3 itself can be built in isolation as soon as it exists.

All subtasks complete. Gate condition met. Ready for /complete-phase.

### Session 2026-05-02 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

> Populated by the agent during work.

**Deleted:**
- `contracts/recovery_pool/` (whole directory: `Cargo.toml`, `src/lib.rs`, `src/test.rs`, `test_snapshots/`)

**Modified:**
- `contracts/Cargo.toml` — removed `"recovery_pool",` from `[workspace] members`
- `spec/progress.md` — Phase 2 status `planned` → `in_progress`, header `Current Phase` updated
- `spec/phases/phase-02-delete-recovery-pool.md` — status flip + Work Log + this section + Decisions

**Intentionally not modified:**
- `contracts/Cargo.lock` — stale `recovery_pool` entry remains (alongside stale `flight_pool` from Phase 1); regenerates on next successful build
- All 5 downstream files containing `recovery_pool` / `RecoveryPool` references — left for Phase 7 (controller) and Phase 10 (integration_tests)

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

- **Cargo.lock left dirty (same as Phase 1).** Both stale entries (`flight_pool`, `recovery_pool`) ride together until the next successful build rewrites the lockfile. Hand-editing now would risk diverging from Cargo's canonical sort and gain nothing.
- **Cargo build verification accepted as informational.** The dev_steps "package not found" gate text is unreachable in the post-Phase-1 state because Cargo can't resolve the workspace — it dies on the flight_pool path-dep before it ever names recovery_pool. The Pre-work Notes anticipated this; gate sits on directory + workspace-members + grep audit instead.
- **No proactive comment fixes.** No `// RecoveryPool …` style comments were found in the audit (unlike Phase 1's risk_vault test comments). Nothing to leave alone here.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.

**Built:** removed `contracts/recovery_pool/` and unregistered it from the workspace. Standalone recovery accounting is now physically gone from the codebase; the surface (sweep_expired, withdraw_recovered, RecoveredBalance) will be re-introduced inside `FlightPoolManager` in Phase 3.

**Decisions locked in:**
- Cargo.lock left dirty alongside the stale Phase-1 entry — both regenerate together on the next successful build.
- Cargo build verification accepted as informational (cascades through Phase 1's flight_pool path-dep failure before reaching recovery_pool). Gate sits on directory + workspace-members + grep audit.
- 5 downstream `recovery_pool` / `RecoveryPool` references intentionally left in place for their owning phases (controller → Phase 7, integration_tests → Phase 10).
- No `// RecoveryPool …` comment cleanups were needed (unlike Phase 1 which had two in `risk_vault/src/test.rs`).

**Files modified (final):**
- Deleted: `contracts/recovery_pool/` (whole directory, including `test_snapshots/`).
- Modified: `contracts/Cargo.toml` (`recovery_pool` removed from `[workspace] members`; array now: `[mock_usdc, governance_module, risk_vault, oracle_aggregator, controller, integration_tests]`).

**Heads-up for next phase (Phase 3 — add `flight_pool_manager/`):**
- The new contract must own all surface that was in `flight_pool` (per-flight buyer accounting, settlement, claim, sweep) AND the surface that was in `recovery_pool` (RecoveredBalance, withdraw_recovered). The full storage layout + function set is spec'd in `dev_steps.md` Step 3 and `architecture.md` FlightPoolManager section.
- Phase 3 unblocks the build only partially — the workspace will still be red until Phase 7 (controller rewire) and Phase 10 (integration_tests rewire) reroute downstream references away from `flight_pool`/`recovery_pool` to `flight_pool_manager`.

**Known limitation / deferred:**
- Stale `recovery_pool` package entry remains in `contracts/Cargo.lock` (alongside the Phase-1 `flight_pool` entry).
