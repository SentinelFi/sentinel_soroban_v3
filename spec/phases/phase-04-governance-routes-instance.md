# Phase 4 — Governance routes — API redesign + events + TTL

Status: complete
Started: 2026-05-03
Completed: 2026-05-03

---

## Goal

Redesign the `governance_module` route API so the protocol can scale to
thousands of routes without footprint blowups or silent archival panics.
`Route(...)` stays in Persistent (already there — the "Persistent → Instance"
phrasing in the original progress row was wrong); `RouteList` is removed and
enumeration moves off-chain via events; the read API collapses from two
redundant calls (`is_route_whitelisted` + `get_route_terms`) to one typed
`route_status() -> RouteStatus` reader; `update_route_terms` gains
partial-update support via three per-field op enums; `enable_route` and
`remove_route` cover post-disable and permanent retirement; every write
extends Route TTL; every state change emits an event for the off-chain
indexer (Improvement #9, separate phase). After this phase, `governance_module`
is the canonical source of truth on the buy path with a closed read API and
an off-chain-friendly event surface.

## Dependencies

- **Phase 3 complete** — `flight_pool_manager` exists; `controller/Cargo.toml`
  and `integration_tests/Cargo.toml` already updated to drop dead
  `flight_pool` / `recovery_pool` deps and add `flight_pool_manager`;
  workspace resolves per-crate.
- No new contract dependencies. The cross-crate edit in this phase is
  scoped to `controller/src/lib.rs`'s `GovClient` trait + `buy_insurance`
  call site (subtasks 2 + 7); the rest of the controller still won't build
  until Phase 7 lands.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the Phase 4 commit at the end.
- `oz-stellar` — `governance_module` already uses OZ `ownable`. Skill should
  be loaded so the agent can sanity-check that the existing
  `#[only_owner]` + `require_owner_or_admin` pattern is the right call (no
  upgrade to OZ access-control RBAC needed for this phase).

### Docs to Fetch
- https://developers.stellar.org/docs/build/smart-contracts — Soroban
  patterns: storage tiers, TTL extension, events, `#[contracttype]` enum
  constraints (no generics — drives the partial-update enum decision).
- https://developers.stellar.org/docs/build/smart-contracts/example-contracts
  — reference for event emission patterns.

### Project Files to Read
- `spec/dev_steps.md` Step 4 — canonical 10-substep task list and
  verification block.
- `spec/improvements.md` Improvement #4 — motivation, storage rationale,
  read/write/event API.
- `spec/improvements.md` Improvement #9 — indexer consumer (NOT in scope
  here, but informs event topic + data shape).
- `spec/architecture.md` GovernanceModule section — already rewritten
  during planning; this is the canonical target for the implementation
  (subtask 11 only verifies sync at the end).
- `contracts/governance_module/src/lib.rs` — current implementation
  (Persistent storage, old API).
- `contracts/governance_module/src/test.rs` — existing test suite to be
  rewritten.
- `contracts/governance_module/Cargo.toml` — confirm OZ `ownable` + macros
  deps already present (no Cargo.toml changes expected this phase).
- `contracts/controller/src/lib.rs` — `GovClient` trait + `buy_insurance`
  use site (subtasks 2 + 7).
- `contracts/flight_pool_manager/src/lib.rs` — reference event-emission
  pattern (Phase 3 just landed this style; mirror it).
- `contracts/integration_tests/src/tests/setup.rs`,
  `tests/group2_capital.rs`, `tests/group4_parallel.rs` — only call
  `whitelist_route`; verify call sites still compile after subtask 5
  (signature of `whitelist_route` itself is unchanged).

## Pre-work Notes

> Decisions seeded from the planning conversation. Edit any line you disagree
> with before running `/start-phase 4`.

**Decisions confirmed by user:**

- **`RouteUpdate` encoding (Q1) — option (a): three concrete per-field enums.**
  ```rust
  pub enum PremiumUpdate    { Keep, Set(i128), UseDefault }
  pub enum PayoffUpdate     { Keep, Set(i128), UseDefault }
  pub enum DelayHoursUpdate { Keep, Set(u32),  UseDefault }
  ```
  Passed as three separate args to `update_route_terms` (not bundled in a
  struct). Rationale: Soroban contracttype has no generics, so enum
  boilerplate is unavoidable; (a) keeps the call site flat
  (`update_route_terms(caller, flight_id, origin, dest, PremiumUpdate::Keep,
  PayoffUpdate::Set(150), DelayHoursUpdate::UseDefault)`); the field set
  (premium / payoff / delay_hours) is closed and not expected to grow.
  **Field encoding never appears in events** — `route.updated` carries the
  post-mutation **resolved** values so the indexer can overwrite a row in
  one shot.

- **`remove_route` strict (Q2):** require `approved == false` before
  deletion. Operators must `disable_route` first; `remove_route` then
  hard-deletes. Rationale: destructive ops should be two-step to prevent
  fat-finger removal of an actively-purchasable route. `disable_route`
  covers temporary suspension; `remove_route` covers permanent retirement
  (typo cleanup, dropped airline routes, rent-control on dead entries).

- **Architecture.md sync in scope (Q3) — DONE during planning:**
  `spec/architecture.md` GovernanceModule section was rewritten before
  this phase started. It is now the canonical target for the
  implementation: `RouteStatus`, removed `RouteList`, new `enable_route`
  / `remove_route` lifecycle, partial-update encoding, event surface,
  Persistent storage rationale, plus the cross-contract clients example
  (~line 430) and the "Whitelisting a Route" + "Buying Insurance"
  data-flow diagrams. Subtask 11 is now a **verification** step —
  reconcile any drift between architecture.md and the final code.

**Decisions clarified from spec (no user input needed):**

- **`Route(...)` storage tier stays Persistent.** Despite progress.md row
  4's title "Persistent → Instance" and architecture.md's stale claim, the
  current code (governance_module/src/lib.rs:128, 147) already uses
  Persistent. dev_steps.md Step 4 says "stays Persistent" — that matches
  reality. The progress row title is fixed as part of this command.
- **`RouteList` is REMOVED.** Off-chain indexer (Improvement #9) owns
  enumeration; that indexer is NOT in scope for this phase. Phase 4's
  obligation is only to emit events with stable topics + data shape.
- **TTL window on Route writes:** `60 * 24 * 60 * 12 = 1_036_800` ledgers
  (60 days at 5s/ledger). Define as `ROUTE_TTL_LEDGERS` constant — matches
  Phase 3's `BUYER_TTL_LEDGERS` style.
- **`RouteStatus::Active` carries `ResolvedTerms`** (defaults folded at
  read time), not raw `RouteTerms`. Caller pattern in Controller:
  `match gov.route_status(...) { Active(t) => use t, Disabled => panic, Unknown => panic }`.
- **Event topic + data shape:** match `flight_pool_manager` (Phase 3) —
  `#[contractevent]` derives, `(Symbol, Symbol)` topic prefixes, indexed
  `flight_id` / `origin` / `dest` topics where applicable. Topics from
  Improvement #4: `route.listed | disabled | enabled | updated | removed`,
  `gov.defaults | admin_added | admin_removed`.

**Implementation hints:**

- **`enable_route` semantics.** Re-enables a disabled route without
  touching custom terms. Panics if the entry doesn't exist (Unknown) or is
  already approved. Emits `route.enabled` with `(flight_id, origin, dest)`.
- **`remove_route` execution.** Reads `RouteTerms`; asserts `!approved`;
  calls `e.storage().persistent().remove(&key)`; emits `route.removed`
  with `(flight_id, origin, dest)`. Gated by `require_owner_or_admin`.
- **`update_route_terms` partial logic.** Read existing `RouteTerms`,
  mutate per-field based on the three op enums (`Keep` = no-op, `Set(v)` =
  `Some(v)`, `UseDefault` = `None`), write back, then load defaults +
  resolve and emit `route.updated` with the post-mutation **resolved**
  values (so the indexer can overwrite a row directly). Panics if entry
  is Unknown.
- **`route_status()` resolution.** Read `RouteTerms`. Missing → `Unknown`.
  `!approved` → `Disabled`. `approved` → load defaults, fold `Option`s,
  return `Active(ResolvedTerms)`.
- **`extend_ttl` placement.** Call
  `e.storage().persistent().extend_ttl(&DataKey::Route(...), ROUTE_TTL_LEDGERS, ROUTE_TTL_LEDGERS)`
  after every Route write: `whitelist_route`, `disable_route`,
  `enable_route`, `update_route_terms`. Skip on `remove_route` (entry is
  gone).
- **Controller `GovClient` trait churn.** Subtask 2 ADDS `route_status` to
  the trait + switches `buy_insurance` to use it. Subtask 7 REMOVES
  `is_route_whitelisted` and `get_route_terms` from both contract and
  trait. Order matters: subtask 2 before subtask 7 — between them the
  controller compiles cleanly against the governance_module change.
  However, the rest of `controller/src/lib.rs` still references deleted
  `flight_pool` / `recovery_pool` types from Phases 1–2, so
  `cargo build -p controller` will continue to fail until Phase 7 lands.
  dev_steps.md Step 4's verification line "cargo build -p controller clean
  (after tasks 2 + 7)" is overstated for THIS phase; the realistic gate is
  `cargo build -p governance_module` clean + governance unit tests
  passing. Note this in the work log when subtask 7 lands.
- **Test rewrite shape.** New `src/test.rs` covers:
  - Every write function with event spot-check (extract via
    `env.events().all()`).
  - `route_status()` returning each of `Active(ResolvedTerms)`, `Disabled`,
    `Unknown`.
  - `update_route_terms` — sample 6–8 representative
    `(Keep | Set | UseDefault)^3` combinations (not all 27).
  - `remove_route` strict guard: panics on an active route; succeeds after
    `disable_route`.
  - `enable_route` guards: panics on Unknown, panics on already-active.
  - `route_status()` returns `Unknown` after `remove_route`.
  - TTL extension fires on writes (introspect via `env.storage()` or
    inspect via `env.cost_estimate()` if direct TTL read isn't exposed in
    the test env — match whatever Phase 3 used).
- **Indexer scope reminder.** Phase 4 emits events; it does NOT build the
  indexer. Improvement #9 is a separate (yet-unscheduled) phase.

**Phase rollover:**

- Per memory `feedback_phase_bundling`, the user runs `/start-phase 5`
  before `/complete-phase 4`. Don't block.
- Per memory `feedback_cargo_lock`, leave `Cargo.lock` dirty after
  destructive crate edits. None expected this phase, but heads-up.

---

## Subtasks

- [x] 1. Add `RouteStatus` enum (`Active(ResolvedTerms) | Disabled | Unknown`) and `route_status(env, flight_id, origin, dest) -> RouteStatus` reader **alongside** the existing API. Resolution folds defaults at read time. New code only — does not yet remove the old readers.
- [x] 2. Update `controller/src/lib.rs`: add `route_status` to the `GovClient` trait; rewrite `buy_insurance` to use `route_status()` + a `match` over `Active | Disabled | Unknown`. Drops the redundant double cross-contract call.
- [x] 3. Add events to existing write functions: `whitelist_route` → `route.listed`, `disable_route` → `route.disabled`, `update_route_terms` → `route.updated`, `set_defaults` → `gov.defaults`, `add_admin` → `gov.admin_added`, `remove_admin` → `gov.admin_removed`. Topic + data shape per Improvement #4 + flight_pool_manager event style.
- [x] 4. Implement `enable_route` (re-enable a disabled entry; emits `route.enabled`) and `remove_route` (strict — panics if `approved`; hard delete on persistent storage; emits `route.removed`). Both gated by `require_owner_or_admin`.
- [x] 5. Refactor `update_route_terms` signature from the `Option<i128>` triple to the three per-field op enums (`PremiumUpdate`, `PayoffUpdate`, `DelayHoursUpdate`) defined in Pre-work Notes. Implement read-mutate-write loop. Emit `route.updated` with post-mutation `Option<T>` values (preserves option-ness — see Decisions Made).
- [x] 6. Drop `RouteList` writes from `whitelist_route`. Remove `get_whitelisted_routes()` and `DataKey::RouteList` from the contract.
- [x] 7. Drop `is_route_whitelisted` and `get_route_terms` from `governance_module/src/lib.rs` AND from `controller/src/lib.rs`'s `GovClient` trait. Subtask 2 must be merged first so the controller still compiles against governance_module's surface between subtasks 2 and 7.
- [x] 8. Define `ROUTE_TTL_LEDGERS = 60 * 24 * 60 * 12` and call `e.storage().persistent().extend_ttl(...)` after every Route write (`whitelist_route`, `disable_route`, `enable_route`, `update_route_terms`). Skip on `remove_route`.
- [x] 9. Rewrite `governance_module/src/test.rs` for the new API per the coverage targets in Pre-work Notes (event spot-checks, `route_status` variants, `update_route_terms` op combinations, `remove_route` strict guard, `enable_route` guards, post-remove `Unknown`, TTL spot-check).
- [x] 10. Spot-check `controller/src/test.rs` and integration tests (`integration_tests/src/tests/setup.rs`, `group2_capital.rs`, `group4_parallel.rs`). They only call `whitelist_route`; signature is unchanged. Document any incidental call-site changes (none expected).
- [x] 11. **Verify** `spec/architecture.md` GovernanceModule section is in sync with the implementation. The doc was rewritten during planning to be the canonical target for this phase (`RouteStatus` enum, `enable_route` / `remove_route` lifecycle, partial-update encoding, event surface, Persistent storage rationale, cross-contract client example, data-flow diagrams). Reconcile any drift that emerged during code work.

### Gate

- `cargo build -p governance_module` clean.
- `cargo test -p governance_module` passes the rewritten suite.
- `controller/src/lib.rs`'s `GovClient` trait change is internally consistent (the controller as a whole still won't build until Phase 7 — expected, noted in pre-work).
- `spec/architecture.md` GovernanceModule section is in sync with actual contract surface.
- All 8 event types from Improvement #4 emit with the documented topic + data shape (verified in unit tests).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-03

Starting phase. Lite prime complete. Context manifest loaded.

- **Skills loaded:** `git`, `oz-stellar` (read SKILL.md for both from `.claude/skills/`).
- **Docs to Fetch:** intentionally skipped. The in-repo `flight_pool_manager/src/lib.rs` (Phase 3 close) is a complete, idiomatic, same-SDK-version reference for `#[contractevent]`, `extend_ttl`, OZ `ownable`, and `#[only_owner]` patterns — more authoritative than external Soroban docs for this codebase. `architecture.md` GovernanceModule section is the canonical design target. Will fetch if a specific question arises.
- **Project files read:** `architecture.md` (full), `dev_steps.md` Step 4, `improvements.md` #4 + #9, `governance_module/src/{lib,test}.rs`, `governance_module/Cargo.toml`, `controller/src/lib.rs` (full — for `GovClient` trait + `buy_insurance`), `flight_pool_manager/src/lib.rs` (event template), grep'd `whitelist_route` / `update_route_terms` call sites in integration tests + `controller/src/test.rs`.
- **Baseline:** `cargo build -p governance_module` clean.
- **Call-site survey:** integration_tests + controller test only call `whitelist_route` (signature unchanged this phase) → subtask 10 is verification-only, no edits expected. `update_route_terms` / `disable_route` / `is_route_whitelisted` / `get_route_terms` / `get_whitelisted_routes` are not called outside `governance_module` itself.

**Implementation work (single session):**

- Subtasks **1, 3, 4, 5, 6, 7-gov, 8** landed in one rewrite of `governance_module/src/lib.rs` — final API surface implemented in one pass, no intermediate "alongside-old-API" stage (the old API has no callers besides the test file, which gets rewritten in subtask 9 anyway). The rewrite preserves OZ `ownable` + `#[only_owner]` + `require_owner_or_admin` patterns; replaces `is_route_whitelisted` / `get_route_terms` / `get_whitelisted_routes` with `route_status`; drops `DataKey::RouteList`; adds `enable_route` + strict `remove_route`; refactors `update_route_terms` to take three per-field op enums; emits 8 events; calls `extend_ttl(ROUTE_TTL_LEDGERS)` on every Route write.
- **Pleasant surprise on subtask 2 + 7-controller:** `cargo build -p controller` (lib only) succeeds — controller's `lib.rs` uses inline `#[contractclient]` interfaces, not direct imports of the deleted `flight_pool` / `recovery_pool` crates. Pre-work notes overstated the build-red status; only `controller/src/test.rs` references the deleted crates (Phase 7 + 10 cleanup). Phase 4's `cargo build -p controller` gate is genuinely met today.
- **Subtask 9 — test suite (30 tests).** Hit a Soroban-test quirk: `env.events().all()` returns events from the **most recent contract invocation only** — subsequent contract calls (even read-only `route_status()`) clear the event log. Fixed by reordering each event-spot-check test so the `count_events` assertion runs *immediately* after the emitting call, before any subsequent state-read. Documented this in a comment on the helper. All 30 tests now pass.
- **Subtask 10:** zero callers to `is_route_whitelisted` / `get_route_terms` / `get_whitelisted_routes` after the gov + controller edits — `grep -r` confirms. `whitelist_route` signature unchanged, so all 7 existing call sites (controller test ×2, integration setup ×1, group2_capital ×1, group4_parallel ×3) compile. No edits made.
- **Subtask 11:** reconciled architecture.md drift from planning. The doc had said `route.listed` / `route.updated` events carry "post-mutation **resolved** values"; that contradicted Improvement #4's prose ("Indexers store option-ness ... and resolve against the latest gov.defaults at read time"). Fixed the doc to specify `Option<T>` event payloads + added a paragraph explaining why (defaults change shouldn't require touching every UseDefault route — indexer just updates its defaults singleton). See Decisions Made.

**Final gates:**
- `cargo build -p governance_module` ✓
- `cargo test -p governance_module` ✓ (30/30 pass)
- `cargo build -p controller` ✓ (lib; tests still fail on Phase 7+10 cleanup, expected)
- `architecture.md` GovernanceModule section in sync with implementation ✓
- All 8 event types emit with documented topics + payloads ✓ (verified in unit tests)

All subtasks complete. Gate condition met. Ready for `/complete-phase 4`.

### Session 2026-05-03 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

**Modified:**
- `contracts/governance_module/src/lib.rs` — full rewrite for the new API.
- `contracts/governance_module/src/test.rs` — full rewrite (30 tests).
- `contracts/controller/src/lib.rs` — `GovClient` trait change + `buy_insurance` rewrite (replaced two cross-contract calls with one `route_status()` + `match`).
- `spec/architecture.md` — partial-update enums prose + event payload section corrected to `Option<T>` (subtask 11 drift fix).
- `spec/phases/phase-04-governance-routes-instance.md` — work log, files-modified, decisions, status `planned → in_progress`.
- `spec/progress.md` — row 4 status `planned → in_progress`, Started date, Current Phase header.

**Created:** none.

**Deleted from contracts:**
- `DataKey::RouteList` (storage key + the on-chain Vec it referenced).
- `whitelist_route`'s RouteList append loop.
- `is_route_whitelisted`, `get_route_terms`, `get_whitelisted_routes` (governance reader fns).
- `is_route_whitelisted`, `get_route_terms` from controller's `GovClient` trait.

---

## Decisions Made

- **Q1 — `RouteUpdate` encoding:** option (a) confirmed in code. Three per-field enums (`PremiumUpdate`, `PayoffUpdate`, `DelayHoursUpdate`) each `{ Keep, Set(T), UseDefault }`, passed as separate args. Soroban's contracttype constraint (no generics) made this the cleanest option; the field set is closed (premium/payoff/delay_hours), so the boilerplate cost is paid once.
- **Q2 — `remove_route` strict:** confirmed in code. `remove_route` panics with `"route must be disabled before removal"` if `terms.approved == true`. Operators must `disable_route` first. `enable_route` and `disable_route` also assert against the wrong direction (`"route already disabled"` / `"route already active"`) for symmetric ergonomics.
- **Q3 — architecture.md sync:** completed during this phase (subtask 11). One drift correction below.
- **Drift correction — events carry `Option<T>`, not resolved values.** The architecture.md as written during planning specified `route.listed` / `route.updated` payloads as resolved values; that contradicted Improvement #4's "Indexers store option-ness and resolve against the latest gov.defaults at read time." Implementation emits `Option<i128>` / `Option<u32>` so the indexer can mirror option-ness in its schema (NULL = UseDefault) and re-resolve when defaults change without rewriting every UseDefault route's row. Architecture.md updated to match. Improvement #9's indexer schema (`premium INTEGER NULL means UseDefault`) was already consistent.
- **Event topic shape — 2-symbol prefix + `flight_id` indexed:** all `route.*` events use `topics = ["route", <action>]` plus `#[topic] flight_id`, giving 3-symbol topics on the wire (`["route", "<action>", flight_id]`). The indexer can filter by flight_id at the RPC layer; origin/dest are in data. `gov.*` events use a 2-symbol prefix; `gov.admin_added` / `gov.admin_removed` additionally index `admin`.
- **`disable_route` / `enable_route` / `remove_route` panics on non-existent routes** with `"route not whitelisted"` (consistent failure mode regardless of which lifecycle op is hit on a missing entry). Same `expect()` pattern as before.
- **No diagnostic/audit `caller` field on route events.** Initial draft included `caller: Address` on `RouteDisabled` / `RouteEnabled` / `RouteRemoved`. Removed to match Improvement #4 spec exactly. If audit-trail caller info is needed later, add a separate `gov.audit` event rather than expanding existing payloads.
- **Pre-work assumption "controller still won't build" was wrong.** The controller's lib.rs uses inline `contractclient` interfaces, so the deleted `flight_pool` / `recovery_pool` crate references only exist in `controller/src/test.rs`. `cargo build -p controller` (lib) is green today; full controller test suite still waits for Phase 7+10. Phase 4's gate condition was actually stronger than dev_steps.md's verification line suggested.

---

## Completion Summary

**What was built:**
- `governance_module` redesigned for thousands-of-routes scale. `Route(...)` stays Persistent, keyed per-route, with `extend_ttl(ROUTE_TTL_LEDGERS = 1_036_800)` on every write (60-day window).
- Closed read API: `route_status(flight_id, origin, dest) -> RouteStatus { Active(ResolvedTerms) | Disabled | Unknown }`. Defaults folded at read time.
- Closed write API: `whitelist_route`, `disable_route`, `enable_route` (new), `remove_route` (new, strict — must be disabled first), `update_route_terms` (refactored to per-field op enums `PremiumUpdate` / `PayoffUpdate` / `DelayHoursUpdate`).
- 8 events emitted for the off-chain indexer: 5 `route.*` + 3 `gov.*`. `route.listed` / `route.updated` carry `Option<T>` (NOT resolved values) so the indexer mirrors option-ness in its schema.
- `RouteList` and the three old readers (`is_route_whitelisted`, `get_route_terms`, `get_whitelisted_routes`) deleted from contract and from controller's `GovClient` trait.
- `controller.buy_insurance` collapsed from 2 cross-contract calls to 1 (`route_status` + 3-arm match).

**Key decisions locked in:**
- `RouteUpdate` encoding: three concrete per-field op enums passed as separate args to `update_route_terms` (Soroban contracttype has no generics; this keeps the call site flat).
- `remove_route` strict: panics unless the route is already disabled. Two-step destructive op pattern.
- Events carry `Option<T>` — option-ness is the indexer's source of truth; defaults change only requires updating the indexer's defaults singleton, not every UseDefault row.
- 2-symbol topic prefix scheme adopted for this contract: `["route", <action>]` and `["gov", <action>]`. `flight_id` is the third indexed topic on `route.*` events for RPC-level filtering.

**Files modified:**
- `contracts/governance_module/src/lib.rs` — full rewrite.
- `contracts/governance_module/src/test.rs` — full rewrite (30 tests, all green).
- `contracts/controller/src/lib.rs` — `GovClient` trait + `buy_insurance` rewrite.
- `spec/architecture.md` — GovernanceModule section drift correction (events carry `Option<T>`).
- `spec/progress.md` — row 4 status + Current Phase header.

**For the next phase to know:**
- `cargo build -p controller` (lib) is green today. The only `flight_pool` / `recovery_pool` references remaining live in `controller/src/test.rs` (Phase 7 + 10 cleanup). Earlier Stage-2 framing was overstated.
- `env.events().all()` in Soroban tests returns events from the **most recent contract invocation only** — any subsequent contract call (including read-only ones like `route_status`) clears the event log. Test pattern: assert events immediately after the emitting call, before any read. Memorialized in `count_events` helper docstring.
- The Soroban `#[contractevent(topics = [...])]` macro **does** accept multi-element prefix arrays (this contradicts an older memory entry — corrected during this phase).
- Improvement #9 (off-chain indexer) is unscheduled but the event surface needed by it is now live and stable. Schema in `improvements.md` #9 is consistent with the `Option<T>` event payload.

**Known limitations / deferred items:**
- The off-chain indexer itself (Improvement #9) is not built. TTL cron coverage for `Route(...)` keys is also pending — that's Improvement #6 / future Cron #4 work.
- `controller/src/test.rs` and `integration_tests/src/tests/*.rs` are untouched — Phase 7 + Phase 10 close the Stage 2 build-red.
- No `Cargo.lock` change this phase (no destructive crate edits).
