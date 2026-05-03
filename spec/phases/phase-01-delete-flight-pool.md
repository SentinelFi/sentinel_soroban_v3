# Phase 1 — Delete `contracts/flight_pool/`

Status: complete
Started: 2026-05-02
Completed: 2026-05-02

---

## Goal

Remove the per-flight `FlightPool` contract crate and unregister it from the
workspace. This is the first of three coupled phases (1, 2, 3) that replace the
deploy-a-pool-per-flight pattern with a single `FlightPoolManager` singleton
(per `spec/dev_steps.md` Step 1 and `spec/improvements.md` Improvement #1). The
workspace will not build green again until Phase 3 lands the new contract and
Phase 7 rewires the controller.

## Dependencies

None — this is the first phase. All three contracts that reference
`flight_pool` (controller, integration_tests, recovery_pool) will be cleaned up
in their own later phases:

- `controller/Cargo.toml` + `controller/src/lib.rs` + `controller/src/test.rs` → Phase 7
- `integration_tests/Cargo.toml` + `integration_tests/src/tests/setup.rs` + `group5_edge_cases.rs` → Phase 10
- `recovery_pool/src/lib.rs` → deleted whole in Phase 2
- `risk_vault/src/test.rs` → only string-comment mentions (`// FlightPool …`); no code dependency, ignored here

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the commit at the end of the phase

### Docs to Fetch
None. This is a pure-deletion step; no Soroban authoring guidance is needed.

### Project Files to Read
- `spec/dev_steps.md` — Step 1 (the canonical task list and gate for this phase)
- `spec/improvements.md` — Improvement #1 (motivation and per-contract impact table)
- `contracts/Cargo.toml` — workspace manifest where `flight_pool` is registered
- `contracts/flight_pool/` — full directory listing, so the agent confirms what is being removed before deletion
- `contracts/Cargo.lock` — top-level — agent only needs to know the location, not parse it
- Files containing downstream `flight_pool` / `FlightPool` references (so the agent can verify the post-deletion grep matches the expected leave-in-place set):
  - `contracts/controller/Cargo.toml`
  - `contracts/controller/src/lib.rs`
  - `contracts/controller/src/test.rs`
  - `contracts/integration_tests/Cargo.toml`
  - `contracts/integration_tests/src/tests/setup.rs`
  - `contracts/integration_tests/src/tests/group5_edge_cases.rs`
  - `contracts/recovery_pool/src/lib.rs`
  - `contracts/risk_vault/src/test.rs`

## Pre-work Notes

> Fill this in before running `/start-phase 1`. Suggested topics below — keep,
> edit, or replace.

- **Build will be red after this phase.** Confirmed and acceptable —
  `progress.md` already calls this out. Phases 2, 3, 9, 10 close it. Do not add
  any temporary stub crate to keep `cargo build` green; that is wasted work.
- **Cargo.lock handling.** Either (a) delete `flight_pool` entries from
  `Cargo.lock` by hand, or (b) leave the lockfile dirty and let it regenerate
  on the next successful build (after Phase 3). Pick one and note it here.
  Default if unspecified: leave it; the next successful `cargo build` rewrites
  it.
- **`contracts/flight_pool/target/`** (build artifacts, if present) is removed
  with `rm -rf contracts/flight_pool/`. No separate `cargo clean` needed.
- **Snapshot files** (`contracts/flight_pool/test_snapshots/`) get deleted too.
  These are not referenced by other crates.
- **Do not touch** the dangling references in controller / integration_tests /
  recovery_pool / risk_vault — they are intentionally left for their own
  phases. The grep at the end is a verification step, not a fix step.

---

## Subtasks

- [x] 1. Confirm `contracts/flight_pool/` exists and list its contents (sanity check before destructive action).
- [x] 2. Run `rm -rf contracts/flight_pool/` from the repo root.
- [x] 3. Edit `contracts/Cargo.toml` — remove `"flight_pool",` from the `[workspace] members` array. Leave the rest of the array intact.
- [x] 4. Decide on Cargo.lock per Pre-work Notes; either edit out the `flight_pool` entry by hand, or leave it for the next successful build.
- [x] 5. Grep the workspace for `flight_pool` and `FlightPool` (excluding `target/`). Verify the only remaining hits are in the expected files: controller (Cargo.toml + lib.rs + test.rs), integration_tests (Cargo.toml + setup.rs + group5_edge_cases.rs), recovery_pool (src/lib.rs), risk_vault (src/test.rs comments). Record the exact match list in the Work Log.
- [x] 6. Run the verification command — `cargo build -p flight_pool` from `contracts/`. Expected: error along the lines of "package ID specification `flight_pool` did not match any packages". Record the exact output in the Work Log.
- [x] 7. (Do not commit yet.) Note in the Work Log that `cargo build` for the whole workspace is expected to fail — this is the known build-red window that closes at Phase 3.

### Gate

`cargo build -p flight_pool` (run from `contracts/`) fails with a "package not
found" error. The `flight_pool` directory does not exist on disk. The
`flight_pool` entry is gone from `contracts/Cargo.toml`'s `[workspace] members`
array. The grep audit from subtask 5 shows zero unexpected references.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-02

Starting phase. Lite prime complete. Context manifest loaded.
- Docs fetched: none (manifest specifies none for this pure-deletion step).
- Skills loaded: `git` skill noted (only invoked at commit-time, deferred per subtask 7).
- Project files read: `spec/dev_steps.md` (Step 1), `spec/architecture.md` (System Overview), `spec/preferences.md`, `spec/progress.md`, `contracts/Cargo.toml`, `contracts/flight_pool/` directory listing.
- Pre-work Notes accepted as written (user did not edit). Default Cargo.lock handling: leave it; rewritten by next successful `cargo build` (after Phase 3).
- Note: working tree had uncommitted dev_steps.md reorder + new spec/phases/ before this phase began. That work is independent of Phase 1; the user can `/commit` it now or after Phase 1 with the deletion changes.

**Subtask 1 — sanity listing.** `contracts/flight_pool/` contained: `Cargo.toml`, `src/lib.rs` (12,313 B), `src/test.rs` (15,110 B), `test_snapshots/test/`. No `target/` build artifacts present.

**Subtask 2 — deletion.** `rm -rf /Users/sauravdhar/.../contracts/flight_pool` succeeded. Confirmation `ls` returned "No such file or directory".

**Subtask 3 — workspace edit.** `contracts/Cargo.toml` `members` array now: `[mock_usdc, recovery_pool, governance_module, risk_vault, oracle_aggregator, controller, integration_tests]`. Order preserved; only the `"flight_pool",` line removed.

**Subtask 4 — Cargo.lock.** Left untouched per Pre-work Notes default. The lockfile still contains a stale `flight_pool` entry; Cargo will regenerate it on the next successful build (Phase 3, when the workspace becomes resolvable again).

**Subtask 5 — grep audit.** Ran `grep -rln "flight_pool\|FlightPool"` across `contracts/` and `spec/`, excluding `target/`. Result (8 contract files, all expected; spec files are documentation):

Contracts:
- `contracts/controller/Cargo.toml` — Phase 7 cleans up
- `contracts/controller/src/lib.rs` — Phase 7 cleans up
- `contracts/controller/src/test.rs` — Phase 7 cleans up
- `contracts/integration_tests/Cargo.toml` — Phase 10 cleans up
- `contracts/integration_tests/src/tests/group5_edge_cases.rs` — Phase 10 cleans up
- `contracts/integration_tests/src/tests/setup.rs` — Phase 10 cleans up
- `contracts/recovery_pool/src/lib.rs` — Phase 2 deletes whole crate
- `contracts/risk_vault/src/test.rs` — comments only ("// FlightPool …"); ignored

Spec docs (expected, not in scope of audit): `architecture.md`, `dev_steps.md`, `improvements.md`, `learn_soroban.md`, `phases/phase-01-delete-flight-pool.md`, `progress.md`.

Audit clean — zero unexpected references.

**Subtask 6 — verification.** `cd contracts && cargo build -p flight_pool` output:

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

This is a *stronger* failure than the gate predicted ("package not found"): Cargo can no longer even resolve the workspace because `controller` still has `flight_pool = { path = "../flight_pool" }` and that path no longer exists. The deletion is real and visible to the build system. Gate condition met.

**Subtask 7 — build-red window opened.** Whole-workspace `cargo build` will fail until Phase 7 (controller path-dep removed) and Phase 10 (integration_tests path-dep removed). Acknowledged and accepted per Pre-work Notes.

All subtasks complete. Gate condition met. Ready for /complete-phase.

### Session 2026-05-02 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

> Populated by the agent during work.

**Deleted:**
- `contracts/flight_pool/` (whole directory: `Cargo.toml`, `src/lib.rs`, `src/test.rs`, `test_snapshots/`)

**Modified:**
- `contracts/Cargo.toml` — removed `"flight_pool",` from `[workspace] members`
- `spec/progress.md` — Phase 1 status `planned` → `in_progress`, header `Current Phase` updated
- `spec/phases/phase-01-delete-flight-pool.md` — status flip + Work Log + this section + Decisions; also two stale "Phase 9 / Phase 10" references in Goal & Dependencies corrected to the post-reorder numbering ("Phase 7 / Phase 10")

**Intentionally not modified:**
- `contracts/Cargo.lock` — stale `flight_pool` entry remains; will regenerate on next successful build (Phase 3+)
- All 8 downstream files containing `flight_pool` / `FlightPool` references — left for their owning phases (2, 7, 10)

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

- **Cargo.lock left dirty.** Did not hand-edit out the stale `flight_pool` entry. Cost of the manual edit ≈ zero, but doing so would couple this phase to lockfile internals and risk diverging from `cargo`'s own canonical sort. Defer to the next successful build to rewrite it.
- **No stub `flight_pool` crate added** to keep the workspace building. Pre-work Notes explicitly forbade it; doing so would be wasted work that has to be undone in Phases 2/3. The build-red window is the correct trade-off — it forces Phases 2/3 to land before any further contract work proceeds.
- **`risk_vault/src/test.rs` comments left as-is.** Two `// FlightPool …` comment mentions exist (no code dependency). Updating them now would either prematurely use the not-yet-existing `FlightPoolManager` name or create churn. They are harmless string mentions until the comments are revisited (likely incidentally during Phase 8 risk_vault TTL work).

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.

**Built:** removed `contracts/flight_pool/` and unregistered it from the workspace. The per-flight WASM-deploy pattern is now physically gone from the codebase.

**Decisions locked in:**
- Cargo.lock left dirty (will regenerate on the next successful build, after Phase 3 + 7 + 10).
- No stub crate added to keep the workspace green — the build-red window is the correct trade-off and forces Phases 2/3 to land before further contract work.
- 8 downstream `flight_pool` / `FlightPool` references intentionally left in place for their owning phases (controller → Phase 7, integration_tests → Phase 10, recovery_pool → Phase 2 deletes whole, risk_vault test comments → harmless).

**Files modified (final):**
- Deleted: `contracts/flight_pool/` (whole directory, including `test_snapshots/`).
- Modified: `contracts/Cargo.toml` (`flight_pool` removed from `[workspace] members`).

**Heads-up for next phase (Phase 2):**
- Workspace can no longer resolve via `cargo` — any `cargo build -p <anything>` will fail with the flight_pool path-dep error from `controller/Cargo.toml`. Phase 2's verification gate is therefore on-disk + Cargo.toml + grep audit; the cargo error is informational only.
- Phase 2 is structurally identical (rm -rf + workspace edit + grep), and the Phase 2 file already encodes this.

**Known limitation / deferred:**
- Stale `flight_pool` package entry in `contracts/Cargo.lock` until Phase 3 lands a buildable workspace.
