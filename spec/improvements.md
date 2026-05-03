# Storage Audit & Improvements

## Guiding Principles (from Soroban Best Practices)

Before diving into individual issues, these are the Soroban storage rules that govern every recommendation:

1. **Prefer Temporary over Persistent and Instance.** Anything with a natural timeout should be Temporary with TTL set to the timeout.
2. **All global/shared state that cannot be Temporary should be in Instance storage.** This guarantees the TTL of the contract instance and all relevant globals are tied together — they live and die as one.
3. **TTL extensions should never be relied on for functionality or safety.** You must assume any entry's TTL can reach 0. Design contracts so that TTL expiry degrades gracefully rather than bricking the contract or trapping funds.
4. **TTL exhaustion should never be relied on for functionality or safety.** `ExtendFootprintTTLOp` is permissionless — anyone can extend any entry's TTL without authorization. Never use TTL as a timer or expiry mechanism.
5. **Owned contracts: owners should subsidize shared-state TTL via `ExtendFootprintTTLOp` cron.** This is a raw Soroban operation, not an in-contract function call. No contract code needed.
6. **Autonomous contracts: extend TTL of shared state touched by each invocation.** Since there's no owner to subsidize, callers must pay.
7. **Account-specific state: wallets/dApps should present TTL info and suggest extensions.** Per-user entries are the user's responsibility.

### Key insight for this protocol

Our protocol is **owner-operated** (the deployer controls governance, crons, keeper). The Soroban docs say the owner should use `ExtendFootprintTTLOp` via cron — not in-contract `extend_ttl()` functions. However, **Principle 3 is the critical one**: TTL extension is a convenience, not a safety mechanism. The contract must not brick or trap funds if TTL expires despite best efforts.

### Important: `RestoreFootprintOp` — the universal safety net

Instance and Persistent storage entries are **never permanently deleted** on Soroban. When their TTL expires they are "archived" — moved to cold storage. Archived entries can always be restored via `RestoreFootprintOp` (a raw Soroban operation, no contract call needed). This means:

- A "bricked" contract can be unbricked by submitting `RestoreFootprintOp` for its instance storage, then `ExtendFootprintTTLOp` to keep it alive
- Archived persistent entries (routes, flight data, balances) can be restored the same way
- Only **Temporary** storage is truly permanent deletion

This changes the severity framing: most issues below are "temporarily inaccessible until restored" rather than "permanently lost." However, restoration requires the operator to **notice** the archival and **know** which entries to restore — which is why prevention (TTL management) and detection (graceful error handling + events) are both important.

### OZ Crate Storage (not audited — correctly managed)

The OpenZeppelin Stellar crates used by RiskVault and other contracts handle their own storage correctly:
- **Token balances** -> Persistent with TTL extension on access
- **Allowances** -> Temporary (time-bound by design)
- **Token metadata** (name, symbol, decimals) -> Instance
- **Vault config** (asset address, decimals offset) -> Instance
- **Owner address** -> Instance

These follow Soroban best practices and are not covered in this audit.

---

## 1. Consolidate FlightPool into a Single FlightPoolManager Contract

**Status:** Architecture change
**Severity:** CRITICAL — eliminates two TTL bugs (#1 FlightPool instance expiry, #5 ActiveFlight mapping expiry from the previous audit) and simplifies the entire system

### Problem

The current design deploys a separate FlightPool contract per `(flight_id, date)` via `env.deployer()`. Each pool is an independent contract with its own instance storage, token balance, and TTL lifecycle. This causes:

1. **FlightPool instance TTL expiry (old Issue #1):** Each pool's instance storage can independently archive if no one interacts with it for ~60 days. The existing TTL cron has no mechanism to keep individual pools alive. All 3 active pools on testnet are currently bricked.
2. **Controller ActiveFlight mapping expiry (old Issue #5):** The Controller stores `ActiveFlight(Symbol, u64) -> Address` in Persistent storage to find each pool. These entries expire independently — one expired entry crashes the entire settlement batch via `.unwrap()` panic.
3. **Deployment complexity:** Controller must store a `FlightPoolWasm` hash, manage deterministic salts, and deploy new contracts on first purchase.
4. **writeBytes pressure (old Issue #14):** Each FlightPool's WASM (~16-25 KB) is pulled into the transaction footprint on instance writes, contributing to the 132 KB limit.

### Solution: Single FlightPoolManager Contract

Replace N separate FlightPool contracts with one FlightPoolManager that stores all flight data internally.

**Storage layout:**

```rust
#[contracttype]
pub enum PoolKey {
    // Global — Instance storage (kept alive by existing cron)
    Controller,              // Address
    UsdcToken,               // Address
    RiskVault,               // Address
    ActiveFlightList,        // Vec<(Symbol, u64)> — pruned on settlement
    RecoveredBalance,        // i128 (total swept funds — replaces RecoveryPool contract)

    // Per-flight — Persistent storage, keyed by (flight_id, date)
    FlightConfig(Symbol, u64),   // FlightConfig struct

    // Per-buyer — Persistent storage
    Buyer(Symbol, u64, Address),    // bool (has policy)
    Claimed(Symbol, u64, Address),  // bool (has claimed)
}

#[contracttype]
pub struct FlightConfig {
    pub premium: i128,           // locked at creation
    pub payoff: i128,            // locked at creation
    pub delay_hours: u32,        // locked at creation
    pub buyer_count: u32,
    pub status: SettlementStatus,
    pub claim_expiry: u64,       // unix timestamp
}

#[contracttype]
pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}
```

**Key functions (replacing individual FlightPool methods):**

```rust
// Called by Controller on first purchase for a flight
fn register_flight(env: Env, controller: Address,
                   flight_id: Symbol, date: u64,
                   premium: i128, payoff: i128, delay_hours: u32);

// Called by Controller during buy_insurance
fn add_buyer(env: Env, controller: Address,
             flight_id: Symbol, date: u64, buyer: Address);

// Called by Controller during settlement
fn settle_on_time(env: Env, controller: Address,
                  flight_id: Symbol, date: u64);
fn settle_delayed(env: Env, controller: Address,
                  flight_id: Symbol, date: u64, claim_expiry: u64);
fn settle_cancelled(env: Env, controller: Address,
                    flight_id: Symbol, date: u64, claim_expiry: u64);

// Called by travelers after delayed/cancelled settlement
fn claim(env: Env, traveler: Address,
         flight_id: Symbol, date: u64);

// Called by anyone after claim expiry — credits RecoveredBalance internally
fn sweep_expired(env: Env, flight_id: Symbol, date: u64);

// Owner withdraws recovered (swept) funds
fn withdraw_recovered(env: Env, owner: Address, amount: i128);

// Read functions
fn get_flight_config(env: Env, flight_id: Symbol, date: u64) -> FlightConfig;
fn has_policy(env: Env, flight_id: Symbol, date: u64, traveler: Address) -> bool;
fn has_claimed(env: Env, flight_id: Symbol, date: u64, traveler: Address) -> bool;
fn get_active_flights(env: Env) -> Vec<(Symbol, u64)>;
fn get_recovered_balance(env: Env) -> i128;
```

**USDC flow changes:**

- All premiums are transferred to the FlightPoolManager (one contract holds all flight premiums)
- On delayed/cancelled settlement, RiskVault sends `(payoff - premium) * buyer_count` to FlightPoolManager
- On on-time settlement, FlightPoolManager sends premiums to RiskVault via `record_premium_income()`
- Travelers call `claim()` on FlightPoolManager with `(flight_id, date)` — no need to know a pool address
- `sweep_expired()` credits `RecoveredBalance` internally (no cross-contract transfer to a separate RecoveryPool)
- Owner calls `withdraw_recovered(amount)` to pull swept funds — replaces the RecoveryPool contract entirely

**Controller simplification:**

- Remove `FlightPoolWasm` storage key — no WASM hash management
- Remove `ActiveFlight(Symbol, u64)` mapping — no per-flight address tracking
- Remove `ActiveFlightList` — FlightPoolManager maintains its own
- Remove `RecoveryPool` address — recovery is now internal to FlightPoolManager
- Remove `env.deployer()` logic — no contract deployment
- Add `FlightPoolManager` address (Instance, set once) — one address replaces N
- `buy_insurance` calls `FlightPoolManager.register_flight()` (if first buyer) + `FlightPoolManager.add_buyer()`
- `execute_settlements` calls `FlightPoolManager.settle_*()` directly with `(flight_id, date)`

### TTL implications

| Entry | Storage tier | TTL management |
|-------|-------------|----------------|
| Global config (Controller, UsdcToken, etc.) | Instance | Existing cron `extend_ttl()` — no change |
| `ActiveFlightList` | Instance | Kept alive with all other instance data — no separate management |
| `RecoveredBalance` | Instance | Kept alive with all other instance data — no separate management |
| `FlightConfig(id, date)` | Persistent | `ExtendFootprintTTLOp` cron — same pattern as Oracle's `FlightData` |
| `Buyer(id, date, addr)` | Persistent | TTL set to `claim_expiry + 30 days` on write — no cron needed |
| `Claimed(id, date, addr)` | Persistent | TTL set to `claim_expiry + 30 days` on write — no cron needed |

**What this eliminates:**
- Old Issue #1 (FlightPool instance TTL): No separate contract instances to expire
- Old Issue #5 (Controller ActiveFlight mapping): No address mapping needed — Controller calls FlightPoolManager by `(flight_id, date)`
- RecoveryPool contract: Swept funds tracked internally via `RecoveredBalance` in Instance storage (always alive)
- Reduces writeBytes pressure: Fewer contracts in the transaction footprint; per-flight writes go to Persistent (no WASM pulled)

**Tradeoffs:**

| Pros | Cons |
|------|------|
| Eliminates two CRITICAL/HIGH TTL bugs | Single point of failure — bug affects ALL flights |
| No `env.deployer()`, no WASM hash, no salts | All flight USDC in one contract — larger blast radius |
| Simpler cross-contract calls (one address) | No natural isolation between flights |
| One WASM to upgrade for all flights | |
| `ActiveFlightList` in Instance — no TTL management | |
| Simpler cron — fewer entries to extend | |
| Frontend doesn't need pool addresses — just `(flight_id, date)` | |

### Files Involved
- `contracts/flight_pool/` — rewrite as FlightPoolManager (single contract, keyed by flight_id + date, with internal recovery accounting)
- `contracts/recovery_pool/` — delete (merged into FlightPoolManager)
- `contracts/controller/src/lib.rs` — remove deployer logic, ActiveFlight mapping, FlightPoolWasm, RecoveryPool address; add FlightPoolManager address; update buy/settle to call FlightPoolManager by (flight_id, date)
- `contracts/controller/src/test.rs` — update tests
- `contracts/integration_tests/` — update all integration tests; remove RecoveryPool from setup
- `executor/centralized_cron/src/ttl_extender.ts` — simplify: extend FlightPoolManager instance + per-flight Persistent entries (no more per-pool instance extension); remove RecoveryPool TTL extension
- `spec/architecture.md` — update FlightPool, RecoveryPool, and Controller sections

---

## 2. RiskVault `WithdrawalQueue` — Wrong Storage Tier

**Status:** Bug — latent, not yet triggered
**Severity:** CRITICAL — funds temporarily at risk (escrowed shares inaccessible until restored)

### Problem

`WithdrawalQueue` is a global Vec in **persistent** storage with **no TTL extension**. When a user calls `request_withdrawal(shares)`, their shares are escrowed to the vault contract and a `WithdrawalRequest` is appended to the queue. Without explicit TTL extension, the entry gets the network-minimum persistent TTL (on the order of days, depending on network configuration — not hours, but still far shorter than intended).

If the entry archives before `process_withdrawal_queue` runs:
1. Next read returns `unwrap_or(Vec::new(e))` — empty Vec
2. Escrowed shares are stuck in the vault with no on-chain record of ownership (restorable via `RestoreFootprintOp` if the operator notices)
3. Users cannot cancel their withdrawal (queue appears empty)

**This violates Principle 2:** the queue is global shared state — it should be in Instance storage, not Persistent. If it were Instance, the existing cron `extend_ttl()` would keep it alive automatically.

### Root Cause Analysis

The queue was placed in Persistent storage to avoid bloating the instance entry. This is an understandable optimization concern, but it trades correctness for efficiency. The Soroban docs are explicit: **all global state that cannot be Temporary should be in Instance storage.**

### Recommendation

**Move `WithdrawalQueue` to Instance storage.** Change all `storage().persistent().get/set(&VaultKey::WithdrawalQueue, ...)` to `storage().instance().get/set(...)`. The existing cron `extend_ttl()` call keeps the queue alive with all other instance data. The bloat concern is manageable — withdrawal queues are processed daily by cron and shouldn't accumulate more than a handful of entries at a time.

### Files Involved
- `contracts/risk_vault/src/lib.rs` — change `WithdrawalQueue` from `persistent()` to `instance()` in all access sites

---

## 3. RiskVault `ClaimableBalance` — Missing TTL + No Recovery Path

**Status:** Bug — latent
**Severity:** HIGH — funds temporarily at risk (processed withdrawal USDC inaccessible until restored)

### Problem

When `process_withdrawal_queue` processes a request, it burns escrowed shares and credits `ClaimableBalance(address)` in persistent storage. **No TTL extension is called.** The entry gets network-minimum persistent TTL (days, not hours — but still far shorter than a reasonable claim window).

If the user doesn't call `collect()` before the entry archives, `collect()` reads `get(&key).unwrap_or(0)` — returns 0 — asserts "nothing to collect". The USDC remains in the vault. The entry can be restored via `RestoreFootprintOp`, but the user would need to know their entry archived and submit the restore themselves (or ask the operator to do it).

This is **account-specific state**, so Persistent is the correct tier (Principle 2 doesn't apply — it's not global). Per Principle 7, wallets/dApps should present TTL info and suggest extensions for account-specific state. However, the current contract doesn't extend TTL at all, making the window unreasonably short.

### Recommendation

**Pull-based with TTL extension + owner recovery fallback.** Extend TTL to 60 days when crediting the balance. Add an owner-only `recover_uncollected(address, amount)` function that can re-credit or transfer funds if the entry expires. Owner uses off-chain event logs to reconstruct who is owed what.

Why not push-based (direct transfer)? If any recipient address is a contract that rejects incoming tokens, the entire `process_withdrawal_queue` transaction reverts — blocking all other users' withdrawals in the same batch. Soroban has no try/catch to isolate individual transfer failures within a loop. Pull-based avoids this by letting each user's `collect()` fail independently.

### Files Involved
- `contracts/risk_vault/src/lib.rs` — add TTL extension (60 days) after setting `ClaimableBalance` in `process_withdrawal_queue`; add owner-only `recover_uncollected(address, amount)` function

---

## 4. Governance Routes — Wrong Storage Tier

**Status:** Bug — latent
**Severity:** HIGH — protocol stops selling insurance on affected routes

### Problem

Routes (`Route(Symbol, Symbol, Symbol)` -> `RouteTerms`) and the route index (`RouteList`) are in **persistent** storage with **no TTL extension**. Route entries get the network-minimum persistent TTL (on the order of days). A route whitelisted today can archive within days if not extended. The next `buy_insurance` call panics with "route not found." The route can be restored via `RestoreFootprintOp`, but the operator has no way to know it archived — the error looks identical to "route was never whitelisted."

**Routes are global shared state** — all protocol users depend on them. Per Principle 2, they should be in Instance storage.

### Recommendation

**Move routes to Instance storage** (if route count stays under ~50, which is likely for a flight insurance protocol). Change all `storage().persistent().get/set(&DataKey::Route(...), ...)` to `storage().instance()`. Same for `RouteList`. Routes now share TTL with the contract instance — kept alive by existing cron. If route count could grow to hundreds, use `ExtendFootprintTTLOp` via cron as a pragmatic compromise.

### Files Involved
- `contracts/governance_module/src/lib.rs` — change `Route` and `RouteList` from `persistent()` to `instance()` in all access sites

---

## 5. Oracle `ActiveFlightList` — Never Pruned + TTL Risk

**Status:** Design issue
**Severity:** MEDIUM — unbounded gas cost growth + silent skip on archival

### Problem

The Oracle's `ActiveFlightList` is appended to in `register_flight` but **never pruned**. Settled flights stay in the list forever. Over time, `get_flights_by_status()` iterates an ever-growing list.

Additionally, the list is only TTL-extended in `register_flight`. If no new flights are registered for ~31 days, the list archives. On next read, `unwrap_or(Vec::new(e))` returns empty — silently skipping all pending flights.

**Per Principle 2**, this is global shared state and should ideally be in Instance. However, the list grows unboundedly, making Instance impractical without pruning.

### Recommendation

**Prune in `set_settled` + move to Instance.** Remove settled flights from the list in `set_settled`. With pruning, the list stays bounded to active flights and can safely live in Instance where the cron keeps it alive automatically.

### Files Involved
- `contracts/oracle_aggregator/src/lib.rs` — prune in `set_settled`, change to `instance()` storage

---

## 6. Oracle `FlightData` — Can Expire Before Settlement

**Status:** Design issue
**Severity:** MEDIUM — flight stuck in limbo, never settles

### Problem

`FlightData(Symbol, u64)` is TTL-extended to ~31 days on each oracle write. If the oracle backend doesn't push updates for 31+ days, the entry archives. `get_flight_data` returns the `NotInitiated` default — the Controller silently skips the flight forever.

This is **per-flight shared state** — Persistent is the correct tier (can't move to Instance — unbounded entries).

### Recommendation

**`ExtendFootprintTTLOp` via cron + graceful detection in Controller.** The cron iterates active flights and extends each `FlightData(id, date)` entry — same pass that extends FlightPoolManager's `FlightConfig` entries. Add detection logic in the Controller so the operator knows when data is missing vs. simply not ready yet.

### Files Involved
- `executor/centralized_cron/src/ttl_extender.ts` — extend `FlightData` entries via `ExtendFootprintTTLOp`
- `contracts/controller/src/lib.rs` — detect and emit event for unexpected `NotInitiated` status

---

## 7. RiskVault `SnapshotPrice` — Should Be Temporary Storage

**Status:** Optimization
**Severity:** LOW — cost reduction, no correctness issue

### Problem

`SnapshotPrice(u64)` stores daily share price snapshots. These are historical, informational, append-only entries with no TTL extension applied. No business logic depends on restoring archived snapshots.

Currently using **Persistent** storage, which means archived snapshots incur archival rent indefinitely even though they'll never be restored.

**Per Principle 1:** anything with a natural timeout should be Temporary. Snapshots are disposable by design.

### Recommendation

**Switch to Temporary storage with 30-day TTL.** Old snapshots are permanently deleted (no archival rent). Historical data lives off-chain via event indexing. Anyone can extend a Temporary entry's TTL via `ExtendFootprintTTLOp` — fine here since there's no security implication from a snapshot living longer.

### Files Involved
- `contracts/risk_vault/src/lib.rs` — change `storage().persistent()` to `storage().temporary()` for `SnapshotPrice`, add TTL extension to 30 days on write

---

## 8. MyPolicies Shows All Policies, Not Per-User

**Status:** UX bug
**Severity:** LOW

### Problem

The `/policies` page calls `Controller.get_active_pools()` which returns **all** active flights across the entire protocol. Every connected user sees every policy — not just the ones they purchased.

### Root Cause

There is no per-user index. The FlightPoolManager has `has_policy(flight_id, date, traveler)` but calling it per-flight from the frontend requires N RPC calls.

### Recommendation

**Add `get_flights_for_traveler(address)` to Controller.** Maintain a per-traveler index: `TravelerFlights(Address)` -> `Vec<(Symbol, u64)>` in Persistent storage. Append in `buy_insurance()`. New query function returns only that user's flights. Frontend calls this single function instead of iterating all flights.

The persistent entries should follow the same `ExtendFootprintTTLOp` cron pattern. For the frontend, replace `useActivePools()` with a new `useMyPolicies(address)` hook.

### Files Involved
- `contracts/controller/src/lib.rs` — add `TravelerFlights(Address)` storage key, append in `buy_insurance()`, add `get_flights_for_traveler()` query
- `frontend/src/pages/MyPolicies.tsx` — call `get_flights_for_traveler(address)` instead of `get_active_pools()`
- `frontend/src/hooks/useContracts.ts` — add `useMyPolicies(address)` hook
- `executor/centralized_cron/src/ttl_extender.ts` — extend `TravelerFlights` entries via `ExtendFootprintTTLOp`

---

## Summary: Priority Order

| # | Issue | Severity | Funds at Risk | Recommended Fix | Key Principle |
|---|-------|----------|---------------|-----------------|---------------|
| 1 | FlightPool -> FlightPoolManager + RecoveryPool merge | CRITICAL | Eliminates 2 TTL bugs + 1 contract | Single contract, per-flight Persistent keys, internal recovery accounting | P2 + P5 |
| 2 | RiskVault `WithdrawalQueue` in Persistent | CRITICAL | Temporarily — restorable | Move to Instance storage | P2: global state -> Instance |
| 3 | RiskVault `ClaimableBalance` no TTL | HIGH | Temporarily — restorable | TTL extension + owner recovery fallback | P3 + P7 |
| 4 | Governance routes in Persistent | HIGH | No — protocol stops, restorable | Move to Instance storage | P2: global state -> Instance |
| 5 | Oracle `ActiveFlightList` never pruned | MEDIUM | No — silent skip | Prune in `set_settled`, move to Instance | P2 + data hygiene |
| 6 | Oracle `FlightData` expires early | MEDIUM | Indirect — stuck flight | `ExtendFootprintTTLOp` cron + detection logic | P3 + observability |
| 7 | RiskVault `SnapshotPrice` tier | LOW | No — cost savings | Switch to Temporary | P1: prefer Temporary |
| 8 | MyPolicies UX | LOW | No | Add `get_flights_for_traveler(address)` to Controller | — |

### Cross-Cutting Work: `ExtendFootprintTTLOp` Cron

Issues 1 and 6 require the same cron enhancement: iterate active flights and extend TTL on per-flight Persistent entries via `ExtendFootprintTTLOp`. This should be a single cron job that:

1. Calls `FlightPoolManager.get_active_flights()` to get all `(flight_id, date)` tuples
2. Builds one `ExtendFootprintTTLOp` transaction covering:
   - Each `PoolKey::FlightConfig(id, date)` persistent entry in FlightPoolManager (Issue 1)
   - Each `OracleKey::FlightData(id, date)` persistent entry in OracleAggregator (Issue 6)
3. Submits the transaction

This replaces the previous requirement to extend N separate FlightPool contract instances + N Controller `ActiveFlight` mapping entries. The consolidation into FlightPoolManager significantly simplifies this cron — fewer contracts, fewer entry types, one address.
