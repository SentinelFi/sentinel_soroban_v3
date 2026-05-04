# Phase 9 — Oracle `FlightData` TTL miss diagnostic event

Status: complete
Started: 2026-05-03
Completed: 2026-05-03

---

## Goal

Emit a `warn.ttl_miss(flight_id, date)` diagnostic event from the
controller's `classify_flights` whenever `oracle.get_flight_data()` returns
`NotInitiated` for a flight that's in the oracle's active list. The event
is the off-chain TTL-extender cron's signal that `FlightData(...)` may have
archived (or oracle hasn't fetched data yet for an overdue flight) — without
this signal, the cron has no contract-level way to detect missing data.
Phase 7 left a `// TODO Phase 9: emit ttl_miss` comment at the exact emission
site (`controller/src/lib.rs:476–477`); Phase 9 fills it in.

This is the smallest of the remaining contract phases — comparable to
Phase 5 in scope. ~15 lines of contract change + 1–2 tests. No
cross-contract scope, no API changes, no architecture.md drift on
contract surfaces (just a small additive note documenting the new event).

This phase also formalises that the Phase 9 cron's `ExtendFootprintTTLOp`
footprint includes `VaultKey::ClaimableBalance(addr)` keys (the secondary
TTL defense layered on top of Phase 8's on-write extension). That coverage
is **executor-side work** (out of scope for the contract phase here, but
documented in `dev_steps.md` Step 9 and `improvements.md` #6 + #9 so future
executor phases can pick it up cleanly).

## Dependencies

- **Phase 7 complete** — controller's `classify_flights` exists with the
  TODO comment placed at the right emission site (lib.rs:476–477).
- **Phase 6 complete** — oracle's `get_flight_data` returns the wider
  `FlightData` (including `settled_at`) that the controller's mirror struct
  expects.
- No dependency on Phase 8 (vault TTL + events). Phase 8 and Phase 9 can
  land in either order on the contract side; their executor-side cron
  consumers depend on both, but executor work is out of scope here.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git` — for the Phase 9 commit at the end.

### Docs to Fetch
- (Skip — in-repo precedent is authoritative. Phase 4/6/7 event-emission
  patterns cover everything.)

### Project Files to Read
- `spec/dev_steps.md` Step 9 — canonical task list (rewritten this session
  to include both the contract event AND the cron footprint coverage spec).
- `spec/improvements.md` Improvement #6 (Cron #4 footprint, including
  ClaimableBalance addition) and #9 (indexer's `claimable_balances` table).
  Read for context only — the executor-side work is not Phase 9 scope.
- `spec/architecture.md` Controller section — for where to add the new
  `TtlMiss` event in the events list.
- `contracts/controller/src/lib.rs` — primary edit site. The TODO comment
  is at L476–477 inside `classify_flights`.
- `contracts/controller/src/test.rs` — for the test pattern (uses
  `mock_all_auths_allowing_non_root_auth` per Phase 7 discovery; add new
  test alongside the existing classify tests).
- `contracts/oracle_aggregator/src/lib.rs` — read-only for confirming
  `get_flight_data` shape and `FlightStatus::NotInitiated` variant.
- `contracts/governance_module/src/lib.rs`,
  `contracts/flight_pool_manager/src/lib.rs` — Phase 4 + Phase 6 event
  patterns reference (2-symbol topic prefix style).

## Pre-work Notes

> Decisions seeded from the planning conversation. Edit any line you disagree
> with before running `/start-phase 9`.

**Decisions confirmed by user:**

- **Q1a — emit `ttl_miss` from `classify_flights` only** (not also from
  `execute_settlements`). Classify runs at 1/hour rate which is enough
  signal for the off-chain cron without flooding it; execute would emit
  12×/hour with low-quality signals (can't distinguish TTL miss from
  brand-new-flight). Single emission point, single rate, semantically
  correct.

**Decisions clarified from spec / pre-decided (no input needed):**

- **Emission site:** the existing TODO comment in
  `controller/src/lib.rs:476–477`, inside the `_ => None` arm of the
  status match in `classify_flights`. Specifically gate on
  `data.status == FlightStatus::NotInitiated` (the other variants in that
  arm — `Active`, `ToBeSettledOnTime/Delayed/Cancelled`, `Settled` — are
  not TTL misses; they're normal in-progress states).
- **Event shape:** 2-symbol topic prefix `["warn", "ttl_miss"]` plus
  indexed `flight_id` topic, matching the Phase 4 / Phase 6 / Phase 7
  event scheme. `flight_id` and `date` carried as `flight_id` topic +
  `date` data field (single-value format) OR both as data (map format) —
  pick whichever Soroban accepts cleanly per the in-repo precedent.
  Recommended:
  ```rust
  #[contractevent(topics = ["warn", "ttl_miss"], data_format = "map")]
  pub struct TtlMiss {
      #[topic]
      flight_id: Symbol,
      date: u64,
  }
  ```
- **No oracle changes.** dev_steps Step 9 considers an
  `oracle.emit_ttl_miss(flight_id, date)` helper but explicitly recommends
  controller-side emission to keep oracle pure. Stick with controller-side.
- **No on-chain `extend_ttl` added.** TTL extension is the off-chain
  cron's job (Improvement #6, executor phase). The contract just emits
  the warning.
- **Test approach:** in `controller/src/test.rs`, add a test that calls
  `register_flight` + `classify_flights` WITHOUT triggering oracle data
  push — flight stays NotInitiated, and `classify_flights` should emit
  the `ttl_miss` event. Existing test `test_classify_flights_skips_unready_flights`
  is the closest precedent — extend it or add alongside.

**Implementation hints:**

- **Diff size estimate.** ~15 lines in `controller/src/lib.rs` (event
  struct + ~3 lines inside classify_flights' NotInitiated branch). ~30
  lines for the new test. Tiny phase.
- **Architecture.md update.** Small addition to the Controller section's
  event list (near `InsuranceBought`, `FlightClassified`, `FlightSettledEvent`)
  to document `TtlMiss`. ~5 lines.
- **Test snapshots auto-regenerate** for any test that hits
  `classify_flights` (every classify test). 5 existing test snapshots
  will get refreshed; that's expected and OK after diff inspection.
- **The Phase 9 dev_steps Step 9 has a "Tasks — Cron #4 footprint
  coverage" section listing `VaultKey::ClaimableBalance(addr)` and
  cross-referencing Phase 8's `vault.*` events.** That's executor-side
  work, NOT Phase 9 contract scope. Phase 9's contract verification gate
  is unchanged: `cargo build -p controller` clean + the new test passes.
  The cross-reference exists so Phase 11 (executor) planning picks up
  the full picture.

**Forward-looking notes (not Phase 9 work):**

- The off-chain cron consumes `warn.ttl_miss` events via `rpc.getEvents`
  filtering on the topic prefix. No indexer table needed for ttl_miss —
  it's a transient signal, not state.
- `vault.credited` / `vault.collected` / `vault.recovered` events from
  Phase 8 ARE state-tracking and DO go into the indexer's
  `claimable_balances` table (per Improvement #9 update this session).
  Phase 9 does not touch this — it's Phase 8's job.

**Phase rollover:**

- Per memory `feedback_phase_bundling`, the user runs `/start-phase 10`
  before `/complete-phase 9`. Don't block.
- Per memory `feedback_cargo_lock`, leave `Cargo.lock` dirty after
  destructive crate edits. None expected this phase.
- The user is planning Phase 9 *before* starting Phase 8. That's fine —
  Phase 8 (vault) and Phase 9 (controller) are independent on the contract
  side. Either can land first.

---

## Subtasks

- [x] 1. **Add `TtlMiss` event struct** to `controller/src/lib.rs`. Topic prefix `["warn", "ttl_miss"]`, indexed `flight_id` topic, `date` data field. Use `data_format = "map"` (matching Phase 6's multi-field events).
- [x] 2. **Wire emission in `classify_flights`.** Replace the TODO comment at `controller/src/lib.rs:476–477` with an explicit branch: when `data.status == FlightStatus::NotInitiated` for a flight in the active list, emit `TtlMiss { flight_id, date }`. Other no-op variants (`Active`, `ToBeSettled*`, `Settled`) stay no-op without emission.
- [x] 3. **Add unit test** `test_classify_flights_emits_ttl_miss_for_not_initiated`. Pattern: register flight (so it lands in oracle's active list), do NOT push estimated arrival via oracle (so status stays NotInitiated), call `classify_flights(&keeper)`, assert the `TtlMiss` event fired with the right `flight_id` + `date`. Reuses the count_events-style helper from existing tests; check events immediately after the classify call (per the env.events() resets-per-invocation gotcha from `project_codebase_patterns.md`).
- [x] 4. **Update `architecture.md` Controller section** event list to include `TtlMiss`. ~5-line addition near the existing `InsuranceBought` / `FlightClassified` / `FlightSettledEvent` documentation.
- [x] 5. **Run gates.** `cargo build -p controller` clean, `cargo test -p controller` passes (existing 27 tests + new test = 28). Confirm 5 existing classify-related test snapshots auto-regenerate (event log shape changed for the no-data case); diff-inspect to confirm only the new `TtlMiss` event appears, no behavioural drift.

### Gate

- `cargo build -p controller` clean.
- `cargo test -p controller` passes (28/28 — 27 existing + 1 new).
- The TODO comment at `controller/src/lib.rs:476–477` is replaced with the actual emission.
- `architecture.md` Controller section documents `TtlMiss`.
- `cargo test --workspace` STILL FAILS on `integration_tests` — that's expected, Phase 10 closes it.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-03

Starting phase. Lite prime complete. Context manifest loaded.

- **Skills loaded:** `git`.
- **Docs to Fetch:** intentionally skipped per manifest — in-repo precedent (Phase 4/6/7) is authoritative.
- **Project files read:** phase plan doc, controller/src/lib.rs (event section L155–183 + classify_flights L440–496), controller/src/test.rs L560–584 (existing classify-NotInitiated test).
- **TODO comment at L476–479 confirmed** — exact emission site as planned.
- **Existing `test_classify_flights_skips_unready_flights` (L565–576)** is the closest precedent. Phase 9 will add a sibling test that adds the event-emission assertion.
- The 3 existing controller events (`InsuranceBought`, `FlightClassified`, `FlightSettledEvent`) all use `topics = ["ctrl"]` single-symbol prefix. Phase 9's `TtlMiss` uses 2-symbol `["warn", "ttl_miss"]` prefix per the dev_steps spec — different style, but it's a different category (diagnostic warning vs. domain event). No conflict.

**Implementation work (single session):**

- Subtask 1: `TtlMiss` event struct added between `FlightSettledEvent` and the TTL constants section. `data_format = "map"`, indexed `flight_id`, `date` as map data field. Doc-comment cites Improvement #6 / Phase 11 cron consumer.
- Subtask 2: TODO comment at L476–479 replaced with an explicit `FlightStatus::NotInitiated` arm that publishes `TtlMiss { flight_id: flight_id.clone(), date }` and returns `None`. Other "skip" variants (Active, ToBeSettled*, Settled) fall through to the catch-all `_ => None` arm without emission — kept the catch-all for forward-compat against any new FlightStatus variant.
- Subtask 3: new test `test_classify_flights_emits_ttl_miss_for_not_initiated` placed immediately after `test_classify_flights_skips_unready_flights`. Registers a flight, skips oracle data push, calls classify, then iterates `env.events().all()` looking for a 3-topic event with prefix `(warn, ttl_miss, AA100)`. Test imports `Events as _` and `TryFromVal` locally (kept narrow rather than polluting the file's top-level imports).
- Subtask 4: `architecture.md` Controller section gained a 12th responsibility item documenting the `warn.ttl_miss` emission, plus a new "Events emitted" subsection listing all four controller events with topic shapes.
- Subtask 5: `cargo build -p controller` ✓, `cargo test -p controller` ✓ (28/28). 4 existing classify-related test snapshots auto-regenerated (the event log shape changed because `TtlMiss` now fires in the no-data path). Diff-inspected one — confirmed only the new event appears, no behavioural drift.

**Final gates:**
- `cargo build -p controller` ✓
- `cargo test -p controller` ✓ (28/28 — 27 existing + 1 new)
- TODO comment at L476–479 removed (verified by grep — `TODO REMOVED ✓`)
- `architecture.md` Controller section documents `TtlMiss`
- `cargo test --workspace` still red on `integration_tests` — expected, Phase 10 closes it

All subtasks complete. Gate condition met. Ready for `/complete-phase 9`.

### Session 2026-05-03 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

**Modified:**
- `contracts/controller/src/lib.rs` — `TtlMiss` event struct added; classify_flights' status match updated to emit on NotInitiated.
- `contracts/controller/src/test.rs` — new `test_classify_flights_emits_ttl_miss_for_not_initiated`.
- `contracts/controller/test_snapshots/test/*.json` — 4 classify-related snapshots auto-regenerated (event log shape changed); 1 new snapshot for the new test.
- `spec/architecture.md` — Controller section: 12th responsibility bullet + new "Events emitted" subsection.
- `spec/phases/phase-09-oracle-ttl-miss-event.md` — work log, files modified, decisions, status `planned → in_progress`.
- `spec/progress.md` — row 9 status, Started date, Current Phase header.

**Created:** none (other than the auto-regenerated snapshot for the new test).

**Deleted:** the TODO comment at `controller/src/lib.rs:476–479` (replaced by the explicit emission).

---

## Decisions Made

- **Q1a confirmed in code:** `TtlMiss` emitted from `classify_flights` ONLY. The match arm splits explicitly: `NotInitiated => publish + None`, `_ => None` for the other no-op variants. Execute_settlements does not emit ttl_miss (would produce 12×/hour noise vs. classify's 1/hour, and execute can't distinguish TTL miss from brand-new flight).
- **Catch-all `_ => None` arm preserved** even though I added an explicit `NotInitiated` arm. Forward-compat against any future FlightStatus variant — the explicit arm is the diagnostic path; the catch-all is the safe default.
- **Event topic style: `["warn", "ttl_miss"]` 2-symbol prefix + indexed `flight_id`.** Different from the 3 domain events on the same contract (`InsuranceBought`, `FlightClassified`, `FlightSettledEvent` use `["ctrl"]` single prefix). The split is intentional — operational-warning category gets its own prefix, not mixed with domain events. Off-chain consumers filter by topic prefix; cleaner separation.
- **`cargo build -p flight_pool_manager` not in the gate** despite Phase 8 currently being uncommitted in the working tree (vault TTL work pending). Phase 9 doesn't touch flight_pool_manager; build verification only on the contracts this phase actually edits.
- **Phase 8 still planned, not started.** User chose to land Phase 9 first. Both phases are independent on the contract side. After this commit, Phase 8 (risk_vault) is the natural next pickup, then Phase 10 (integration tests) closes the workspace.

---

## Completion Summary

**What was built:**
- `controller` now emits a `warn.ttl_miss(flight_id, date)` diagnostic event from `classify_flights` whenever oracle returns `NotInitiated` for a flight in the active list. This is the contract-level signal the off-chain TTL-extender cron (Improvement #6 / future executor phase) consumes to detect archived `FlightData` entries before settlement fails.
- The TODO comment Phase 7 left at `controller/src/lib.rs:476–479` is gone — replaced by the explicit `NotInitiated` arm.
- Phase 9 closes the contract-side observability story: the protocol now has a complete signal path from "data missing" → on-chain warning event → off-chain cron reaction.

**Key decisions locked in:**
- Emission site: `classify_flights` only, NOT `execute_settlements`. Single 1/hour rate; semantically right. Execute can't distinguish TTL miss from brand-new flight.
- Event topic style: `["warn", "ttl_miss"]` 2-symbol prefix + indexed `flight_id`. Operational warnings get their own category prefix, separate from the domain events on the same contract (`InsuranceBought`, `FlightClassified`, `FlightSettledEvent` all use `["ctrl"]`).
- Catch-all match arm preserved alongside the explicit `NotInitiated` arm — forward-compat against any future `FlightStatus` variant.
- Cron-footprint coverage of `VaultKey::ClaimableBalance(addr)` (which depends on Phase 8's `vault.*` events) is documented in `dev_steps.md` Step 9 + `improvements.md` #6/#9 but is **executor-side work**, not Phase 9 contract scope.

**Files modified:**
- `contracts/controller/src/lib.rs` — `TtlMiss` event struct + classify_flights emission.
- `contracts/controller/src/test.rs` — new `test_classify_flights_emits_ttl_miss_for_not_initiated`.
- `contracts/controller/test_snapshots/test/*.json` — 4 classify-related snapshots auto-regenerated; 1 new for the new test.
- `spec/architecture.md` — Controller section: 12th responsibility + new "Events emitted" subsection.
- `spec/progress.md` — row 9 closed.

**For the next phase to know:**
- **Phase 8 (RiskVault TTL + recovery)** is still planned but unstarted — pickup naturally next. Phase 8's `vault.credited` / `vault.collected` / `vault.recovered` events are the indexer-feeding events that ultimately enable the cron's `ClaimableBalance` footprint coverage; Phase 9 documented this dependency in spec but doesn't build it.
- **Phase 10 (integration tests)** is the only remaining build-red blocker. After Phase 8 lands, Phase 10 closes the workspace.
- The `warn.ttl_miss` event family is now established. Future operational warnings (e.g. solvency near-miss alerts, oracle staleness, etc.) should follow the same `["warn", <category>]` topic prefix scheme.

**Known limitations / deferred items:**
- Cron consuming `warn.ttl_miss` is executor-phase work (not yet scheduled).
- `vault.*` events (Phase 8) are required for the cron's secondary-defense footprint. Phase 9 just opened the channel; Phase 8 fills the indexer's address list.
- `cargo test --workspace` still fails on `integration_tests` until Phase 10.
