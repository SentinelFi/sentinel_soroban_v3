# Dev Steps — Phase 3 Contract Changes

Contract-level changes only. One step per contract action (delete / add / modify).
Order matters: deletions and the new contract come first; storage-tier moves
that do not change TTL behaviour come next; explicit TTL work is grouped near
the bottom (steps 8–9); integration tests are last as the green-build gate.

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

**Action:** Move `Route` and `RouteList` from Persistent to Instance storage
(Improvement #4).

**Why:** Routes are global shared state under ~50 entries; per Soroban best
practice that should live in Instance and ride the existing TTL cron, not
Persistent.

**Tasks:**
- In `src/lib.rs`, grep for `storage().persistent()` and switch every call site
  that touches `DataKey::Route(..)` or `DataKey::RouteList` to
  `storage().instance()`. This applies to `get`, `set`, `has`, `remove`.
- Delete any explicit `extend_ttl` calls for these keys — Instance TTL is
  managed by the existing per-contract cron.
- Confirm the `DataKey` enum comments in the contract match the architecture
  doc (`Route(..)` and `RouteList` annotated as Instance).

**Verification:** `cargo build -p governance_module` clean; existing unit tests
pass after switching their reads to `instance()` if they introspect storage.

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

## Step 6 — MODIFY `contracts/oracle_aggregator/` — ActiveFlightList prune

**Action:** Move `ActiveFlightList` from Persistent to Instance and prune the
list inside `set_settled` (Improvement #5).

**Why:** Unbounded growth + wrong tier. The list is global shared state; it
belongs in Instance. Pruning on settlement keeps it bounded by the count of
in-flight flights at any moment.

**Tasks:**
- Switch every `ActiveFlightList` access from `storage().persistent()` to
  `storage().instance()`.
- Remove any manual TTL extension for this key.
- In `set_settled(...)`, after marking the flight as `Settled`, prune it from
  the list:
  ```
  let mut list = storage().instance().get(&OracleKey::ActiveFlightList).unwrap_or(Vec::new(&env));
  if let Some(idx) = list.iter().position(|(id, d)| id == flight_id && d == date) {
      list.remove(idx);
      storage().instance().set(&OracleKey::ActiveFlightList, &list);
  }
  ```
- Update enum comment to mark `ActiveFlightList` as Instance.

**Note:** the FlightData TTL-miss diagnostic event is intentionally **not**
done here — it is grouped with the other TTL work in Step 9.

**Verification:** `cargo build -p oracle_aggregator` clean; new test:
register → set_active → set_landed → set_settled → list is empty.

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
  (60 days at 5s/ledger).
- Apply the same extension wherever `ClaimableBalance` is written (e.g., if
  `recover_uncollected` re-credits it).
- Add `fn recover_uncollected(env, owner, user, amount)`:
  - `owner.require_auth()`.
  - Assert `owner == storage().instance().get(VaultKey::Owner)`.
  - Either re-credit `ClaimableBalance(user)` (with TTL extension) or transfer
    USDC directly to `user`. Emit an event so an indexer can reconstruct.
- Unit test: simulate expiry, call `recover_uncollected`, assert the user can
  collect.

**Tasks — SnapshotPrice:**
- Grep for `SnapshotPrice`. Every `storage().persistent()` access switches to
  `storage().temporary()`.
- After every write, call
  `extend_ttl(&VaultKey::SnapshotPrice(day), 30*24*60*12, 30*24*60*12)`.
- Update enum comment to mark `SnapshotPrice(u64)` as Temporary.

**Verification:** `cargo build -p risk_vault` clean; new tests pass for both
the recovery flow and the temporary-tier snapshot read-back.

---

## Step 9 — MODIFY `contracts/oracle_aggregator/` — FlightData TTL miss

**Action:** Add a diagnostic event when `FlightData` is missing for a flight
that should have data (Improvement #6).

**Why:** Surfaces TTL expiry of `FlightData` so the off-chain TTL-extender
cron can be alerted and corrective action taken before settlement fails.
Decoupled from Step 6 because it is purely a TTL/observability concern.

**Tasks:**
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

**Verification:** `cargo build -p oracle_aggregator` and `cargo build -p
controller` both clean; unit test that simulates a missing `FlightData` lookup
asserts the `ttl_miss` event is emitted.

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
