# Dev Steps — Phase 3 Contract Changes

Contract-level changes only. One step per contract action (delete / add / modify).
Order matters: deletions and the new contract come first; per-contract refactors
(storage tiers, API surfaces, queue placement) come next; explicit TTL tuning
and observability are grouped near the bottom (steps 8–9); integration tests are
last as the green-build gate.

`mock_usdc/` is unchanged in this phase and is not listed.

---

## Step 1 — DELETE `contracts/flight_pool/`

**Action:** Delete the entire directory.

**Why:** Replaced by the singleton `flight_pool_manager` (Improvement #1). The
per-flight WASM-deploy pattern is being removed; no caller will reference this
contract after Step 3.

**Tasks:**
- Remove `contracts/flight_pool/` from disk.
- Remove `flight_pool` from the workspace `members` array in `contracts/Cargo.toml`.
- Remove the `flight_pool` entry from `contracts/Cargo.lock` (regenerated on next build).
- Grep the workspace for `flight_pool` and `FlightPool` references — leave only
  the ones inside `controller/`, `integration_tests/`, and the executor (those
  are cleaned up in later steps).

**Verification:** `cargo build -p flight_pool` fails with "package not found".

---

## Step 2 — DELETE `contracts/recovery_pool/`

**Action:** Delete the entire directory.

**Why:** Recovery accounting is folded into `FlightPoolManager` as the
`RecoveredBalance` instance entry plus `sweep_expired` / `withdraw_recovered`
(Improvement #1). A standalone contract is no longer needed.

**Tasks:**
- Remove `contracts/recovery_pool/` from disk.
- Remove `recovery_pool` from the workspace `members` array in `contracts/Cargo.toml`.
- Remove the `recovery_pool` entry from `contracts/Cargo.lock`.
- Grep for `recovery_pool` / `RecoveryPool` — references in `controller/` and
  `integration_tests/` are cleaned up in their own steps.

**Verification:** `cargo build -p recovery_pool` fails with "package not found".

---

## Step 3 — ADD `contracts/flight_pool_manager/`

**Action:** Create a brand-new contract crate.

**Why:** Singleton replacement for the per-flight `FlightPool` deploy pattern,
also absorbing recovery-pool duties (Improvement #1). One contract holds all
flight configs, all buyers, all premiums, and all swept balances.

**Crate skeleton:**
- `contracts/flight_pool_manager/Cargo.toml` (mirror `flight_pool/Cargo.toml`).
- `contracts/flight_pool_manager/src/lib.rs`.
- `contracts/flight_pool_manager/src/test.rs`.
- Add `flight_pool_manager` to workspace `members` in `contracts/Cargo.toml`.

**Lockfile cleanup (cross-phase addendum, intentional):**

Phases 1 and 2 left `contracts/Cargo.lock` with stale `flight_pool` and
`recovery_pool` package entries because `controller/Cargo.toml` and
`integration_tests/Cargo.toml` still hold path-deps to the deleted crates
— so Cargo cannot resolve the workspace, and `cargo update` /
`cargo generate-lockfile` both fail. To unblock the lockfile regen as part
of this phase rather than waiting for Phases 7 + 10:

- In `contracts/controller/Cargo.toml`, **delete** these dep lines:
  - `flight_pool = { path = "../flight_pool" }`
  - `recovery_pool = { path = "../recovery_pool" }`
- In `contracts/integration_tests/Cargo.toml`, **delete** these dep lines:
  - `flight_pool = { path = "../flight_pool" }`
  - `recovery_pool = { path = "../recovery_pool" }`
- Also **add** in both files: `flight_pool_manager = { path = "../flight_pool_manager" }`
  (Phase 7 and Phase 10 will need it; landing it here means their Cargo.toml
  edits are zero.)
- Do **not** touch any `.rs` files in `controller/` or `integration_tests/` —
  those still reference the deleted crates and will fail to build until
  Phases 7 and 10 rewrite their imports. That is the expected and correct
  state.

**Effect:** the workspace now resolves. `cargo build -p flight_pool_manager`
runs cleanly; `cargo update --workspace` regenerates `Cargo.lock` (the stale
`flight_pool` / `recovery_pool` package entries drop out automatically).
`cargo build -p controller` and `cargo build -p integration_tests` still
fail (Rust-code references), but per-crate builds for everything else now
work — which restores the ability to verify Phases 4–6 with normal `cargo
build -p <name>` commands.

**Storage layout (`PoolKey`):**
- Instance: `Owner`, `Controller`, `UsdcToken`, `RiskVault`,
  `ActiveFlightList: Vec<(Symbol, u64)>`, `RecoveredBalance: i128`.
- Persistent: `FlightConfig(Symbol, u64)`, `Buyer(Symbol, u64, Address)`,
  `Claimed(Symbol, u64, Address)`.

**`FlightConfig` struct:** `premium: i128`, `payoff: i128`, `delay_hours: u32`,
`buyer_count: u32`, `status: SettlementStatus`, `claim_expiry: u64`.

**`SettlementStatus` enum:** `Active | SettledOnTime | SettledDelayed | SettledCancelled`.

**Functions:**
- `initialize(env, owner, usdc_token, risk_vault)`.
- `set_controller(env, owner, controller)` — owner-auth, one-time write.
- `register_flight(env, controller, flight_id, date, premium, payoff, delay_hours)`
  — controller-auth; panic if already registered; append to `ActiveFlightList`;
  store `FlightConfig{ status: Active, .. }`.
- `add_buyer(env, controller, flight_id, date, buyer)` — controller-auth; panic
  if not registered or already settled; set `Buyer` key; increment `buyer_count`;
  set `Buyer` TTL to `claim_expiry + 30 days`.
- `settle_on_time(env, controller, flight_id, date)` — transfer
  `premium * buyer_count` to RiskVault via `record_premium_income()`;
  set status `SettledOnTime`; remove from `ActiveFlightList`.
- `settle_delayed(env, controller, flight_id, date, claim_expiry)` — set status
  `SettledDelayed`, store `claim_expiry`, remove from `ActiveFlightList`.
- `settle_cancelled(...)` — same as above but `SettledCancelled`.
- `claim(env, traveler, flight_id, date)` — traveler-auth; require
  `SettledDelayed` or `SettledCancelled`; require `Buyer` exists; require
  `Claimed` not set; require `now < claim_expiry`; set `Claimed`; transfer
  `payoff` USDC.
- `sweep_expired(env, flight_id, date)` — require `now > claim_expiry`; compute
  unclaimed amount = `payoff * (buyer_count - claimed_count)`; credit
  `RecoveredBalance`. (Track `claimed_count` on `FlightConfig` or via a per-flight
  counter so `sweep_expired` can compute without iterating buyers.)
- `withdraw_recovered(env, owner, amount)` — owner-auth; debit
  `RecoveredBalance`; transfer USDC out.
- Read functions: `get_flight_config`, `has_policy`, `has_claimed`,
  `get_active_flights`, `get_recovered_balance`.

**Verification:**
- `cargo build -p flight_pool_manager` succeeds.
- `cargo update --workspace` regenerates `Cargo.lock`; the resulting file
  contains no `[[package]] name = "flight_pool"` or `name = "recovery_pool"`
  entries, and no `dependencies` lists reference them.
- Unit tests in `src/test.rs` cover register → buy → settle → claim → sweep
  → withdraw paths.

---

## Step 4 — MODIFY `contracts/governance_module/`

**Action:** Holistic redesign — TTL strategy, typed-enum read API, explicit
lifecycle operations, partial-update semantics, and events for an off-chain
indexer (Improvement #4).

**Why:** Routes scale to thousands in production (many
`(flight_id, origin, dest)` tuples across hub airports). At that scale:
- **Instance is wrong** — every invocation loads all Instance entries into
  the tx footprint; thousands of routes blow past per-tx limits.
- **Persistent without a TTL strategy is what exists today** — entries
  archive silently and `buy_insurance` panics with `"route not found"`,
  indistinguishable from a never-whitelisted route.
- **`RouteList`** (one `Vec` of every route) is a footprint hazard at any
  tier — a single storage entry holding thousands of tuples.

The fix is layered: keep keyed `Route(...)` Persistent, add a TTL strategy
(in-contract on writes + owner cron on idle entries), collapse the read API
to a typed enum, make updates safely partial, emit events so an off-chain
indexer owns enumeration.

**Storage:**
- `Route(flight_id, origin, dest) → RouteTerms` — **stays Persistent**, keyed
  per-route, independent TTL.
- **`RouteList` is removed.** Enumeration moves off-chain.
- Instance entries (`Owner`, `Admin(addr)`, `DefaultPremium`, `DefaultPayoff`,
  `DefaultDelayHours`) unchanged.

**Read API:**

Define a typed enum that distinguishes the three on-chain states:
```rust
#[contracttype]
pub enum RouteStatus {
    Active(ResolvedTerms),  // entry exists, approved == true
    Disabled,               // entry exists, approved == false
    Unknown,                // entry missing (never whitelisted, archived, or removed)
}

pub fn route_status(env, flight_id, origin, dest) -> RouteStatus;
```

**Drop:** `is_route_whitelisted`, `get_route_terms`, `get_whitelisted_routes`.
**Keep:** `get_defaults`, `is_admin`.

Controller's `buy_insurance` switches from two redundant cross-contract
calls (`is_route_whitelisted` + `get_route_terms`) to one `route_status()`
call + match.

**Write API:**
- `whitelist_route` — drops the `RouteList` append; emits `route.listed`.
- `disable_route` — soft-disable unchanged; emits `route.disabled`.
- `enable_route` — **new.** Re-enables a disabled route without touching
  custom terms; emits `route.enabled`.
- `remove_route` — **new.** Hard-deletes the `Route(...)` entry; emits
  `route.removed`.
- `update_route_terms` — **refactored** to take a partial-update struct
  `RouteUpdate { premium: Field<i128>, payoff: Field<i128>, delay_hours: Field<u32> }`
  where `Field<T> = Keep | Set(T) | UseDefault`; emits `route.updated`.
- `set_defaults` — emits `gov.defaults`.
- `add_admin` / `remove_admin` — emit `gov.admin_added` / `gov.admin_removed`.

**TTL strategy:**
- In-contract `extend_ttl` on every `Route(...)` write (60-day window at
  5s/ledger). Covers actively edited routes.
- Owner cron extends idle routes via `ExtendFootprintTTLOp` — add
  `DataKey::Route(...)` keys to Cron #4's footprint (Improvement #6,
  already covering `FlightConfig` / `FlightData`).
- Existing `extend_ttl()` for the contract instance stays.

**Events** (consumed by off-chain indexer):
```
("route", "listed")     → (flight_id, origin, dest, premium, payoff, delay_hours)
("route", "disabled")   → (flight_id, origin, dest)
("route", "enabled")    → (flight_id, origin, dest)
("route", "updated")    → (flight_id, origin, dest, premium, payoff, delay_hours)
("route", "removed")    → (flight_id, origin, dest)
("gov",   "defaults")   → (premium, payoff, delay_hours)
("gov",   "admin_added")   → (admin)
("gov",   "admin_removed") → (admin)
```

**Tasks (suggested order — each step keeps the workspace green):**
1. Add `RouteStatus` enum + `route_status()` alongside the existing API.
2. Update Controller's `buy_insurance` to use `route_status()` + match —
   drops the redundant `is_route_whitelisted` cross-contract call.
3. Add events to existing write functions (`whitelist_route`,
   `disable_route`, `update_route_terms`, `set_defaults`, `add_admin`,
   `remove_admin`).
4. Add `enable_route` and `remove_route` operations + events.
5. Refactor `update_route_terms` to the partial-update struct.
6. Drop `RouteList` writes from `whitelist_route`; remove
   `get_whitelisted_routes`.
7. Drop `is_route_whitelisted` and `get_route_terms` from the contract;
   remove from `controller/src/lib.rs`'s `GovClient` trait.
8. Add `extend_ttl` calls to all `Route(...)` writes.
9. Rewrite governance unit tests for the new API.
10. Spot-check `controller/src/test.rs` and integration tests
    (`setup.rs`, `group2_capital.rs`, `group4_parallel.rs`) — these only
    call `whitelist_route`, so changes are minimal.

**Verification:**
- `cargo build -p governance_module` clean.
- `cargo build -p controller` clean (after tasks 2 + 7).
- `cargo test -p governance_module` passes the rewritten suite.
- Integration test: purchase on a whitelisted route succeeds; disable +
  retry panics with `"route is disabled"`; remove + retry panics with
  `"route not whitelisted"`.

---

## Step 5 — MODIFY `contracts/risk_vault/` — WithdrawalQueue tier

**Action:** Move `WithdrawalQueue` from Persistent to Instance (Improvement #2).

**Why:** Single global FIFO; it is shared state, not user-scoped. Persistent was
incorrect — Instance is the right tier and avoids archival rent.

**Tasks:**
- Grep `src/lib.rs` for `WithdrawalQueue`. Every `storage().persistent()` access
  becomes `storage().instance()` (`get`, `set`, `has`).
- Drop any manual `extend_ttl` for this key.
- Update enum comment to mark `WithdrawalQueue` as Instance.

**Verification:** `cargo build -p risk_vault` clean; queue tests still pass
(they should be storage-tier-agnostic).

---

## Step 6 — MODIFY `contracts/oracle_aggregator/` (+ controller mirror) — Delayed prune + Instance

**Action:** Move `ActiveFlightList` from Persistent to Instance, widen
`FlightData` with `settled_at: u64`, and add a permissionless `prune_settled`
function that removes entries settled more than `SETTLED_RETENTION_DAYS = 30`
days ago (Improvement #5).

**Why:**
- **Tier wrong + unbounded growth.** `ActiveFlightList` is global single-row
  state — per Soroban best practice it belongs in Instance. The current
  Persistent placement plus never-prune behaviour makes the list grow
  forever; every read copies the full list into the tx footprint.
- **Why delayed prune (not prune-on-settle):** off-chain monitoring,
  indexers, and observability tooling need a window in which a freshly
  settled flight is still visible in `ActiveFlightList` to record its final
  state without race conditions. Pruning immediately removes the flight from
  view the instant the on-chain state flips. A 30-day retention window
  keeps it observable while still bounding list growth.
- **Why both must land together.** A pure tier flip without pruning would
  actually be *worse* than today: Instance is loaded into every tx
  footprint, so an unbounded Instance entry is more dangerous than an
  unbounded Persistent one. The two changes are coupled.

**Tasks (oracle_aggregator):**
- Switch every `ActiveFlightList` access from `storage().persistent()` to
  `storage().instance()`. Remove any manual TTL extension for this key.
- Add Instance / Persistent tier-grouping comments to the `OracleKey` enum
  (matching the `flight_pool_manager::PoolKey` style — `WithdrawalQueue`
  Phase 5 already established this pattern).
- Widen `FlightData` with `settled_at: u64` (0 means not-yet-settled).
- In `set_settled(...)`, record `settled_at = env.ledger().timestamp()`
  along with the status flip. Do **not** prune the list here.
- Add module-level constants:
  ```rust
  const SETTLED_RETENTION_DAYS: u64 = 30;
  const SECONDS_PER_DAY: u64 = 86_400;
  ```
- Add permissionless `prune_settled(env)` entry. Scans
  `ActiveFlightList`, looks up each entry's `FlightData`, and removes
  entries where `data.status == Settled` AND `data.settled_at != 0` AND
  `now - data.settled_at >= SETTLED_RETENTION_DAYS * SECONDS_PER_DAY`.
  No auth (matches `flight_pool_manager::sweep_expired` pattern). Build
  a fresh `Vec` of survivors and write it back if it differs from the
  current list.

**Tasks (controller — lockstep mirror):**
- `controller/src/lib.rs` defines a mirror `FlightData` struct under its
  inline `OracleClient` interface (the "Solidity-interface" pattern).
  **Widen the mirror in lockstep** with oracle's struct — add
  `settled_at: u64`. Without this, `oracle.get_flight_data()` calls panic
  on deserialization at runtime. The compiler can't catch the drift.
- This is the same shape as Phase 4's `RouteStatus` lockstep addition to
  the `GovClient` mirror.
- No `prune_settled` entry in controller's `OracleClient` trait — the
  off-chain executor (eventually) calls oracle directly. Adding it to the
  trait would imply controller needs to know about pruning, which it
  doesn't.

**Note:** the FlightData TTL-miss diagnostic event is intentionally **not**
done here — it is grouped with the other TTL work in Step 9.

**Out of scope for Phase 6:** wiring `prune_settled` into a cron. Phase 6
exposes the entry point only. Cron #3 `SettlementExecutor` (every 5 min)
is the natural candidate, but Cron #4 (TTL extender, Improvement #6) is
also a reasonable host. That wiring lives in `executor/`, which Phase 6
does not touch.

**Verification:**
- `cargo build -p oracle_aggregator` clean.
- `cargo test -p oracle_aggregator` passes existing tests + a new lifecycle
  test: register → set_active → set_landed → set_settled (assert
  `settled_at` recorded; list still has the flight) → fast-forward ledger
  time by 30 days → `prune_settled()` → list is empty.
- `cargo build -p controller` (lib) clean — confirms the widened `FlightData`
  mirror compiles. Full `cargo test -p controller` is still blocked by the
  Phase 7+10 cleanup (controller test references deleted crates), so the
  build-only check is the realistic gate.

---

## Step 7 — MODIFY `contracts/controller/`

**Action:** Rip out the deployer / per-flight FlightPool / RecoveryPool wiring,
wire `FlightPoolManager`, add the per-traveler index (Improvements #1 and #8).

**Why:** With `flight_pool` and `recovery_pool` gone (Steps 1–2), the Controller
must drop all references to them and route everything through the new
FlightPoolManager. The per-traveler index unblocks the MyPolicies frontend
without an off-chain indexer.

**Cargo.toml note:** `controller/Cargo.toml`'s dep list was already updated in
Phase 3 (dead `flight_pool` / `recovery_pool` lines removed,
`flight_pool_manager` added) so the lockfile could regenerate. Verify the file
still has the right deps; if not, fix here.

**Tasks — `src/lib.rs`:**

Remove from `CtrlKey`:
- `FlightPoolWasm` (the BytesN<32>).
- `ActiveFlight(Symbol, u64)`.
- `ActiveFlightList`.
- `RecoveryPool`.

Remove from code:
- All `env.deployer()` logic (per-flight pool deploys).
- All reads/writes against `ActiveFlight` / `ActiveFlightList` (now owned by
  FlightPoolManager).
- Constructor arg `recovery_pool` and `flight_pool_wasm`.

Add to `CtrlKey`:
- `FlightPoolManager` — Address, Instance.
- `TravelerFlights(Address)` — `Vec<(Symbol, u64)>`, Persistent.

Add functions:
- `get_flights_for_traveler(env, address) -> Vec<(Symbol, u64)>`.

Modify `buy_insurance(...)`:
- Look up `FlightPoolManager.get_flight_config(flight_id, date)`.
- If missing: call `FlightPoolManager.register_flight(...)` with terms resolved
  from GovernanceModule, then `OracleAggregator.register_flight(...)`.
- Transfer USDC from traveler directly to FlightPoolManager.
- Call `FlightPoolManager.add_buyer(controller_addr, flight_id, date, traveler)`.
- Append `(flight_id, date)` to `TravelerFlights(traveler)` and extend its TTL.

Modify `classify_flights(...)`:
- Read `delay_hours` from `FlightPoolManager.get_flight_config(...).delay_hours`
  (no more per-pool client).
- Where Oracle returns `NotInitiated` for a flight expected to have data, leave
  a `TODO ttl_miss` for Step 9 to wire the diagnostic event.

Modify `execute_settlements(...)`:
- Call `FlightPoolManager.settle_on_time(flight_id, date)` /
  `settle_delayed(flight_id, date, claim_expiry)` /
  `settle_cancelled(flight_id, date, claim_expiry)`.
- Drop the local `ActiveFlightList` removal — FlightPoolManager owns that list.

Modify constructor:
- Drop `recovery_pool` and `flight_pool_wasm` params.
- Add `flight_pool_manager` param; persist to `CtrlKey::FlightPoolManager`.

**Verification:** `cargo build -p controller` clean. Update `src/test.rs` to
match the new constructor signature; assert `get_flights_for_traveler` returns
the expected list after a purchase.

---

> **Steps 8–9 — TTL work.** The remaining contract changes all touch
> `extend_ttl` or TTL-related observability. They are grouped at the bottom so
> the workspace can be brought to a clean storage-tier baseline first; TTL
> tuning then lands as a focused pair of phases that share review patterns
> (rent windows, cron coverage, diagnostic events).

---

## Step 8 — MODIFY `contracts/risk_vault/` — TTL & recovery

**Action:** Two related TTL changes on the same file:
1. ClaimableBalance — extend TTL on every credit, add owner-only
   `recover_uncollected` function (Improvement #3).
2. SnapshotPrice — move from Persistent to Temporary with a 30-day TTL
   (Improvement #7).

**Why combine:** both edits live in `risk_vault/src/lib.rs`, both are pure TTL
tuning, and they share the same review concerns (rent windows, expiry
behaviour). Landing them together avoids two near-identical PRs.

**Tasks — ClaimableBalance:**
- In `process_withdrawal_queue`, after every
  `storage().persistent().set(&VaultKey::ClaimableBalance(addr.clone()), &amount)`,
  call `extend_ttl(&VaultKey::ClaimableBalance(addr), 60*24*60*12, 60*24*60*12)`
  (60 days at 5s/ledger). Emit `vault.credited(addr, amount, new_balance)`
  immediately after.
- Apply the same TTL extension wherever `ClaimableBalance` is written (e.g.,
  if `recover_uncollected` re-credits it).
- In `collect()`, after `usdc.transfer(...)` and `storage().persistent().remove(...)`,
  emit `vault.collected(addr, amount)`.
- Add `fn recover_uncollected(env, owner, user, amount)`:
  - `owner.require_auth()`.
  - Assert `owner == storage().instance().get(VaultKey::Owner)`.
  - Either re-credit `ClaimableBalance(user)` (with TTL extension) or transfer
    USDC directly to `user`.
  - Emit `vault.recovered(addr, amount, mode)` where `mode` is `"recredit"`
    or `"transfer"`.
- **Event topic style:** 2-symbol prefix `["vault", <action>]` plus indexed
  `addr` topic — matches the Phase 4 / Phase 6 event scheme. These events
  are consumed by the off-chain indexer (Improvement #9) which maintains a
  `claimable_balances(addr)` table for the Phase 9 cron to read.
- Unit test: simulate expiry, call `recover_uncollected`, assert the user
  can collect. Add event spot-checks for credited / collected / recovered.

**Tasks — SnapshotPrice:**
- Grep for `SnapshotPrice`. Every `storage().persistent()` access switches to
  `storage().temporary()`.
- After every write, call
  `extend_ttl(&VaultKey::SnapshotPrice(day), 30*24*60*12, 30*24*60*12)`.
- Update enum comment to mark `SnapshotPrice(u64)` as Temporary.

**Verification:** `cargo build -p risk_vault` clean; new tests pass for both
the recovery flow and the temporary-tier snapshot read-back.

---

## Step 9 — MODIFY `contracts/oracle_aggregator/` — FlightData TTL miss + cron footprint coverage

**Action:** Add a diagnostic event when `FlightData` is missing for a flight
that should have data (Improvement #6). Also confirm the off-chain
`ExtendFootprintTTLOp` cron (Cron #4) covers all the keys it should — including
the secondary TTL defense for `VaultKey::ClaimableBalance(addr)` introduced in
Step 8.

**Why:** Two related observability/TTL concerns: surface FlightData TTL expiry
via a diagnostic event so the off-chain extender cron can react; and document
that Cron #4's footprint includes ClaimableBalance keys (sourced from the
Phase 8 `vault.credited` / `vault.collected` / `vault.recovered` event family
via the off-chain indexer, Improvement #9).

**Tasks — diagnostic event:**
- Either expose a thin `oracle.emit_ttl_miss(flight_id, date)` helper, or have
  the Controller emit `env.events().publish((symbol_short!("warn"),
  symbol_short!("ttl_miss")), (flight_id, date))` directly. Emitting from the
  Controller is simpler and keeps Oracle pure — pick that unless there is a
  reason to centralize.
- Wire the emission into the Controller `TODO ttl_miss` left in Step 7
  (`classify_flights` / `execute_settlements` paths where
  `get_flight_data` returns `NotInitiated`).
- No on-chain `extend_ttl` is added here — the actual extension is performed
  by the off-chain `ExtendFootprintTTLOp` cron (out of scope for this phase).

**Tasks — Cron #4 footprint coverage (executor work, Improvement #6):**
- The cron's footprint must cover: `PoolKey::FlightConfig(id, date)`,
  `OracleKey::FlightData(id, date)`, `DataKey::Route(flight_id, origin, dest)`,
  `CtrlKey::TravelerFlights(addr)`, AND
  `VaultKey::ClaimableBalance(addr)`.
- Address list for `ClaimableBalance(addr)` is sourced from the off-chain
  indexer's `claimable_balances` table — populated by the `vault.credited` /
  `vault.collected` / `vault.recovered` events emitted by Step 8. **This is
  why Step 8 emits those events — they exist specifically to power this
  step's secondary TTL defense for ClaimableBalance.**

**Verification:** `cargo build -p oracle_aggregator` and `cargo build -p
controller` both clean; unit test that simulates a missing `FlightData` lookup
asserts the `ttl_miss` event is emitted. Spec-side: confirm `improvements.md`
#6 + #9 reflect the ClaimableBalance footprint addition.

---

## Step 10 — MODIFY `contracts/integration_tests/`

**Action:** Update every test harness to the new contract topology. This is
the green-build gate for the whole phase.

**Why:** All other steps shift contract surface area; integration tests must
catch breakage end-to-end before any frontend / executor work begins.

**Tasks:**
- `integration_tests/Cargo.toml` deps were already fixed in Phase 3 (dead
  `flight_pool` / `recovery_pool` lines removed, `flight_pool_manager` added).
  Verify the file still has the right deps; if not, fix here.
- In each test file under `src/tests/`:
  - Remove RecoveryPool from setup / fixture builders.
  - Remove the FlightPool WASM-install + deployer scaffolding.
  - Deploy `FlightPoolManager` once during fixture setup; pass its address into
    Controller's new constructor signature.
  - Replace per-flight `FlightPoolClient` calls with
    `FlightPoolManagerClient` calls keyed by `(flight_id, date)`.
  - Replace `controller.get_active_pools()` (and similar) with
    `flight_pool_manager.get_active_flights()` and
    `controller.get_flights_for_traveler(addr)`.
  - Add coverage for the new paths: `recover_uncollected` (RiskVault),
    `sweep_expired` + `withdraw_recovered` (FlightPoolManager), per-traveler
    index population (Controller), and the `ttl_miss` event (Oracle/Controller).
- Confirm `WithdrawalQueue` / `Route` / `ActiveFlightList` storage-tier moves
  do not break any fixture that introspects storage directly — switch
  introspection to `instance()` where needed.

**Verification:** `cargo test -p integration_tests` is green for the full
suite. This is the gate before any executor or frontend work in subsequent
phases.
