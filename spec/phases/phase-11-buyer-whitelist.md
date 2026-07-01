# Phase 11 — Buyer whitelist on Controller (admin-toggled)

Status: complete
Started: 2026-05-23
Completed: 2026-07-01

---

## Goal

Add an **admin-managed buyer whitelist** to the `Controller`, gating
`buy_insurance` behind an opt-in allowlist that the admin can populate, prune,
and turn off again. When the toggle is **off** (default), `buy_insurance`
remains public exactly as today; when the toggle is **on**, only addresses
explicitly added by an admin can buy.

This is the first **Phase 11+** contract change since the Phase 3 reorg closed
on 2026-05-03. Scope is one contract (`controller`), one cross-contract read
(`gov.is_admin`), three new entry points, two new storage keys, three new
events, and a one-line gate at the top of `buy_insurance`.

## Design — recap of confirmed direction

- **Whitelist lives on Controller**, not GovernanceModule. The check sits at
  the top of `buy_insurance`; putting the state local keeps that hot-path read
  to a single Instance + single Persistent storage lookup (no cross-contract
  call on every buy).
- **Admin authority is reused** from `GovernanceModule`. Controller's
  `add_buyer` / `remove_buyer` admin paths cross-call into `gov.is_admin(caller)`
  rather than maintaining a second admin list. One source of truth for admin
  roles. Cross-call cost is paid only on rare admin writes, not on buys.
- **Toggle is owner-only.** The kill-switch is a tighter trust action than
  add/remove — only the protocol owner can flip it. Default is **false**
  (existing flow preserved across deploy).
- **`recover_uncollected` precedent for Pausable**: admin paths are NOT gated
  by Pausable. Admin must be able to manage the whitelist during a pause. The
  buy gate itself is already inside the existing `#[when_not_paused]` block, so
  the on-chain pause naturally also blocks whitelisted buys.

## Dependencies

- Phase 3 reorg closed (controller wired with `GovernanceModule`,
  `is_admin(addr)` already exposed in `governance_module/src/lib.rs:284`).
- No upstream contract changes required — `gov.is_admin` already exists from
  Phase 4, just needs to be added to `interfaces.rs` `GovernanceInterface`.

## Context Manifest

### Skills
- `git` — for the Phase 11 commit at the end.

### Project Files to Read
- `contracts/controller/src/lib.rs` — module wiring.
- `contracts/controller/src/storage.rs` — `CtrlKey` enum + TTL constants.
- `contracts/controller/src/auth.rs` — `require_keeper` precedent for the
  caller-auth + stored-address-assert pattern we'll mirror.
- `contracts/controller/src/admin.rs` — `#[only_owner]` setter precedent.
- `contracts/controller/src/purchase.rs` — exact gate insertion point at the
  top of `buy_insurance`.
- `contracts/controller/src/events.rs` — event style (topic prefixes,
  `data_format = "map"` vs `"single-value"`).
- `contracts/controller/src/interfaces.rs` — add `is_admin` to
  `GovernanceInterface`.
- `contracts/controller/src/queries.rs` — read accessors live here.
- `contracts/controller/src/test.rs` — existing fixture pattern.
- `contracts/governance_module/src/lib.rs:284` — `is_admin` already implemented.
- `contracts/integration_tests/src/tests/setup.rs` — `TestEnv` fixture +
  `count_events_with_topic` helper.

## Pre-work Notes

**Decisions confirmed by user (chat 2026-05-23):**

- Controller-local storage for the whitelist + toggle. ✓
- Reuse `GovernanceModule.is_admin` for admin gating on add/remove paths. ✓
- Owner-only for the toggle (kill-switch is tighter than add/remove). ✓
- Default toggle = **false** (existing flow unchanged on deploy). ✓
- Protocol-wide single whitelist (not per-route). ✓

**Decisions clarified from in-repo precedent:**

- **Storage tiers** mirror the existing `TravelerFlights(Address)` pattern:
  - `WhitelistEnabled` → Instance (single-row global state)
  - `BuyerWhitelisted(Address)` → Persistent (per-address, scales with users)
- **Persistent TTL on `BuyerWhitelisted(addr)`**: 60 days, same constant as
  `TRAVELER_FLIGHTS_TTL_LEDGERS`. Don't introduce a separate constant — reuse
  the existing one. The TTL is refreshed on every write to that address; idle
  entries can be archived (loss-of-access defaults to "not whitelisted" which
  is the safe direction — if anything goes wrong the user just can't buy).
- **Event topic style** follows the existing 2-symbol prefix scheme used by
  recent additions (`["sentinel", "ttl_miss"]`, etc.):
  - `["sentinel", "buyer_whitelisted"]` — `addr: Address` (topic)
  - `["sentinel", "buyer_removed"]` — `addr: Address` (topic)
  - `["sentinel", "whitelist_toggled"]` — `enabled: bool` (data)
- **Gate placement.** Top of `buy_insurance`, **before** the existing route
  lookups so the cheapest check runs first and we don't pay for cross-contract
  calls before failing. Sequence becomes:
  1. `traveler.require_auth()`
  2. **NEW**: whitelist gate (single Instance read; Persistent read only if
     toggle is on)
  3. Route lookup, lead-time, register, solvency, transfer, etc.
- **Fuzz coverage**: the whitelist state machine is two booleans
  (`enabled` + `is_whitelisted(addr)`) — exhaustive unit tests cover the
  product space without random sampling. **No fuzz harness needed**; document
  this decision in the work log so a future audit pass sees the rationale.

**Implementation hints:**

- Putting the auth helper in `auth.rs` keeps the cross-contract call
  centralised. Helper name: `require_owner_or_gov_admin(e, &caller)`.
- The `is_admin` cross-call wants the same `GovClient` that already exists in
  `purchase.rs` — just extend its trait. No new client type.
- New entry points go in a small new file `whitelist.rs` (mirrors how
  `purchase.rs` / `settle.rs` are scoped per-concern) — keeps `admin.rs`
  focused on owner setters.
- Read accessors go in `queries.rs` (one-liners next to `get_keeper`).

## Subtasks

- [x] 1. **Extend `interfaces.rs`** — add `fn is_admin(env: &Env, addr: Address) -> bool;` to the `GovernanceInterface` trait so the `GovClient` exposes it. No other interface changes.
- [x] 2. **Extend `storage.rs`** — add two `CtrlKey` variants: `WhitelistEnabled` (Instance, bool) and `BuyerWhitelisted(Address)` (Persistent, bool). Add a `set_buyer_whitelisted(e, addr, allowed)` helper that writes the entry and extends Persistent TTL (reuse `TRAVELER_FLIGHTS_TTL_LEDGERS`).
- [x] 3. **Extend `auth.rs`** — add `require_owner_or_gov_admin(e, &caller)` that mirrors the GovernanceModule `require_owner_or_admin` pattern but cross-calls `GovClient::is_admin` instead of reading local storage. Bails out early if owner.
- [x] 4. **Extend `events.rs`** — three new `#[contractevent]` structs: `BuyerWhitelistedEvent { addr: Address }`, `BuyerWhitelistRemovedEvent { addr: Address }`, `WhitelistToggled { enabled: bool }`. Topic prefixes per the design above.
- [x] 5. **New file `whitelist.rs`** — three entry points:
  - `add_whitelisted_buyer(caller, addr)` — admin-gated, writes the Persistent entry, extends TTL, emits `BuyerWhitelistedEvent`.
  - `remove_whitelisted_buyer(caller, addr)` — admin-gated, removes the entry, emits `BuyerWhitelistRemovedEvent`.
  - `set_whitelist_enabled(enabled)` — `#[only_owner]`, writes the Instance entry, emits `WhitelistToggled`.
- [x] 6. **Wire the gate** in `purchase.rs`. After `traveler.require_auth()`, read `WhitelistEnabled`; if true, assert `BuyerWhitelisted(traveler)` is `true`, else panic `"buyer not whitelisted"`.
- [x] 7. **Read accessors** in `queries.rs`: `is_whitelisted(addr) -> bool`, `whitelist_enabled() -> bool`.
- [x] 8. **Module wiring** — add `mod whitelist;` to `controller/src/lib.rs`.
- [x] 9. **Unit tests** in `controller/src/test.rs`. Eight new tests covering: default-off purchase still works, toggle-on blocks non-whitelisted (panic), toggle-on allows whitelisted, admin (via gov) can add, owner can add, non-admin add panics, owner can toggle, non-owner toggle panics, remove works, events emitted with correct topics.
- [x] 10. **Integration test** — new file `integration_tests/src/tests/group9_whitelist.rs` registered in `mod.rs`. End-to-end coverage: gov admin adds buyer through the real wiring; toggle off → on → off → on cycle with realistic buy/disable; pausable interaction (pause halts buys but whitelist add/remove still works).
- [x] 11. **Docs** — `spec/architecture.md` Controller section: add the new responsibility bullet + new events list entries + storage layout additions. `spec/progress.md`: add Phase 11 row.
- [x] 12. **Gate**:
  - `cargo build -p controller` clean.
  - `cargo test -p controller` passes (existing 40+ tests + ~8 new).
  - `cargo test -p integration_tests` passes (existing tests + new group9).
  - `cargo test --workspace` green.

### Gate

- `cargo build --workspace` clean.
- `cargo test --workspace` green, no regressions.
- New events visible in event log on add/remove/toggle.
- The `whitelist_enabled` defaults to `false` after constructor — existing
  test snapshots that don't touch the whitelist must not change in shape.

---

## Work Log

### Session 2026-05-23

Starting phase. User confirmed direction in chat: controller-local storage,
governance-admin for add/remove, owner-only toggle, default off, single
protocol-wide list. Fuzz skipped (state machine is two booleans —
exhaustive unit tests cover the product space).

Implementation order: interfaces → storage → auth → events → whitelist → wire
gate → queries → mod wiring → unit tests → integration tests → docs → gate.

### Session 2026-07-01 — Completed

Phase validated by user. All gate conditions met:
- `cargo test --workspace` green — **329 tests pass** (59 controller incl. 12
  whitelist unit tests; 88 integration incl. 8 `group9_whitelist` tests; no
  regressions in other crates).
- `cargo clippy --workspace --all-targets` clean.
- `cargo fmt --all --check` clean.
- `whitelist_enabled` defaults to `false` after constructor; default-off flow
  confirmed unchanged (`test_whitelist_disabled_by_default`,
  `test_whitelist_disabled_allows_any_buyer`).
- Add/remove/toggle events verified emitted with correct topics.

---

## Completion Summary

**What was built.** An admin-managed buyer whitelist on `Controller`, gating
`buy_insurance` behind an opt-in allowlist. Toggle defaults **off** (buy stays
public exactly as before); when **on**, only admin-added addresses can buy.

**Key decisions locked in.**
- Whitelist state is **Controller-local** — hot path stays one Instance read
  (toggle) plus one Persistent read (entry) only when the toggle is on; no
  cross-contract call on the buy path.
- Admin authority for add/remove is **reused from `GovernanceModule`** via
  `GovClient::is_admin` (single source of truth), paid only on rare admin
  writes. The toggle is **owner-only** (tighter kill-switch trust).
- Admin paths are **not Pausable-gated** (admin must manage the list during a
  pause); the buy gate lives inside the existing `#[when_not_paused]` block, so
  a pause naturally halts whitelisted buys too.
- Persistent entry TTL reuses `TRAVELER_FLIGHTS_TTL_LEDGERS`; an active buyer's
  approval is refreshed on each buy via `touch_buyer_whitelisted`. Archival
  fails safe (defaults to "not whitelisted").
- No fuzz harness — the state machine is two booleans, covered exhaustively by
  unit tests.

**Files created.**
- `contracts/controller/src/whitelist.rs`
- `contracts/integration_tests/src/tests/group9_whitelist.rs`

**Files modified.**
- `contracts/controller/src/lib.rs` — `mod whitelist;`
- `contracts/controller/src/storage.rs` — `CtrlKey::WhitelistEnabled` +
  `CtrlKey::BuyerWhitelisted(Address)` + read/write/touch helpers.
- `contracts/controller/src/auth.rs` — `require_owner_or_gov_admin`.
- `contracts/controller/src/interfaces.rs` — `is_admin` on `GovernanceInterface`.
- `contracts/controller/src/events.rs` — three event structs.
- `contracts/controller/src/purchase.rs` — gate at top of `buy_insurance`.
- `contracts/controller/src/queries.rs` — `is_whitelisted` + `whitelist_enabled`.
- `contracts/controller/src/error.rs` — `NotOwnerOrGovernanceAdmin (305)`,
  `BuyerNotWhitelisted (306)`.
- `contracts/controller/src/test.rs` — whitelist unit tests.
- `contracts/integration_tests/src/tests/mod.rs` — `mod group9_whitelist;`.
- `spec/architecture.md`, `spec/progress.md` — docs.

**For the next phase.** Whitelist ships **off** by default, so deployment order
is unaffected; flipping it on is a post-deploy owner action. No known
limitations or deferred items within this phase's scope.

---

## Files Created / Modified

**Created:**
- `contracts/controller/src/whitelist.rs`
- `contracts/integration_tests/src/tests/group9_whitelist.rs`
- `spec/phases/phase-11-buyer-whitelist.md` (this file)

**Modified:**
- `contracts/controller/src/lib.rs` — `mod whitelist;` added.
- `contracts/controller/src/storage.rs` — `CtrlKey::WhitelistEnabled` + `CtrlKey::BuyerWhitelisted(Address)` + helper.
- `contracts/controller/src/auth.rs` — `require_owner_or_gov_admin` helper.
- `contracts/controller/src/interfaces.rs` — `is_admin` on `GovernanceInterface`.
- `contracts/controller/src/events.rs` — three new event structs.
- `contracts/controller/src/purchase.rs` — gate at the top of `buy_insurance`.
- `contracts/controller/src/queries.rs` — `is_whitelisted` + `whitelist_enabled`.
- `contracts/controller/src/test.rs` — new tests.
- `contracts/integration_tests/src/tests/mod.rs` — `mod group9_whitelist;`.
- `spec/architecture.md` — Controller section update.
- `spec/progress.md` — Phase 11 row.
