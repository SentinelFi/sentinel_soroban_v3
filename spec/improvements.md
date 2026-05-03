# Improvements — Actionable Checklist

For the reasoning behind each change, see `learn_soroban.md`.

---

## Priority Order

| # | Issue | Severity | Action |
|---|-------|----------|--------|
| 1 | FlightPool -> FlightPoolManager + RecoveryPool merge | CRITICAL | New contract, delete 2 old ones |
| 2 | RiskVault `WithdrawalQueue` wrong storage tier | CRITICAL | Persistent -> Instance |
| 3 | RiskVault `ClaimableBalance` missing TTL | HIGH | Add 60-day TTL + recovery function |
| 4 | Governance routes — silent archival, redundant read API, unbounded `RouteList` | HIGH | API redesign + events + TTL strategy |
| 5 | Oracle `ActiveFlightList` never pruned | MEDIUM | Prune in `set_settled`, move to Instance |
| 6 | Oracle `FlightData` expires before settlement | MEDIUM | `ExtendFootprintTTLOp` cron + detection |
| 7 | RiskVault `SnapshotPrice` wrong tier | LOW | Persistent -> Temporary |
| 8 | MyPolicies shows all policies | LOW | Add per-traveler index to Controller |
| 9 | Route enumeration off-chain (follow-on to #4) | HIGH | Custom event-poller indexer (Node + SQLite) |

---

## 1. FlightPool -> FlightPoolManager + Delete RecoveryPool

### Delete
- `contracts/flight_pool/` — entire directory
- `contracts/recovery_pool/` — entire directory

### Create: `contracts/flight_pool_manager/`

**Storage layout:**
```rust
pub enum PoolKey {
    // Instance
    Controller,                      // Address
    UsdcToken,                       // Address
    RiskVault,                       // Address
    ActiveFlightList,                // Vec<(Symbol, u64)> — pruned on settlement
    RecoveredBalance,                // i128

    // Persistent
    FlightConfig(Symbol, u64),       // FlightConfig
    Buyer(Symbol, u64, Address),     // bool
    Claimed(Symbol, u64, Address),   // bool
}

pub struct FlightConfig {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
    pub buyer_count: u32,
    pub status: SettlementStatus,
    pub claim_expiry: u64,
}

pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}
```

**Functions to implement:**
```rust
fn initialize(env, owner, usdc_token, risk_vault);
fn set_controller(env, owner, controller);                          // one-time, immutable
fn register_flight(env, controller, flight_id, date, premium, payoff, delay_hours);
fn add_buyer(env, controller, flight_id, date, buyer);
fn settle_on_time(env, controller, flight_id, date);
fn settle_delayed(env, controller, flight_id, date, claim_expiry);
fn settle_cancelled(env, controller, flight_id, date, claim_expiry);
fn claim(env, traveler, flight_id, date);
fn sweep_expired(env, flight_id, date);
fn withdraw_recovered(env, owner, amount);
fn get_flight_config(env, flight_id, date) -> FlightConfig;
fn has_policy(env, flight_id, date, traveler) -> bool;
fn has_claimed(env, flight_id, date, traveler) -> bool;
fn get_active_flights(env) -> Vec<(Symbol, u64)>;
fn get_recovered_balance(env) -> i128;
```

**Implementation rules:**
- `register_flight`: panic if already registered; append to ActiveFlightList; store FlightConfig with status=Active
- `add_buyer`: panic if not registered or already settled; set Buyer key; increment buyer_count; set Buyer TTL to claim_expiry + 30 days
- `settle_on_time`: transfer `premium * buyer_count` to RiskVault via `record_premium_income()`; set status=SettledOnTime; remove from ActiveFlightList
- `settle_delayed`/`settle_cancelled`: set status + claim_expiry; remove from ActiveFlightList
- `claim`: require traveler auth; check SettledDelayed or SettledCancelled; check Buyer exists; check not Claimed; check timestamp < claim_expiry; set Claimed; transfer payoff
- `sweep_expired`: check timestamp > claim_expiry; calculate unclaimed amount; credit RecoveredBalance
- `withdraw_recovered`: require owner auth; debit RecoveredBalance; transfer USDC out

### Modify: `contracts/controller/src/lib.rs`

**Remove from CtrlKey enum:**
- `FlightPoolWasm` (BytesN<32>)
- `ActiveFlight(Symbol, u64)` (Persistent)
- `ActiveFlightList` (Persistent)
- `RecoveryPool` (Address)

**Remove from code:**
- All `env.deployer()` logic
- All `ActiveFlight` / `ActiveFlightList` reads and writes
- RecoveryPool from constructor args

**Add to CtrlKey enum:**
- `FlightPoolManager` — Address, Instance
- `TravelerFlights(Address)` — Vec<(Symbol, u64)>, Persistent

**Add function:**
- `get_flights_for_traveler(env, address) -> Vec<(Symbol, u64)>`

**Modify `buy_insurance()`:**
```
Old: lookup ActiveFlight mapping -> if missing, deploy via env.deployer() -> transfer to pool address -> pool.buy_insurance()
New: check FlightPoolManager.get_flight_config() -> if missing, FlightPoolManager.register_flight() + oracle.register_flight() -> transfer to FlightPoolManager -> FlightPoolManager.add_buyer() -> append to TravelerFlights(traveler)
```

**Modify `classify_flights()`:**
```
Old: read delay_hours from individual FlightPool via pool_client.get_delay_hours()
New: read delay_hours from FlightPoolManager.get_flight_config(flight_id, date).delay_hours
```

**Modify `execute_settlements()`:**
```
Old: call pool_client.settle_on_time() / settle_delayed() on individual pools; remove from Controller's ActiveFlightList
New: call FlightPoolManager.settle_on_time(flight_id, date) / settle_delayed(flight_id, date, claim_expiry); ActiveFlightList managed by FlightPoolManager internally
```

**Modify constructor:**
- Remove `recovery_pool` and `flight_pool_wasm` params
- Add `flight_pool_manager` param

### Modify: Tests
- `contracts/controller/src/test.rs` — update for new flow
- `contracts/integration_tests/` — remove RecoveryPool from setup; remove FlightPool WASM deployment; use FlightPoolManager for all pool interactions

---

## 2. RiskVault `WithdrawalQueue` — Persistent to Instance

**File:** `contracts/risk_vault/src/lib.rs`

**Action:** Change ALL access sites for `WithdrawalQueue`:
```
storage().persistent().get/set(&VaultKey::WithdrawalQueue, ...)
->
storage().instance().get/set(&VaultKey::WithdrawalQueue, ...)
```

Grep for `WithdrawalQueue` and change every `persistent()` to `instance()`.

---

## 3. RiskVault `ClaimableBalance` — Add TTL + Recovery

**File:** `contracts/risk_vault/src/lib.rs`

**Action 1:** After setting `ClaimableBalance` in `process_withdrawal_queue`, extend TTL:
```rust
env.storage().persistent().set(&VaultKey::ClaimableBalance(addr.clone()), &amount);
env.storage().persistent().extend_ttl(
    &VaultKey::ClaimableBalance(addr),
    60 * 24 * 60 * 12,   // 60 days in ledgers (5s/ledger)
    60 * 24 * 60 * 12,
);
```

**Action 2:** Add owner-only recovery function:
```rust
fn recover_uncollected(env: Env, owner: Address, user: Address, amount: i128) {
    owner.require_auth();
    let stored_owner = env.storage().instance().get(&VaultKey::Owner).unwrap();
    assert!(owner == stored_owner, "not owner");
    // Re-credit user's claimable balance or transfer directly
    // Owner uses off-chain event logs to reconstruct who is owed what
}
```

---

## 4. Governance Routes — API Redesign + Events + TTL

**File:** `contracts/governance_module/src/lib.rs`

**Why:** Routes can scale to thousands in production. The original
"Persistent → Instance" plan does not survive this:
- **Instance is wrong at scale** — every invocation loads all Instance
  entries into the tx footprint.
- **Persistent without a TTL strategy** is the current state — entries
  archive silently and `buy_insurance` panics with `"route not found"`,
  indistinguishable from a never-whitelisted route.
- **`RouteList`** (one `Vec` of every route) is a footprint hazard at any tier.

### Storage

Keep `Route(flight_id, origin, dest) → RouteTerms` Persistent (keyed
per-route, independent TTL — correct at scale). **Remove `RouteList`** and
the `get_whitelisted_routes()` reader. Enumeration moves off-chain via
events + indexer.

### Read API

Replace `is_route_whitelisted` (bool) and `get_route_terms` (panicking)
with one typed enum:

```rust
#[contracttype]
pub enum RouteStatus {
    Active(ResolvedTerms),  // entry exists, approved == true
    Disabled,               // entry exists, approved == false
    Unknown,                // entry missing (never whitelisted, archived, or removed)
}

pub fn route_status(env, flight_id, origin, dest) -> RouteStatus;
```

The Controller's `buy_insurance` switches from two redundant cross-contract
calls (`is_route_whitelisted` + `get_route_terms`) to one `route_status()`
call + match. **Keep** `get_defaults` and `is_admin`.

### Write API

- `whitelist_route` — drops the `RouteList` append; emits `route.listed`.
- `disable_route` — soft-disable; emits `route.disabled`.
- **New** `enable_route` — re-enable without touching custom terms; emits `route.enabled`.
- **New** `remove_route` — hard-delete the `Route(...)` entry; emits `route.removed`.
- **Refactored** `update_route_terms` — takes
  `RouteUpdate { premium: Field<i128>, payoff: Field<i128>, delay_hours: Field<u32> }`
  where `Field<T> = Keep | Set(T) | UseDefault`; emits `route.updated`.
- `set_defaults` — emits `gov.defaults`.
- `add_admin` / `remove_admin` — emit `gov.admin_added` / `gov.admin_removed`.

### TTL strategy

- In-contract `extend_ttl` on every `Route(...)` write (60-day window).
- Owner cron extends idle routes via `ExtendFootprintTTLOp` — add
  `DataKey::Route(...)` keys to Cron #4's footprint (Improvement #6).

### Events (consumed by off-chain indexer)

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

The on-chain `route_status` is the protocol's source of truth on the buy
path — the indexer is read-side cache only. Indexers store option-ness
(custom value vs. `UseDefault`) and resolve against the latest
`gov.defaults` at read time.

Indexer design, schema, and testing strategy live in **Improvement #9**.

---

## 5. Oracle `ActiveFlightList` — Prune + Instance

**File:** `contracts/oracle_aggregator/src/lib.rs`

**Action 1:** Change ALL `ActiveFlightList` access from `persistent()` to `instance()`. Remove any manual TTL extension for this key.

**Action 2:** In `set_settled()`, prune the settled flight from the list:
```rust
// After setting status to Settled:
let mut list: Vec<(Symbol, u64)> = env.storage().instance()
    .get(&OracleKey::ActiveFlightList)
    .unwrap_or(Vec::new(&env));
if let Some(idx) = list.iter().position(|(id, d)| id == flight_id && d == date) {
    list.remove(idx);
    env.storage().instance().set(&OracleKey::ActiveFlightList, &list);
}
```

---

## 6. Oracle `FlightData` — TTL Cron + Detection

**Action 1 — Executor:** Create `executor/src/core/ttl_extender.ts`
1. Call `FlightPoolManager.get_active_flights()` for all `(flight_id, date)` tuples; pull whitelisted route tuples from the off-chain indexer (Improvement #9)
2. Build `ExtendFootprintTTLOp` transaction covering:
   - `PoolKey::FlightConfig(id, date)` in FlightPoolManager
   - `OracleKey::FlightData(id, date)` in OracleAggregator
   - `DataKey::Route(flight_id, origin, dest)` in GovernanceModule
3. Also extend `TravelerFlights(address)` for active travelers
4. Submit transaction

**Action 2 — Executor:** In `executor/src/backends/cron/index.ts`, add 4th cron schedule (every 24 hours) calling the TTL extender.

**Action 3 — Controller:** In `classify_flights()` / `execute_settlements()`, when `get_flight_data()` returns `NotInitiated` for a flight that should have data, emit a diagnostic event:
```rust
env.events().publish(
    (symbol_short!("warn"), symbol_short!("ttl_miss")),
    (flight_id.clone(), date),
);
```

---

## 7. RiskVault `SnapshotPrice` — Persistent to Temporary

**File:** `contracts/risk_vault/src/lib.rs`

**Action:** Change ALL `SnapshotPrice` access:
```
storage().persistent().get/set(&VaultKey::SnapshotPrice(day), ...)
->
storage().temporary().get/set(&VaultKey::SnapshotPrice(day), ...)
```

After writing, set 30-day TTL:
```rust
env.storage().temporary().set(&VaultKey::SnapshotPrice(day), &price);
env.storage().temporary().extend_ttl(
    &VaultKey::SnapshotPrice(day),
    30 * 24 * 60 * 12,
    30 * 24 * 60 * 12,
);
```

---

## 8. MyPolicies — Per-Traveler Index

Already covered in Improvement #1 (Controller changes). Summary of the additions:

**Controller contract:**
- Add `CtrlKey::TravelerFlights(Address)` — Vec<(Symbol, u64)>, Persistent
- Append in `buy_insurance()` after successful purchase
- Add `get_flights_for_traveler(env, address) -> Vec<(Symbol, u64)>`
- TTL extended by `ExtendFootprintTTLOp` cron (Improvement #6)

**Frontend:**
- Create `frontend/src/hooks/useMyPolicies.ts` — calls `controller.get_flights_for_traveler(address)`
- Update `MyPolicies.tsx` — replace `useActivePools()` / `get_active_pools()` with `useMyPolicies(address)`

---

## 9. Off-chain Route Indexer

**Why this exists:** Improvement #4 removes `RouteList` and
`get_whitelisted_routes()` from `governance_module`. Enumeration moves
off-chain. This component owns that enumeration: it folds the `route.*` event
stream into a queryable "current whitelist" table for the TTL cron
(Improvement #6) and any admin UI.

### Choice: custom poller, not Mercury / SubQuery / Goldsky

For this shape — five event types, thousands of routes max, low write rate,
single contract — a hosted indexer is overkill:
- Hosted indexers (Mercury / SubQuery / Goldsky) earn their keep on millions
  of events, complex multi-contract joins, or cross-chain pipelines. None of
  those apply here.
- A custom poller is ~80 lines of TypeScript, lives in this repo, deploys
  alongside the executor, and is testable by replaying fixture event
  sequences against an in-process SQLite.
- No vendor lock-in or external service dependency for a component the TTL
  cron (Improvement #6) reads on every run.

### Location

`indexer/` — new top-level package, sibling of `executor/` and `frontend/`.
Or fold into `executor/src/indexer/` if the deployment story is shared. Pick
one early; the implementation is identical either way.

### Source

```ts
rpc.getEvents({
  startLedger: cursor.last_ledger,
  filters: [{ type: "contract", contractIds: [governanceModule],
              topics: [["route", "*"], ["gov", "*"]] }],
});
```

Polled every N seconds from a saved cursor. The 7-day RPC retention window
means the poller must run continuously; cold-start backfill from the
[Stellar data lake] is the recovery path if the cursor lapses past the
window.

### Schema (SQLite)

```sql
CREATE TABLE routes (
  flight_id   TEXT NOT NULL,
  origin      TEXT NOT NULL,
  dest        TEXT NOT NULL,
  premium     INTEGER,           -- NULL means UseDefault
  payoff      INTEGER,           -- NULL means UseDefault
  delay_hours INTEGER,           -- NULL means UseDefault
  status      TEXT NOT NULL,     -- 'active' | 'disabled'
  last_ledger INTEGER NOT NULL,
  PRIMARY KEY (flight_id, origin, dest)
);

CREATE TABLE defaults (
  premium     INTEGER NOT NULL,
  payoff      INTEGER NOT NULL,
  delay_hours INTEGER NOT NULL,
  last_ledger INTEGER NOT NULL
);

CREATE TABLE cursor (
  k TEXT PRIMARY KEY,            -- 'last_ledger'
  v INTEGER NOT NULL
);
```

`route.removed` is a hard delete on-chain; the indexer mirrors that with
`DELETE FROM routes ...` rather than retaining a tombstone.

### Event handlers

```
route.listed   → INSERT OR REPLACE row, status='active'
route.disabled → UPDATE status='disabled'
route.enabled  → UPDATE status='active'
route.updated  → UPDATE premium / payoff / delay_hours
route.removed  → DELETE row
gov.defaults   → UPDATE defaults singleton
```

`gov.admin_added` / `gov.admin_removed` are nice-to-have audit logs; no
current consumer requires them.

### Consumers

- **TTL cron (Improvement #6):** reads all rows, builds the
  `ExtendFootprintTTLOp` footprint covering
  `DataKey::Route(flight_id, origin, dest)` per row.
- **Admin UI** (future): "list whitelisted routes" page resolves per-row
  optional fields against `defaults` to render `ResolvedTerms`.

### Authoritative read path stays on-chain

The indexer is a read-side cache. The buy path uses `route_status()` on
`governance_module` directly, so a stale or down indexer cannot cause an
incorrect purchase decision. Only enumeration features (TTL cron, admin UI)
degrade.

### Testing

- **Unit:** replay a hand-written event sequence (list → update → disable →
  enable → remove → re-list) against an in-process SQLite and assert final
  table state.
- **Integration:** after Improvement #4 lands, `integration_tests/` already
  emits `route.*` events on `whitelist_route`. Add a harness step that boots
  the indexer process against the local quickstart RPC, runs a fixture
  purchase flow, and asserts the SQLite contents.
- **Cursor recovery:** kill and restart the indexer mid-sequence; assert it
  resumes from `cursor.last_ledger` without dropping or double-applying
  events.

---

## Per-Contract Summary

| Contract | Action | Improvements |
|----------|--------|-------------|
| `contracts/flight_pool/` | DELETE, replace with `flight_pool_manager/` | #1 |
| `contracts/recovery_pool/` | DELETE | #1 |
| `contracts/controller/` | MODIFY — remove deployer, add FlightPoolManager + TravelerFlights | #1, #8 |
| `contracts/governance_module/` | MODIFY — API redesign (typed enum, explicit lifecycle), events, TTL on writes + Cron #4 footprint | #4 |
| `contracts/risk_vault/` | MODIFY — WithdrawalQueue to Instance, ClaimableBalance TTL, SnapshotPrice to Temporary, add recover_uncollected | #2, #3, #7 |
| `contracts/oracle_aggregator/` | MODIFY — ActiveFlightList to Instance + prune, FlightData detection | #5, #6 |
| `executor/` | MODIFY — add TTL cron (#4), update all references | #1, #5, #6 |
| `indexer/` (new) | ADD — Node poller + SQLite folding `route.*` / `gov.*` events | #4, #9 |
| `frontend/` | MODIFY — add useMyPolicies, update to FlightPoolManager | #1, #8 |
| `integration_tests/` | MODIFY — update all test harnesses | all |

## Cross-Cutting: TTL Cron (Cron #4)

Improvements #1, #4, and #6 share the same cron. Single job that:
1. Calls `FlightPoolManager.get_active_flights()` for all `(flight_id, date)` tuples; pulls whitelisted route tuples from the off-chain indexer (Improvement #9)
2. Builds one `ExtendFootprintTTLOp` transaction covering:
   - `PoolKey::FlightConfig(id, date)` in FlightPoolManager
   - `OracleKey::FlightData(id, date)` in OracleAggregator
   - `DataKey::Route(flight_id, origin, dest)` entries in GovernanceModule
   - `TravelerFlights(address)` entries in Controller
3. Submits the transaction
4. Runs every 24 hours

Also update executor cron index to:
- Add 4th schedule for TTL extension
- Replace all FlightPool references with FlightPoolManager
- Remove RecoveryPool references
