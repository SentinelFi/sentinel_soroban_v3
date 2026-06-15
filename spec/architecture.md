# Architecture

## Table of Contents

- [System Overview](#system-overview)
- [Contracts (all Soroban / Rust)](#contracts-all-soroban--rust)
  - [GovernanceModule](#governancemodule)
  - [RiskVault](#riskvault)
  - [FlightPoolManager](#flightpoolmanager)
  - [Controller](#controller)
  - [OracleAggregator](#oracleaggregator)
- [Off-Chain Executor Layer (Modular)](#off-chain-executor-layer-modular)
  - [Cron Job Summary](#cron-job-summary)
  - [Cron #1 — FlightDataFetcher (Oracle, every 2 hours)](#cron-1--flightdatafetcher-oracle-every-2-hours)
  - [Cron #2 — FlightClassifier (Keeper, every 1 hour)](#cron-2--flightclassifier-keeper-every-1-hour)
  - [Cron #3 — SettlementExecutor (Keeper, every 5 minutes)](#cron-3--settlementexecutor-keeper-every-5-minutes)
  - [Cron #4 — TTL Extender (ExtendFootprintTTLOp, every 24 hours)](#cron-4--ttl-extender-extendfootprintttlop-every-24-hours)
  - [Why three separate crons?](#why-three-separate-crons)
  - [The Executor Interface](#the-executor-interface)
  - [Executor project structure](#executor-project-structure)
  - [Backend migration](#backend-migration)
- [Data Flow](#data-flow)
  - [Whitelisting a Route](#whitelisting-a-route)
  - [Buying Insurance](#buying-insurance)
  - [Flight Data Collection (FlightDataFetcher, every 2 hours)](#flight-data-collection-flightdatafetcher-every-2-hours)
  - [Flight Classification (FlightClassifier via Controller, every 1 hour)](#flight-classification-flightclassifier-via-controller-every-1-hour)
  - [Settlement Execution (SettlementExecutor via Controller, every 5 minutes)](#settlement-execution-settlementexecutor-via-controller-every-5-minutes)
  - [Traveler Claiming a Payout](#traveler-claiming-a-payout)
  - [Sweeping Expired Claims](#sweeping-expired-claims)
  - [Owner Withdrawing Recovered Funds](#owner-withdrawing-recovered-funds)
  - [Underwriter Withdrawing Capital (FIFO)](#underwriter-withdrawing-capital-fifo)
- [Solvency Invariant](#solvency-invariant)
- [Contract Relationships](#contract-relationships)
- [Access Control](#access-control)
- [Security](#security)
  - [Reentrancy](#reentrancy)
  - [Share Price Manipulation (RiskVault)](#share-price-manipulation-riskvault)
  - [Oracle Trust Model](#oracle-trust-model)
  - [Soroban Storage Rent & Archival](#soroban-storage-rent--archival)
  - [Known Limitations](#known-limitations)
- [User Flows](#user-flows)
  - [Traveler](#traveler)
  - [Underwriter](#underwriter)
  - [Function Reference](#function-reference)
- [dApp Frontend — Scaffold Stellar](#dapp-frontend--scaffold-stellar)
  - [Project Structure](#project-structure)
  - [Auto-Generated TypeScript Bindings](#auto-generated-typescript-bindings)
  - [Multi-Environment Configuration](#multi-environment-configuration)
- [Deployment Order](#deployment-order)

---

## System Overview

Decentralised flight delay insurance on **Stellar**. **Underwriters** deposit capital to back
claims; **travelers** pay a premium to receive a fixed payoff if their flight is delayed
beyond a configurable threshold (per-route `delay_hours`). All contracts are written in
**Rust** and compiled to **Soroban WASM**.

The system requires four off-chain cron jobs to keep ticking:

| Cron | Name | Frequency | Purpose |
|------|------|-----------|---------|
| #1 | **FlightDataFetcher** | Every 2 hours | Fetches flight data from AeroAPI, writes estimated/actual arrival times to OracleAggregator |
| #2 | **FlightClassifier** | Every 1 hour | Reads oracle data + FlightPoolManager terms, classifies landed flights as on_time / delayed / cancelled |
| #3 | **SettlementExecutor** | Every 5 minutes | Executes money movement for classified flights |
| #3b | **QueueMaintainer** | Every 5 minutes | Drains underwriter withdrawal queue + share-price snapshot (split out from #3 per audit M-03 so settlement gas pressure can't block underwriter payouts) |

These run inside a modular **Executor Backend** that is fully swappable. The contracts
enforce authorization via `require_auth()` on owner-updatable addresses — they don't know
or care what backend is calling them. The oracle and keeper can share a single authorized
address or use separate ones. Swapping from a centralized cron to Acurast TEE, Phala TEE,
or any future keeper is a single owner transaction per contract. No redeployment needed.

All payouts and withdrawals are **pull-based**: funds are credited on-chain and actors
claim them explicitly. Insurance is never sold unless the system has enough capital to
cover the payout — the protocol is **always solvent**.

The **Controller never holds any money** — it orchestrates everything by calling functions
on other contracts that change state and move funds.

The frontend dApp is scaffolded with **Scaffold Stellar** (React + Vite), with auto-generated
TypeScript bindings for every Soroban contract.

---

## Contracts (all Soroban / Rust)

### GovernanceModule

The route authority. Owns the canonical terms for whitelisted flight routes — premium, payoff,
and delay threshold. The Controller reads route status from this contract before every
insurance purchase. **Route enumeration lives off-chain** via an event-sourced indexer; the
contract intentionally does NOT maintain a list of all whitelisted routes (was a footprint
hazard at scale).

- A **route** is identified by `(flight_id, origin, destination)` as a `Symbol` tuple.
- The contract stores **global default terms** — `default_premium`, `default_payoff`,
  `default_delay_hours` — that apply to any whitelisted route without custom terms.
- When a route is **whitelisted**, custom `premium`, `payoff`, and `delay_hours` can
  optionally be assigned; unset fields fall back to defaults.
- A route has three states from the protocol's view: **Active** (entry exists,
  approved), **Disabled** (entry exists, soft-blocked from new purchases),
  **Unknown** (entry missing — never whitelisted, removed, or storage archived).
  The typed `route_status()` reader exposes all three.
- **Disabling** is reversible (`disable_route` → `enable_route`) and used for temporary
  suspension. **Removing** is permanent: hard-deletes the storage entry. `remove_route` is
  **strict** — it requires the route to be disabled first, preventing fat-finger removal of
  an actively-purchasable route.
- **Terms can be updated** by the owner or an admin. Updates only apply to flights registered
  after the update; existing flights have their terms locked at registration (the Controller
  resolves `route_status()` at purchase time and snapshots into `FlightConfig`).
- **Whitelisting a route does NOT create a flight entry.** Flight entries are created lazily
  on first purchase (see Controller).
- All route writes are gated by `require_owner_or_admin`. Owner-only changes
  (`set_defaults`, `add_admin`, `remove_admin`) use the OZ `#[only_owner]` guard.
- **Terms validation** (audit H-04): every write path — constructor, `set_defaults`,
  `whitelist_route`, `update_route_terms` — asserts `premium > 0`, `payoff > 0`,
  `payoff > premium`, `delay_hours > 0` against the resolved (defaults-folded) values.
  An admin cannot whitelist or update a route to non-paying or guaranteed-payout terms.
- **Pausable** (audit H-03). Owner-only `pause(caller)` / `unpause(caller)` halts all
  governance write entry points; `route_status()` / `get_defaults()` reads remain available.

**Storage layout:**

```rust
#[contracttype]
pub enum DataKey {
    Admin(Address),                                 // bool — Instance
    DefaultPremium,                                 // i128 — Instance (stroops of USDC)
    DefaultPayoff,                                  // i128 — Instance (stroops of USDC)
    DefaultDelayHours,                              // u32 — Instance (hours)
    Route(Symbol, Symbol, Symbol),                  // RouteTerms — Persistent
}

#[contracttype]
pub struct RouteTerms {
    pub premium: Option<i128>,      // None → use default
    pub payoff: Option<i128>,       // None → use default
    pub delay_hours: Option<u32>,   // None → use default
    pub approved: bool,
}
```

`Owner` lives in OZ `ownable` storage (not in `DataKey`). `RouteStatus` and
`ResolvedTerms` (described below) live in the workspace-wide `sentinel_types`
crate so the governance contract and the controller's cross-contract client
share a single XDR layout (audit I-05).

**Read API — typed status:**

```rust
#[contracttype]
pub enum RouteStatus {
    Active(ResolvedTerms),  // entry exists, approved == true; defaults folded
    Disabled,               // entry exists, approved == false
    Unknown,                // entry missing (never whitelisted, removed, or archived)
}

#[contracttype]
pub struct ResolvedTerms {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
}

fn route_status(env: Env, flight_id: Symbol, origin: Symbol,
                dest: Symbol) -> RouteStatus;
fn get_defaults(env: Env) -> (i128, i128, u32);
fn is_admin(env: Env, addr: Address) -> bool;
```

`route_status()` resolves defaults at read time — `Active(ResolvedTerms)` returns concrete
values, never `Option`. The Controller's purchase path is one cross-contract call + a `match`
on three variants (replacing the old two-call `is_route_whitelisted` + `get_route_terms`
pattern).

**Write API — explicit lifecycle + partial updates:**

```rust
// Defaults (owner-only)
fn set_defaults(env: Env, premium: i128, payoff: i128, delay_hours: u32);

// Admin management (owner-only)
fn add_admin(env: Env, admin: Address);
fn remove_admin(env: Env, admin: Address);

// Route lifecycle (owner or admin)
fn whitelist_route(env: Env, caller: Address, flight_id: Symbol,
                   origin: Symbol, dest: Symbol,
                   premium: Option<i128>, payoff: Option<i128>,
                   delay_hours: Option<u32>);
fn disable_route(env: Env, caller: Address, flight_id: Symbol,
                 origin: Symbol, dest: Symbol);
fn enable_route(env: Env, caller: Address, flight_id: Symbol,
                origin: Symbol, dest: Symbol);
fn remove_route(env: Env, caller: Address, flight_id: Symbol,
                origin: Symbol, dest: Symbol);  // strict: requires disabled

// Partial-update on terms (per-field op enums)
pub enum PremiumUpdate    { Keep, Set(i128), UseDefault }
pub enum PayoffUpdate     { Keep, Set(i128), UseDefault }
pub enum DelayHoursUpdate { Keep, Set(u32),  UseDefault }

fn update_route_terms(env: Env, caller: Address, flight_id: Symbol,
                      origin: Symbol, dest: Symbol,
                      premium: PremiumUpdate, payoff: PayoffUpdate,
                      delay_hours: DelayHoursUpdate);
```

The three per-field `*Update` enums encode partial updates without Soroban's generic-free
contracttype constraint. `Keep` skips the field, `Set(v)` writes a custom value,
`UseDefault` clears the override so the global default applies. The op encoding itself is a
caller-input type — never persisted, never on the event wire.

**Events (consumed by off-chain indexer):**

Topic scheme is `["sentinel", "<verb>"]` (audit L-03). The `#[contractevent]`
macro caps the prefix list at 2 entries, so the old `["route", "X"]` /
`["gov", "X"]` two-symbol prefixes collapse to `["sentinel", "route_X"]` /
`["sentinel", "gov_X"]` — the contract address (always present on every
event envelope) discriminates between governance and the rest.

```
("sentinel", "route_listed")    → (flight_id, origin, dest, premium?, payoff?, delay_hours?)
("sentinel", "route_disabled")  → (flight_id, origin, dest)
("sentinel", "route_enabled")   → (flight_id, origin, dest)
("sentinel", "route_updated")   → (flight_id, origin, dest, premium?, payoff?, delay_hours?)
("sentinel", "route_removed")   → (flight_id, origin, dest)
("sentinel", "gov_defaults")    → (premium, payoff, delay_hours)
("sentinel", "gov_admin_added") → (admin)
("sentinel", "gov_admin_removed") → (admin)
```

`flight_id` is also the third event topic for every `route_*` event (after the two-symbol
prefix), which lets indexers filter by flight at the RPC layer. `route.listed` and
`route.updated` carry **`Option<T>`** for `premium` / `payoff` / `delay_hours` — `None`
means "use default" — so the indexer can mirror option-ness in its schema (e.g. SQL `NULL`)
and re-resolve against the latest `gov.defaults` row at read time. This means a defaults
change doesn't require updating every `UseDefault` route — the indexer just updates its
defaults singleton.

The on-chain `route_status()` is the protocol's source of truth on the buy path. The
off-chain indexer is read-side cache only — it folds these events into a queryable
"current whitelist" table for the TTL cron (Cron #4) and any admin UI. A stale or down
indexer cannot influence purchase decisions.

**Storage tier rationale:** `Route(...)` lives in **Persistent** storage, keyed per-route
with an independent TTL. Instance is wrong at scale — every contract invocation loads all
Instance entries into the transaction footprint, so thousands of routes (realistic at hub
airports with multi-leg itineraries) would blow past per-tx limits. `RouteList` was removed
for the same reason: a single `Vec` of all routes is a footprint hazard at any storage tier.
TTL on every `Route(...)` write maintains a 60-day window for actively edited routes; idle
routes are kept alive by the off-chain TTL cron (Cron #4) which folds `Route(...)` keys into
its `ExtendFootprintTTLOp` footprint using the indexer's enumeration.

---

### RiskVault

The capital backing layer. All underwriter USDC sits here. Built on the **OpenZeppelin
Stellar `FungibleVault`** contract — shares are a standard Soroban fungible token and the
vault is composable with any vault-aware tooling.

**OZ Vault foundation:**

- Implements `FungibleToken` + `FungibleVault` traits from `stellar-contracts`.
- Shares named "RiskVault Share" / `RVS`.
- `decimals_offset` set to `3` (virtual shares = `10^3`) to prevent inflation attacks
  and rounding manipulation — the OZ vault adds virtual shares/assets to conversion formulas.
- Directional rounding (deposit rounds down shares, withdraw rounds up shares) protects
  vault solvency on every conversion.

**Custom extensions on top of OZ Vault:**

- **`total_assets()` is overridden** to return an internal `total_managed_assets` counter
  stored in `Instance` storage rather than raw token balance. This prevents share price
  manipulation via direct USDC transfers.
- `locked_capital: i128` tracks USDC committed as collateral for active policies.
  `max_withdraw` and `max_redeem` are overridden to cap redemptions at
  `free_capital = total_managed_assets - locked_capital`.
- **Two withdrawal paths, one contract:**
  - **Immediate (`redeem`)** — OZ Vault standard. Burns shares and transfers USDC when
    `free_capital >= redemption`.
  - **Queued (`request_withdrawal`)** — non-standard extension for locked capital.
    Enqueues `(request_id, caller, shares, timestamp)` in a FIFO queue stored in **Instance**
    storage. Returns the freshly-issued `request_id: u64` (monotonic counter, audit M-04 fix).
    After each settlement cycle the keeper calls `run_queue_maintenance()`, which drives
    `process_withdrawal_queue()` and credits fulfilled requests to `claimable_balance`.
    Underwriters call `collect()` to pull USDC.
- `cancel_withdrawal(caller, request_id)` cancels a pending request by its stable id and
  releases reserved shares. Indices shift when earlier requests drain — request_id stays
  put.
- `snapshot()` records daily share price. Called from `run_queue_maintenance` once per
  24 hours (gated by `env.ledger().timestamp()`). Price scale is derived from the
  underlying asset's `decimals()` so the metric stays meaningful regardless of stablecoin
  precision (audit L-04). Snapshots use **Temporary** storage with a 30-day TTL — old
  snapshots are permanently deleted (no archival rent). Historical data lives off-chain
  via the `SharePriceSnapshot` event.
- Only the Controller (set once via `set_controller()`) can call: `increase_locked`,
  `decrease_locked`, `send_payout`, `process_withdrawal_queue`, `record_premium_income`.
- **`recover_uncollected(user, amount, mode)`** — owner-only function that re-credits or
  transfers funds if a `ClaimableBalance` entry expires. Single function with a
  `RecoveryMode { Recredit, Transfer }` enum:
  - `Recredit` — SET `ClaimableBalance(user) = amount` + extend TTL. Owner provides the
    full owed amount reconstructed from event logs. **Asserts** `amount >= existing`
    (audit H-01) so the owner cannot accidentally underpay an outstanding credit.
  - `Transfer` — gated on a prior credit: asserts `amount <= ClaimableBalance(user)`,
    decrements (or removes) the entry before the USDC transfer (CEI), and refuses
    if the user has no prior credit (audit C-02). Owner workflow for an archived
    entry is therefore Recredit-then-Transfer.
  Owner uses off-chain event logs (`sentinel.credited` / `sentinel.collected`) to
  reconstruct who is owed what. `recover_uncollected` is intentionally NOT gated by
  Pausable so the owner can still settle archived entries during a pause.

**Storage layout:**

```rust
#[contracttype]
pub enum VaultKey {
    Controller,                // Address — Instance (set once)
    TotalManagedAssets,        // i128 — Instance
    LockedCapital,             // i128 — Instance
    WithdrawalQueue,           // Vec<WithdrawalRequest> — Instance
    NextRequestId,             // u64 — Instance (monotonic counter)
    ClaimableBalance(Address), // i128 — Persistent (TTL extended to 60 days on write)
    LastSnapshotTime,          // u64 — Instance
    SnapshotPrice(u64),        // i128 — Temporary (30-day TTL, keyed by day)
}

#[contracttype]
pub struct WithdrawalRequest {
    pub request_id: u64,    // stable id — audit M-04
    pub owner: Address,
    pub shares: i128,
    pub timestamp: u64,
}
```

**Storage tier rationale:**

- **`WithdrawalQueue`** is in **Instance** storage. It is global shared state — all users'
  withdrawal requests live in one Vec. Per Soroban best practice, global state should be
  Instance so it shares TTL with the contract instance. The queue is processed daily by cron
  and should not accumulate more than a handful of entries at a time.
- **`ClaimableBalance(Address)`** is in **Persistent** storage (account-specific, not global).
  Three-layer TTL defense (per Improvement #3):
  1. **On-write extension** — Phase 8: `process_withdrawal_queue` and the Recredit path of
     `recover_uncollected` extend TTL by 60 days every time the entry is written.
  2. **Cron #4 secondary defense** — Phase 11 executor work: the off-chain TTL-extender
     cron includes `ClaimableBalance(addr)` keys in its `ExtendFootprintTTLOp` footprint,
     sourced from the off-chain indexer's `claimable_balances` table (Improvement #9, fed
     by the `vault.credited` / `vault.collected` / `vault.recovered` events).
  3. **Manual fallback** — owner-only `recover_uncollected()` if a balance archives anyway
     despite layers 1+2.
- **`SnapshotPrice(u64)`** is in **Temporary** storage with a 30-day TTL. Snapshots are
  historical, informational, append-only — no business logic depends on restoring archived
  snapshots. Temporary avoids archival rent for data that will never be restored.
  `get_snapshot_price()` returns 0 (`unwrap_or(0)`) for entries that have aged out — that's
  the desired behavior; stale snapshots aren't queryable on-chain.

**Events emitted (audit L-03, L-05 namespace pass):**

```
("sentinel", "credited",  <user>)  → Credited            (amount, new_balance)
("sentinel", "collected", <user>)  → Collected           (amount)
("sentinel", "recovered", <user>)  → Recovered           (amount, mode: RecoveryMode)
("sentinel", "snapshot",  <day>)   → SharePriceSnapshot  (price)
```

`Credited` / `Collected` / `Recovered` power the off-chain indexer (Improvement #9)
which maintains a `claimable_balances(addr)` table for the Phase 11 cron's secondary
TTL defense. `credited` fires from `process_withdrawal_queue` on every credit;
`collected` fires from `collect()` on full drain (entry removed); `recovered` fires
from `recover_uncollected` with the `mode` enum carrying which path was taken.
`SharePriceSnapshot` (audit L-05) fires from `snapshot()` once per day so analytics
can subscribe instead of polling.

**Authorization:**

```rust
// Controller-only functions use:
fn increase_locked(env: Env, controller: Address, amount: i128) {
    controller.require_auth();
    let stored = env.storage().instance().get(&VaultKey::Controller).unwrap();
    assert!(controller == stored, "not controller");
    // ...
}
```

---

### FlightPoolManager

A single contract that manages all flight insurance pools. Stores all flight data internally,
keyed by `(flight_id, date)`. Replaces the previous design of deploying a separate FlightPool
contract per flight. Also handles recovery accounting internally — unclaimed expired payouts
are tracked via `RecoveredBalance` in Instance storage, eliminating the need for a separate
RecoveryPool contract.

- **Flight registration** happens on first `buy_insurance()` call for a given `(flight_id, date)`.
  The Controller calls `register_flight()` with locked terms (read from GovernanceModule at
  purchase time, with defaults resolved).
- `register_flight` is **idempotent** (audit M-05): re-registering with matching terms
  is a no-op (TTL is extended). Re-registering with *different* terms panics — this
  protects buyers from admin term changes between their tx submission and inclusion
  swapping locked terms underfoot. Two travelers racing to first purchase in the same
  ledger both succeed.
- `premium`, `payoff`, and `delay_hours` are locked per-flight at registration and cannot be changed.
- **Premiums are locked.** When a traveler buys insurance, the premium is transferred to
  FlightPoolManager and locked — insurers cannot withdraw it.
- On settlement:
  - **On time:** premiums transferred from FlightPoolManager to RiskVault via `record_premium_income()`.
    This is how underwriters earn yield.
  - **Delayed / Cancelled:** RiskVault sends `(payoff - premium) * buyer_count` USDC to
    FlightPoolManager. The contract already holds `premium * buyer_count` from purchases, so each
    buyer's total claimable amount equals `payoff`.
- **Pull-based payouts.** After delayed/cancelled settlement, each buyer calls `claim(flight_id, date)`.
  A `Persistent` storage key `Claimed(Symbol, u64, Address)` prevents double claims.
  Payouts can only be claimed **after the flight is settled**.
- **Claim expiry.** Unclaimed payouts expire after a configurable window (default 60 days).
  After expiry, `sweep_expired(flight_id, date)` credits `RecoveredBalance` internally —
  no cross-contract transfer needed.
- **Owner recovery.** Owner calls `withdraw_recovered(amount)` to pull swept funds.
- Only the Controller can call `register_flight`, `add_buyer`, `settle_on_time`,
  `settle_delayed`, `settle_cancelled`.

**Storage layout:**

```rust
#[contracttype]
pub enum PoolKey {
    // Global — Instance storage (kept alive by existing cron)
    Controller,              // Address
    UsdcToken,               // Address
    RiskVault,               // Address
    ActiveFlightList,        // Vec<(Symbol, u64)> — pruned on settlement
    RecoveredBalance,        // i128 (total swept funds)

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
    pub claimed_count: u32,
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

`FlightConfig` and `SettlementStatus` live in the workspace-wide `sentinel_types`
crate (audit I-05) so the pool and the controller's cross-contract client share a
single XDR layout.

**Key functions:**

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

// Owner withdraws recovered (swept) funds. Owner is implicit
// (`#[only_owner]` reads from OZ ownable storage); no `owner` arg.
fn withdraw_recovered(env: Env, amount: i128);

// Read functions
fn get_flight_config(env: Env, flight_id: Symbol, date: u64) -> Option<FlightConfig>;
fn has_policy(env: Env, flight_id: Symbol, date: u64, traveler: Address) -> bool;
fn has_claimed(env: Env, flight_id: Symbol, date: u64, traveler: Address) -> bool;
fn get_active_flights(env: Env) -> Vec<(Symbol, u64)>;
fn get_recovered_balance(env: Env) -> i128;
```

`get_flight_config` returns `None` if the flight is not registered (matches
oracle's `get_flight_data` style of returning a sentinel for missing entries
rather than panicking). This lets the Controller's `buy_insurance` do
"look up; if missing, register" in one cross-contract call without forcing
a panic + restart.

**USDC flow:**

- All premiums are transferred to FlightPoolManager (one contract holds all flight premiums)
- On delayed/cancelled settlement, RiskVault sends `(payoff - premium) * buyer_count` to FlightPoolManager
- On on-time settlement, FlightPoolManager sends premiums to RiskVault via `record_premium_income()`
- Travelers call `claim()` on FlightPoolManager with `(flight_id, date)` — no need to know a pool address
- `sweep_expired()` credits `RecoveredBalance` internally (no cross-contract transfer)
- Owner calls `withdraw_recovered(amount)` to pull swept funds

**Payout math example:**

```
premium = $10, payoff = $50, 2 buyers

On purchase:
  FlightPoolManager holds: $10 * 2 = $20 (locked premiums)
  RiskVault locks:  $50 * 2 = $100 (collateral for max liability)

If delayed/cancelled:
  RiskVault sends: ($50 - $10) * 2 = $80 to FlightPoolManager
  FlightPoolManager now holds: $20 + $80 = $100
  Each buyer claims: $50

If on time:
  FlightPoolManager sends: $20 to RiskVault (premium income / underwriter yield)
  RiskVault unlocks: $100 (collateral released)
```

**Storage tier rationale:**

| Entry | Storage tier | TTL management |
|-------|-------------|----------------|
| Global config (Controller, UsdcToken, etc.) | Instance | Existing cron `extend_ttl()` — no change |
| `ActiveFlightList` | Instance | Kept alive with all other instance data — no separate management |
| `RecoveredBalance` | Instance | Kept alive with all other instance data — no separate management |
| `FlightConfig(id, date)` | Persistent | `extend_flight_ttl` (31d) on register; **on settle**, `extend_flight_ttl_to(claim_expiry + 30d)` so the claim window is self-sufficient on-chain (audit C-01). `ExtendFootprintTTLOp` cron is the long-term layer. |
| `Buyer(id, date, addr)` | Persistent | TTL set to `claim_expiry + 30 days` on write — no cron needed |
| `Claimed(id, date, addr)` | Persistent | TTL set to `claim_expiry + 30 days` on write — no cron needed |

---

### Controller

The system orchestrator. **Never holds USDC** — routes premiums directly from the traveler
to FlightPoolManager via the Soroban token `transfer()` interface. The Controller orchestrates
everything: it calls functions on other contracts that change state and move money.

**Responsibilities:**

1. **Validate routes** against GovernanceModule before every purchase.
2. **Read terms** (premium, payoff, delay_hours) from GovernanceModule (with defaults resolved).
3. **Register flights** on FlightPoolManager on first purchase for a given `(flight_id, date)`.
4. **Gate purchases** behind a solvency check and configurable `minimum_lead_time` (default 1 hour).
5. **Route USDC premiums** from travelers to FlightPoolManager.
6. **Classify flights** via `classify_flights()` — read OracleAggregator for flights with
   `Landed` or `Cancelled` status, read FlightPoolManager `delay_hours`, compute outcome, and
   set the appropriate `ToBeSettled*` status on OracleAggregator.
7. **Execute settlements** via `execute_settlements()` — process all flights in `ToBeSettled*`
   status: move money between FlightPoolManager and RiskVault, mark flights as `Settled`.
8. **Drain the underwriter withdrawal queue + share-price snapshot** via the separate
   keeper entry point `run_queue_maintenance()` (audit M-03 split). Decoupled from
   `execute_settlements` so queue payouts can't be blocked by settlement gas pressure.
9. Maintains aggregate counters — `total_policies_sold`, `total_premiums_collected`,
   `total_payouts_distributed`.
10. Maintains a **per-traveler index** — `TravelerFlights(Address)` in Persistent storage —
    for efficient frontend queries. Appended on each `buy_insurance()` call.
11. Exposes `get_flights_for_traveler(address)` for the frontend to show only a user's policies.
12. **Emits `sentinel.ttl_miss(flight_id, date)`** from `classify_flights` when oracle returns
    `NotInitiated` for a flight in the active list — diagnostic signal consumed by the
    off-chain TTL-extender cron (Improvement #6) so it can detect archived `FlightData`
    entries and react before settlement fails.
13. **Bounded owner setters** (audit H-07 + M-02): `set_solvency_ratio` ∈ [100, 10_000],
    `set_min_lead_time` ≤ 90d, `set_claim_expiry_window` ∈ [1d, 180d]. Same bounds
    enforced in `__constructor`.
14. **Pausable** (audit H-03). Owner-only pause halts `buy_insurance`, `classify_flights`,
    `execute_settlements`, `run_queue_maintenance`; admin setters and `extend_ttl` stay
    open so the owner can recover from a paused state.
15. **Buyer whitelist (Phase 11)** — opt-in allowlist on `buy_insurance`. Owner-only
    `set_whitelist_enabled(bool)` flips the kill-switch (default `false`, so deploy is
    non-breaking). When enabled, `buy_insurance` panics with `"buyer not whitelisted"`
    unless `BuyerWhitelisted(traveler) == true`. Admin-managed via
    `add_whitelisted_buyer(caller, addr)` / `remove_whitelisted_buyer(caller, addr)`
    where `caller` is the owner or any address flagged on `GovernanceModule.is_admin`
    — single source of truth for admin identity, no duplicated admin list. Admin paths
    are intentionally NOT gated by Pausable (mirrors `recover_uncollected`) so the
    list stays manageable during a pause.

**Three settlement-phase keeper entry points — different rates, separated by audit M-03:**

```rust
/// Called by FlightClassifier cron (every 1 hour).
/// Reads oracle data + FlightPoolManager delay_hours, classifies outcome,
/// writes ToBeSettled* status back to OracleAggregator.
fn classify_flights(env: Env, keeper: Address) {
    keeper.require_auth();
    let authorized = env.storage().instance().get(&CtrlKey::AuthorizedKeeper).unwrap();
    assert!(keeper == authorized, "not authorized keeper");
    // ... classification logic ...
}

/// Called by SettlementExecutor cron (every 5 minutes).
/// Processes all ToBeSettled* flights: moves money, marks Settled.
/// Does NOT touch the withdrawal queue or share-price snapshot.
fn execute_settlements(env: Env, keeper: Address) {
    keeper.require_auth();
    let authorized = env.storage().instance().get(&CtrlKey::AuthorizedKeeper).unwrap();
    assert!(keeper == authorized, "not authorized keeper");
    // ... settlement execution logic ...
}

/// Called by QueueMaintainer cron (every 5 minutes, decoupled from settlement).
/// Drains the underwriter withdrawal queue + records the daily share-price
/// snapshot. Split out from execute_settlements so heavy settlements can't
/// block underwriter payouts (audit M-03).
fn run_queue_maintenance(env: Env, keeper: Address) {
    keeper.require_auth();
    let authorized = env.storage().instance().get(&CtrlKey::AuthorizedKeeper).unwrap();
    assert!(keeper == authorized, "not authorized keeper");
    vault.process_withdrawal_queue(&controller_addr);
    vault.snapshot();
}
```

The `authorized_keeper` is the Soroban `Address` of whoever is running the keeper jobs
(FlightClassifier and SettlementExecutor). Both functions use the same authorized address.
The contract doesn't know or care which backend is calling — only that the caller is
authorized. The owner can update `authorized_keeper` at any time to migrate between
executor backends.

**Cross-contract calls** use auto-generated Soroban clients:

```rust
// Generated client for GovernanceModule
let gov_client = GovernanceModuleClient::new(&env, &governance_addr);
let terms = match gov_client.route_status(&flight_id, &origin, &dest) {
    RouteStatus::Active(t) => t,
    RouteStatus::Disabled  => panic!("route is disabled"),
    RouteStatus::Unknown   => panic!("route not whitelisted"),
};

// Generated client for RiskVault
let vault_client = RiskVaultClient::new(&env, &vault_addr);
vault_client.increase_locked(&controller_addr, &terms.payoff);

// Generated client for OracleAggregator
let oracle_client = OracleAggregatorClient::new(&env, &oracle_addr);
let flight_data = oracle_client.get_flight_data(&flight_id, &date);

// Generated client for FlightPoolManager
let pool_client = FlightPoolManagerClient::new(&env, &pool_manager_addr);
pool_client.register_flight(&controller_addr, &flight_id, &date,
                            &terms.premium, &terms.payoff, &terms.delay_hours);
```

**Events emitted (audit L-03 + L-08 namespace pass; Phase 11 whitelist events):**

```
("sentinel", "ctrl",              <traveler>, <flight_id>, <date>) → InsuranceBought             (premium)
("sentinel", "ctrl",              <flight_id>, <date>)             → FlightClassified            (status)
("sentinel", "ctrl",              <flight_id>, <date>)             → FlightSettledEvent          (outcome)
("sentinel", "ttl_miss",          <flight_id>)                     → TtlMiss                     (date)
("sentinel", "buyer_whitelisted", <addr>)                          → BuyerWhitelistedEvent
("sentinel", "buyer_removed",     <addr>)                          → BuyerWhitelistRemovedEvent
("sentinel", "whitelist_toggled")                                  → WhitelistToggled            (enabled)
```

The first three are domain events covering the buy / classify / settle
lifecycle. `InsuranceBought` gained `flight_id` and `date` as topics
(audit L-08) so indexers can filter by flight directly without joining
through `BuyerAdded`. `TtlMiss` is a diagnostic warning emitted by
`classify_flights` only — it fires once per `(flight_id, date)` per cron
tick (every 1 hour) for any registered flight whose oracle status is still
`NotInitiated`. Consumed by the off-chain TTL-extender cron via
`rpc.getEvents` filtering on the `("sentinel", "ttl_miss")` topic prefix.

**Storage layout:**

```rust
#[contracttype]
pub enum CtrlKey {
    Owner,                     // Address — Instance
    Governance,                // Address — Instance
    RiskVault,                 // Address — Instance
    Oracle,                    // Address — Instance
    FlightPoolManager,         // Address — Instance (set once)
    UsdcToken,                 // Address — Instance
    AuthorizedKeeper,          // Address — Instance (executor backend — shared by classifier + settler)
    SolvencyRatio,             // u32 — Instance (default 100)
    MinLeadTime,               // u64 — Instance (seconds)
    ClaimExpiryWindow,         // u64 — Instance (seconds)
    TravelerFlights(Address),  // Vec<(Symbol, u64)> — Persistent (per-user flight index)
    TotalPoliciesSold,         // u64 — Instance
    TotalPremiumsCollected,    // i128 — Instance
    TotalPayoutsDistributed,   // i128 — Instance
    WhitelistEnabled,          // bool — Instance (Phase 11; default false → open buys)
    BuyerWhitelisted(Address), // bool — Persistent (Phase 11; per-buyer entry, 60d TTL on write)
}
```

---

### OracleAggregator

On-chain registry of flight data and settlement pipeline status. The **single source of
truth** for all flight lifecycle state — from registration through settlement.

**State machine** (forward-only, never regresses):

```
NotInitiated -> Active -> Landed --> ToBeSettledOnTime --> Settled
       |          |                  ToBeSettledDelayed --> Settled
       |          +---> Cancelled -> ToBeSettledCancelled -> Settled
       +-----------------^                                  (short-notice cancel,
                                                            audit L-01)
```

| State | Meaning | Set by |
|-------|---------|--------|
| `NotInitiated` | Flight registered, no data yet. Oracle needs to fetch estimated arrival time. | Controller (on flight registration) |
| `Active` | Estimated arrival time stored. Waiting for flight to land. | FlightDataFetcher (oracle cron) |
| `Landed` | Flight has landed. `actual_arrival_time` stored. Ready for classification. | FlightDataFetcher (oracle cron) |
| `Cancelled` | Flight was cancelled. Ready for classification. | FlightDataFetcher (oracle cron) |
| `ToBeSettledOnTime` | Controller classified as on-time. Awaiting money movement. | FlightClassifier (via Controller) |
| `ToBeSettledDelayed` | Controller classified as delayed. Awaiting money movement. | FlightClassifier (via Controller) |
| `ToBeSettledCancelled` | Controller classified as cancelled. Awaiting money movement. | FlightClassifier (via Controller) |
| `Settled` | Settlement complete. Money has been moved. | SettlementExecutor (via Controller) |

**Flight data stored per flight:**

- `estimated_arrival_time: u64` — set by oracle when transitioning `NotInitiated -> Active`
- `actual_arrival_time: u64` — set by oracle when transitioning `Active -> Landed`
- `settled_at: u64` — set by controller when transitioning `ToBeSettled* -> Settled`
  (`0` means not-yet-settled). Drives the delayed-prune logic on `ActiveFlightList`.
- All timestamps are unix epoch seconds.

**Key rules:**

- **Status is forward-only** — once a status is set it can only advance, never regress.
- The `authorized_oracle` can push data updates (`set_estimated_arrival`, `set_landed`,
  `set_cancelled`). The address is **owner-updatable** for backend migration.
- The `authorized_controller` can register flights, set `ToBeSettled*` statuses, and
  mark flights as `Settled`. Set once via `set_controller()`, immutable after.
- `get_flight_data()` never panics — returns `NotInitiated` status as safe fallback
  for missing entries.
- `register_flight` is **idempotent** (audit M-05): re-registering an existing flight
  is a no-op (extends TTL).
- **`set_landed` plausibility check** (audit L-02): asserts
  `actual_arrival_time >= estimated_arrival_time` — a buggy or adversarial oracle
  cannot mark a delayed flight as on-time via an actual-before-estimated report.
- **Delayed prune.** `set_settled` records `settled_at` but does NOT remove the flight
  from `ActiveFlightList`. A separate permissionless `prune_settled()` entry is what
  evicts settled flights from the list, and only after they have been settled for at
  least `SETTLED_RETENTION_DAYS = 30` days. **Missing `FlightData`** (e.g. an entry
  archived past its TTL) is treated as evict-and-continue (audit H-02) — a single
  archived entry no longer blocks all future pruning.
- **Pausable** (audit H-03). Owner-only pause halts every oracle/controller write
  entry point; `prune_settled` and `extend_ttl` stay open as permissionless
  housekeeping.

**Storage layout:**

```rust
#[contracttype]
pub enum OracleKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Owner,
    AuthorizedOracle,
    AuthorizedController,
    ActiveFlightList,                // Vec<(Symbol, u64)>

    // Persistent — keyed multi-row state
    FlightData(Symbol, u64),         // FlightData
}

#[contracttype]
pub struct FlightData {
    pub status: FlightStatus,
    pub estimated_arrival_time: u64,   // 0 if not yet set
    pub actual_arrival_time: u64,      // 0 if not yet set
    pub settled_at: u64,               // 0 if not yet settled
}

#[contracttype]
#[derive(Clone, PartialEq)]
pub enum FlightStatus {
    NotInitiated,
    Active,
    Landed,
    Cancelled,
    ToBeSettledOnTime,
    ToBeSettledDelayed,
    ToBeSettledCancelled,
    Settled,
}

const SETTLED_RETENTION_DAYS: u64 = 30;
const SECONDS_PER_DAY: u64 = 86_400;
```

**Storage tier rationale:**

- **`ActiveFlightList`** is in **Instance** storage. It is global single-row state — per
  Soroban best practice, it shares TTL with the contract instance. The delayed-prune
  scheme bounds the list to (active flights) + (settled-but-not-yet-evicted flights), the
  latter capped by the 30-day retention window. List growth is bounded under realistic
  traffic.
- **`FlightData(Symbol, u64)`** is in **Persistent** storage (per-flight, unbounded
  entries — can't move to Instance). TTL is managed via `ExtendFootprintTTLOp` cron —
  the same cron that extends FlightPoolManager's `FlightConfig` entries iterates active
  flights and extends each `FlightData` entry.

**Key functions:**

```rust
// Oracle-only (FlightDataFetcher cron)
fn set_estimated_arrival(env: Env, oracle: Address,
                         flight_id: Symbol, date: u64,
                         estimated_arrival_time: u64);    // NotInitiated -> Active
fn set_landed(env: Env, oracle: Address,
              flight_id: Symbol, date: u64,
              actual_arrival_time: u64);                   // Active -> Landed
fn set_cancelled(env: Env, oracle: Address,
                 flight_id: Symbol, date: u64);            // Active -> Cancelled

// Controller-only
fn register_flight(env: Env, controller: Address,
                   flight_id: Symbol, date: u64);          // creates entry as NotInitiated
fn set_to_be_settled(env: Env, controller: Address,
                     flight_id: Symbol, date: u64,
                     status: FlightStatus);                // Landed/Cancelled -> ToBeSettled*
fn set_settled(env: Env, controller: Address,
               flight_id: Symbol, date: u64);              // ToBeSettled* -> Settled
                                                           // records settled_at;
                                                           // does NOT prune

// Permissionless housekeeping (callable by anyone — matches sweep_expired pattern)
fn prune_settled(env: Env);                                // evicts entries with
                                                           //   status == Settled
                                                           //   AND now - settled_at
                                                           //     >= SETTLED_RETENTION_DAYS

// Read functions
fn get_flight_data(env: Env, flight_id: Symbol, date: u64) -> FlightData;
fn get_active_flights(env: Env) -> Vec<(Symbol, u64)>;
fn get_flights_by_status(env: Env, status: FlightStatus) -> Vec<(Symbol, u64)>;
```

**Shared types.** `FlightStatus` and `FlightData` live in the workspace-wide
`sentinel_types` crate (audit I-05). The oracle's `storage.rs` re-exports them and
the controller imports them directly via its cross-contract client — single source
of truth, no byte-layout drift hazard between contracts. Same applies to
`FlightConfig` / `SettlementStatus` (pool) and `RouteStatus` / `ResolvedTerms`
(governance).

---

## Off-Chain Executor Layer (Modular)

The protocol needs three off-chain cron jobs to keep ticking. All three are
**backend-agnostic** — the contracts enforce authorization via `require_auth()` on
updatable addresses.

**Implementation status (Phase 12, 2026-05-25):** the centralized cron backend
lives at `executor/centralized_cron/`. Stack: TypeScript + Node + tsx +
`@stellar/stellar-sdk` v14 + `node-cron` + `express` + `dotenv`. Five cron
jobs (FlightDataFetcher, FlightClassifier, SettlementExecutor, QueueMaintainer,
TTLExtender), one HTTP API for health / logs / manual triggers, and a
single-shot CLI (`npm run {fetch,classify,settle,queue,ttl}`) for ops + tests.
Acurast TEE backend planned as a sibling under `executor/acurast/` in a
later phase — same core logic, different deployment manifest.

### Cron Job Summary

| Cron | Name | Frequency | On-chain target | Authorization |
|------|------|-----------|-----------------|---------------|
| #1 | **FlightDataFetcher** | Every 2 hours | `OracleAggregator` | `authorized_oracle` |
| #2 | **FlightClassifier** | Every 1 hour | `Controller.classify_flights()` | `authorized_keeper` |
| #3 | **SettlementExecutor** | Every 5 minutes | `Controller.execute_settlements()` | `authorized_keeper` |
| #3b | **QueueMaintainer** | Every 5 minutes | `Controller.run_queue_maintenance()` | `authorized_keeper` |

### Cron #1 — FlightDataFetcher (Oracle, every 2 hours)

Fetches flight data from AeroAPI and writes it to the OracleAggregator. This cron is the
only off-chain process that talks to external APIs.

```
FlightDataFetcher
    |
    +-> reads OracleAggregator.get_active_flights() via Stellar RPC
    |
    +-> Step A: For flights in NotInitiated status:
    |       calls AeroAPI for estimated arrival time
    |       signs + submits: OracleAggregator.set_estimated_arrival(flight_id, date, eta)
    |       (NotInitiated -> Active)
    |
    +-> Step B: For flights in Active status:
    |       reads estimated_arrival_time from OracleAggregator
    |       if estimated_arrival_time + 1 hour < now:
    |           calls AeroAPI for actual flight status
    |           |
    |           +- Landed -> signs + submits:
    |           |    OracleAggregator.set_landed(flight_id, date, actual_arrival_time)
    |           |    (Active -> Landed)
    |           |
    |           +- Cancelled -> signs + submits:
    |           |    OracleAggregator.set_cancelled(flight_id, date)
    |           |    (Active -> Cancelled)
    |           |
    |           +- Still in flight -> skip, retry next cycle
    |           +- HTTP error -> skip, retry next cycle
    |
    +-> flights whose estimated arrival hasn't passed yet: skip entirely
```

**Why 1 hour buffer?** The oracle only calls AeroAPI for flights that should have landed
at least 1 hour ago. This avoids unnecessary API calls for flights still in the air and
gives AeroAPI time to receive final landing data.

### Cron #2 — FlightClassifier (Keeper, every 1 hour)

Reads oracle data and FlightPoolManager terms to classify each flight's outcome. Does NOT move
money — only sets the `ToBeSettled*` status on OracleAggregator via the Controller.

```
FlightClassifier -> signs + submits Soroban tx:
    Controller.classify_flights(keeper_address)
        |
        +-> keeper.require_auth()  — only authorized_keeper passes
        |
        +-> reads OracleAggregator for flights in Landed or Cancelled status
                |
                +- Cancelled -> oracle.set_to_be_settled(flight_id, date, ToBeSettledCancelled)
                |
                +- Landed -> read pool_client.get_flight_config(flight_id, date).delay_hours
                            calculate: actual_arrival_time - estimated_arrival_time
                            |
                            +- delay >= delay_hours -> ToBeSettledDelayed
                            +- delay <  delay_hours -> ToBeSettledOnTime
                            |
                            +-> oracle.set_to_be_settled(flight_id, date, status)
```

**Why separate from settlement?** Classification is a read-heavy operation (reads oracle
data + FlightPoolManager terms). Settlement is a write-heavy operation (moves money). Separating
them allows the classification to run less frequently (1 hour) while settlement runs more
frequently (5 minutes) to process the queue quickly.

### Cron #3 — SettlementExecutor (Keeper, every 5 minutes)

Processes all flights that have been classified and executes the actual money movement.
The withdrawal queue + share-price snapshot used to live here too, but were split out
into Cron #3b (`run_queue_maintenance`) per audit M-03 so settlement gas pressure can
never block underwriter payouts.

```
SettlementExecutor -> signs + submits Soroban tx:
    Controller.execute_settlements(keeper_address)
        |
        +-> keeper.require_auth()  — only authorized_keeper passes
        |
        +-> reads OracleAggregator for flights in ToBeSettled* status
                |
                +- ToBeSettledOnTime
                |       pool_client.settle_on_time(flight_id, date)
                |           premiums -> vault.record_premium_income()
                |       vault.decrease_locked(payoff * buyer_count)
                |       oracle.set_settled(flight_id, date)
                |
                +- ToBeSettledDelayed
                |       payout_amount = (payoff - premium) * buyer_count
                |       vault.send_payout(flight_pool_manager, payout_amount)
                |       vault.decrease_locked(payoff * buyer_count)
                |       pool_client.settle_delayed(flight_id, date, claim_expiry_window)
                |       oracle.set_settled(flight_id, date)
                |       update total_payouts_distributed
                |
                +- ToBeSettledCancelled
                        payout_amount = (payoff - premium) * buyer_count
                        vault.send_payout(flight_pool_manager, payout_amount)
                        vault.decrease_locked(payoff * buyer_count)
                        pool_client.settle_cancelled(flight_id, date, claim_expiry_window)
                        oracle.set_settled(flight_id, date)
                        update total_payouts_distributed

        (NOTE: withdrawal queue + snapshot now live in Cron #3b —
         run_queue_maintenance — split per audit M-03.)
```

### Cron #3b — QueueMaintainer (Keeper, every 5 minutes)

```
QueueMaintainer -> signs + submits Soroban tx:
    Controller.run_queue_maintenance(keeper_address)
        |
        +-> keeper.require_auth()
        +-> vault.process_withdrawal_queue()   (FIFO — see Underwriter Withdrawals)
        +-> vault.snapshot()                   (no-op if already snapshotted today)
```

Same authorized_keeper as #3; separate keeper job (or the same one looping both)
because the two should not share resource budget.

### Cron #4 — TTL Extender (ExtendFootprintTTLOp, every 24 hours)

A permissionless cron that extends TTL on per-flight Persistent entries across both
FlightPoolManager and OracleAggregator. This is a raw Soroban `ExtendFootprintTTLOp`
operation — not an in-contract function call.

```
TTL Extender
    |
    +-> reads FlightPoolManager.get_active_flights() via Stellar RPC
    |       returns all (flight_id, date) tuples
    |
    +-> builds one ExtendFootprintTTLOp transaction covering:
    |       - Each PoolKey::FlightConfig(id, date) in FlightPoolManager
    |       - Each OracleKey::FlightData(id, date) in OracleAggregator
    |
    +-> submits the transaction
```

Also extends TTL on:
- `TravelerFlights(Address)` entries in Controller (for active travelers)

### Why three separate crons?

- **Separation of concerns.** Oracle writes raw data (Step A & B); classifier interprets
  it using on-chain business rules; settler moves money. Different failure modes, different
  retry semantics.
- **Different frequencies.** Oracle polls every 2 hours (AeroAPI rate limits + 1 hour
  landing buffer); classification every 1 hour (needs oracle data to be fresh); settlement
  every 5 minutes (process the queue as fast as possible).
- **Independent key rotation.** The oracle address and keeper address are updatable
  independently on their respective contracts.
- **Blast radius.** A broken oracle doesn't halt settlement of already-classified flights.
  A broken classifier doesn't prevent the oracle from writing data. A broken settler
  doesn't prevent classification from queueing up work.

### The Executor Interface

Every backend must implement three logical functions:

```
FlightDataFetcher:
  1. Read OracleAggregator.get_active_flights() via Stellar RPC
  2. For NotInitiated flights:
       - Call AeroAPI for estimated arrival time
       - Sign and submit: OracleAggregator.set_estimated_arrival(...)
  3. For Active flights where estimated_arrival + 1 hour < now:
       - Call AeroAPI for actual flight status
       - Landed -> sign and submit: OracleAggregator.set_landed(...)
       - Cancelled -> sign and submit: OracleAggregator.set_cancelled(...)
       - Still in flight / HTTP error -> skip, retry next cycle

FlightClassifier:
  1. Build Soroban tx: Controller.classify_flights(keeper_address)
  2. Sign with executor's Stellar keypair
  3. Submit via Stellar RPC

SettlementExecutor:
  1. Build Soroban tx: Controller.execute_settlements(keeper_address)
  2. Sign with executor's Stellar keypair
  3. Submit via Stellar RPC
```

All three jobs use `@stellar/stellar-sdk` to build, sign, and submit Soroban transactions.
The core logic is **shared TypeScript** — each backend wraps the same code in its own
scheduling and runtime harness.

### Executor project structure

```
executor/
├── src/
│   ├── core/                      # Shared logic — reused by ALL backends
│   │   ├── flight_data_fetcher.ts # AeroAPI fetch + oracle data writes
│   │   ├── flight_classifier.ts   # Classification tx builder
│   │   ├── settlement_executor.ts # Settlement tx builder
│   │   ├── ttl_extender.ts        # ExtendFootprintTTLOp for per-flight Persistent entries
│   │   ├── soroban_client.ts      # Stellar SDK wrapper (build, sign, submit)
│   │   ├── aeroapi_client.ts      # AeroAPI HTTP client
│   │   └── types.ts               # FlightStatus, FlightData, etc.
│   │
│   ├── backends/
│   │   ├── cron/                  # Centralized cron (current default)
│   │   │   ├── index.ts           # node-cron scheduler entry point (4 schedules)
│   │   │   ├── config.ts          # Loads .env, RPC URLs, keypairs
│   │   │   └── health.ts          # /health endpoint for monitoring
│   │   │
│   │   ├── acurast/               # Acurast TEE (future)
│   │   │   ├── fetcher/index.ts
│   │   │   ├── classifier/index.ts
│   │   │   └── settler/index.ts
│   │   │
│   │   └── phala/                 # Phala TEE (future)
│   │       ├── fetcher.ts
│   │       ├── classifier.ts
│   │       └── settler.ts
│   │
│   └── scripts/
│       ├── rotate_keys.ts         # Generate new keypair, call set_authorized_*
│       └── check_health.ts        # Verify jobs are running, balances are funded
│
├── .env.example
├── package.json
├── tsconfig.json
└── Dockerfile
```

The key insight: `core/` contains all the business logic. Each `backends/` entry is a thin
wrapper that provides scheduling and environment variable access for its specific runtime.
Adding a new backend means writing a new entry point that imports from `core/` — typically
under 20 lines of glue code.

### Backend migration

Migrating between executor backends is a **zero-downtime, no-redeployment operation**:

```
1. Deploy new executor backend
2. Read new executor's Stellar public key(s)
3. Fund new executor account(s) with XLM
4. Start new executor jobs (both old and new running — only old is authorized)
5. Execute migration transactions:
     owner -> OracleAggregator.set_oracle(new_oracle_address)
     owner -> Controller.set_keeper(new_keeper_address)
6. Verify new executor's txs are succeeding on-chain
7. Shut down old executor backend
```

During the dual-running window, both backends submit transactions, but only the authorized
one succeeds. Unauthorized transactions simply fail auth checks — no side effects, no
double execution. Rollback = set addresses back to old backend.

---

## Data Flow

> For visual, editable Mermaid sequence diagrams of these flows (deployment,
> purchase, underwriter, settlement, claim), see
> [sequence_diagrams.md](../sequence_diagrams.md).

### Whitelisting a Route

```
Owner or Admin -> GovernanceModule.whitelist_route(flight_id, origin, dest,
                                                  premium?, payoff?, delay_hours?)
    +-> route stored in Persistent storage, keyed Route(flight_id, origin, dest)
        if custom terms provided -> stored per-route
        if not -> will fall back to global defaults when queried via route_status()
        Route TTL extended (60-day window) on this write
        emits route.listed event -> off-chain indexer materializes the row
        NO flight entry created yet — lazy creation on first purchase
```

### Buying Insurance

```
Traveler -> Controller.buy_insurance(flight_id, origin, dest, date)
                |
                +-> traveler.require_auth()
                +-> GovernanceModule.route_status(flight_id, origin, dest)
                |       match { Active(terms) => use terms (premium, payoff, delay_hours)
                |               Disabled      => revert "route is disabled"
                |               Unknown       => revert "route not whitelisted" }
                +-> enforce minimum_lead_time                     revert if departure too soon
                |
                +-> flight exists in FlightPoolManager for (flight_id, date)?
                |       +- YES -> skip registration
                |       +- NO  -> FlightPoolManager.register_flight(
                |                   flight_id, date, premium, payoff, delay_hours)
                |                 OracleAggregator.register_flight(flight_id, date)
                |                 -> flight enters NotInitiated status
                |
                +-> solvency check                               revert if undercollateralised
                +-> usdc_client.transfer(traveler, flight_pool_manager, premium)  <- premium locked
                +-> vault_client.increase_locked(controller, payoff)
                +-> pool_client.add_buyer(controller, flight_id, date, traveler)
                +-> append (flight_id, date) to TravelerFlights(traveler)
                +-> update counters
```

**Soroban auth note:** The traveler's `require_auth()` in the Controller propagates to the
`usdc_client.transfer()` call — Soroban's auth framework handles sub-invocation authorization
automatically. The traveler signs one transaction that authorizes both the Controller call
and the USDC transfer within it.

### Flight Data Collection (FlightDataFetcher, every 2 hours)

```
FlightDataFetcher (off-chain)
    |
    +-> reads OracleAggregator.get_active_flights() via Stellar RPC
    |
    +-> for each flight in NotInitiated status:
    |       calls AeroAPI -> gets estimated arrival time
    |       signs + submits:
    |       OracleAggregator.set_estimated_arrival(flight_id, date, eta)
    |           +-> NotInitiated -> Active
    |
    +-> for each flight in Active status
        where estimated_arrival_time + 1 hour < now:
            calls AeroAPI -> gets actual flight status
            |
            +- Landed -> signs + submits:
            |    OracleAggregator.set_landed(flight_id, date, actual_arrival_time)
            |        +-> Active -> Landed
            |
            +- Cancelled -> signs + submits:
            |    OracleAggregator.set_cancelled(flight_id, date)
            |        +-> Active -> Cancelled
            |
            +- Still in flight / HTTP error -> skip, retry next cycle
```

### Flight Classification (FlightClassifier via Controller, every 1 hour)

```
FlightClassifier (off-chain) -> signs + submits:
    Controller.classify_flights(keeper_address)
        |
        +-> keeper.require_auth()
        |
        +-> for each flight in OracleAggregator with Landed or Cancelled status:
                |
                +- Cancelled
                |       oracle.set_to_be_settled(flight_id, date, ToBeSettledCancelled)
                |
                +- Landed
                        read pool_client.get_flight_config(flight_id, date).delay_hours
                        read oracle.get_flight_data() -> estimated_arrival, actual_arrival
                        delay = actual_arrival - estimated_arrival
                        |
                        +- delay >= delay_hours
                        |       oracle.set_to_be_settled(flight_id, date, ToBeSettledDelayed)
                        |
                        +- delay < delay_hours
                                oracle.set_to_be_settled(flight_id, date, ToBeSettledOnTime)
```

### Settlement Execution (SettlementExecutor via Controller, every 5 minutes)

```
SettlementExecutor (off-chain) -> signs + submits:
    Controller.execute_settlements(keeper_address)
        |
        +-> keeper.require_auth()
        |
        +-> for each flight in OracleAggregator with ToBeSettled* status:
                |
                +- ToBeSettledOnTime
                |       pool_client.settle_on_time(flight_id, date)
                |           premiums (premium * buyer_count) -> vault.record_premium_income()
                |       vault.decrease_locked(payoff * buyer_count)
                |       oracle.set_settled(flight_id, date)
                |
                +- ToBeSettledDelayed
                |       payout = (payoff - premium) * buyer_count
                |       vault.send_payout(flight_pool_manager, payout)
                |       vault.decrease_locked(payoff * buyer_count)
                |       pool_client.settle_delayed(flight_id, date, claim_expiry_window)
                |       oracle.set_settled(flight_id, date)
                |       update total_payouts_distributed
                |
                +- ToBeSettledCancelled
                        (same flow as ToBeSettledDelayed — same payout amount)

(Cron #3b — Controller.run_queue_maintenance — runs separately:)
        +-> vault.process_withdrawal_queue()   (FIFO — unlocks underwriter funds)
        +-> vault.snapshot()                   (no-op if already snapshotted today)
```

### Traveler Claiming a Payout

```
Traveler -> FlightPoolManager.claim(traveler, flight_id, date)
    +-> traveler.require_auth()
    +-> panic if flight not settled as delayed or cancelled
    +-> panic if caller has no policy for (flight_id, date)
    +-> panic if caller already claimed for (flight_id, date)
    +-> panic if env.ledger().timestamp() > claim_expiry
    +-> set Claimed(flight_id, date, traveler) = true
    +-> usdc_client.transfer(contract_address, traveler, payoff)
```

### Sweeping Expired Claims

```
Anyone -> FlightPoolManager.sweep_expired(flight_id, date)
    +-> panic if env.ledger().timestamp() <= claim_expiry
    +-> calculate remaining unclaimed USDC for this flight
    +-> credit RecoveredBalance += remainder (Instance storage, internal)
    +-> emit event with flight_id, date, amount swept
```

### Owner Withdrawing Recovered Funds

```
Owner -> FlightPoolManager.withdraw_recovered(amount)
    +-> #[only_owner] guard (OZ ownable check)
    +-> panic if amount <= 0 or amount > RecoveredBalance
    +-> RecoveredBalance -= amount
    +-> usdc_client.transfer(contract_address, ownable::get_owner(), amount)
    +-> emit RecoveredWithdrawn { owner, amount }
```

### Underwriter Withdrawing Capital (FIFO)

```
-- Immediate path (OZ Vault) --

Underwriter -> RiskVault.redeem(shares, receiver, owner, operator)
    +-> operator.require_auth()
    +-> max_redeem check: panic if shares > free_capital equivalent
    +-> burn shares, decrease total_managed_assets
    +-> usdc_client.transfer(vault, receiver, assets)

-- Queued path (FIFO — used when free_capital < redemption) --

Underwriter -> RiskVault.request_withdrawal(caller, shares) -> request_id
    +-> caller.require_auth()
    +-> panic if shares == 0 or shares > balance
    +-> underwriter specifies how much they want to withdraw
    +-> request queued as (request_id, caller, shares, timestamp) in FIFO list (Instance storage)
    +-> shares reserved
    +-> returns request_id (monotonic counter) — use to cancel later, audit M-04

                (queue drains after each settlement via process_withdrawal_queue)
                    +-> walks FIFO list in order
                    +-> for each request: if solvency allows, amount is "unlocked"
                    +-> ClaimableBalance(caller) += redemption amount
                    +-> TTL extended to 60 days on ClaimableBalance write

Underwriter -> RiskVault.collect(caller)
    +-> caller.require_auth()
    +-> amount = ClaimableBalance(caller)
    +-> panic if zero
    +-> ClaimableBalance(caller) = 0
    +-> total_managed_assets -= amount
    +-> usdc_client.transfer(vault, caller, amount)
```

**FIFO withdrawal semantics:** Underwriters are in a list. When flights are settled and
capital is freed, the queue processor walks the list in order. If the vault's solvency
allows it, the requested amount is unlocked for that underwriter. The underwriter then
calls `collect()` to pull the USDC. Requests that cannot be fulfilled yet remain in the
queue for the next settlement cycle.

---

## Solvency Invariant

**Never sell insurance unless we have money to cover it.** Before every insurance purchase:

```
vault.free_capital() >= (total_max_liability + new_payoff) * minimum_solvency_ratio / 100
```

- `free_capital()` = `total_managed_assets` - `locked_capital`
- `locked_capital` increases by `payoff` on each purchase; decreases by `payoff * buyer_count`
  on settlement
- `minimum_solvency_ratio` defaults to 100 — fully collateralised
- Underwriter withdrawals that would breach `locked_capital` are queued, not rejected
- Queue processor re-checks solvency at fulfillment time

---

## Contract Relationships

```
         Owner / Admins
               |
               v
      GovernanceModule --- default terms + per-route overrides
               |  resolved terms (cross-contract client)
               v
          Controller  <---- Cron #2: FlightClassifier (authorized_keeper, every 1 hr)
          |    |    |  <---- Cron #3: SettlementExecutor (authorized_keeper, every 5 min)
    +-----+    |    +------------+
    v          v                 v
RiskVault  FlightPoolManager   OracleAggregator
(OZ Vault)                          ^
                             Cron #1: FlightDataFetcher (authorized_oracle, every 2 hr)
                                     |
                              +------+--------+
                              | Executor Backend|
                              |  (swappable)    |
                              +----------------+

Underwriters --deposit--> RiskVault
                               +-- collect() <-- Underwriters (FIFO queue)

Travelers --buy_insurance--> Controller --> FlightPoolManager
                                               +-- claim(flight_id, date) <-- Travelers (after settlement)
                                               +-- sweep_expired(flight_id, date) --> RecoveredBalance (internal)
```

---

## Access Control

| Guard | Contract | Mechanism |
|---|---|---|
| Owner-only | GovernanceModule | `owner.require_auth()` + stored owner check |
| Owner or Admin | GovernanceModule | `caller.require_auth()` + admin map lookup |
| Owner-only | Controller | `owner.require_auth()` for config updates |
| Authorized keeper | Controller | `keeper.require_auth()` + stored `authorized_keeper` check |
| Controller-only | RiskVault | `controller.require_auth()` + stored controller check |
| Controller-only | FlightPoolManager | `controller.require_auth()` + stored controller check (for mutations) |
| Public | FlightPoolManager | `traveler.require_auth()` for `claim()`; no auth for `sweep_expired()` read functions |
| Owner-only | FlightPoolManager | `owner.require_auth()` for `withdraw_recovered()` |
| Authorized oracle | OracleAggregator | `oracle.require_auth()` + stored `authorized_oracle` check |
| Controller-only | OracleAggregator | `controller.require_auth()` + stored controller (set once) |

**`authorized_keeper` on Controller:** The executor backend's Stellar keypair is registered
on-chain. `require_auth()` verifies the executor signed the transaction. No unauthorized
address can trigger classification or settlement. The address is **owner-updatable** to
allow zero-downtime migration between executor backends. Both `classify_flights()` and
`execute_settlements()` use the same authorized keeper address.

**`authorized_oracle` is owner-updatable** to allow migration between executor backends
without redeploying OracleAggregator.

**`authorized_controller` is immutable** — set once via `set_controller()`, panics on second call.

**Controller never holds user funds.** USDC flows traveler -> FlightPoolManager via the token
`transfer()` call authorized by the traveler's signature.

---

## Security

### Reentrancy

Soroban's execution model provides **built-in reentrancy protection**. Contract calls are
executed in isolated frames — a contract cannot be re-entered during its own execution.
This eliminates the entire class of reentrancy attacks. Nevertheless, every USDC-transferring
function follows checks-effects-interactions order (state mutations before the external
`usdc.transfer`) as a defense-in-depth measure — `collect`, `send_payout`,
`recover_uncollected(Transfer)`, `withdraw_recovered`, and `process_withdrawal_queue` all
write state first (audit H-05 fix).

### Emergency Stop (Pausable)

All five production contracts implement OZ Pausable (audit H-03). The owner of each
contract can call `pause(caller)` to halt every state-mutating entry point on that
contract atomically; `unpause(caller)` resumes. State reads and permissionless
housekeeping (`extend_ttl`, `prune_settled`) remain available while paused so the
operator can keep observability and TTL hygiene running during incident response.
`recover_uncollected` on the vault is intentionally exempt so the owner can still
settle archived claims during a pause.

### Share Price Manipulation (RiskVault)

The OZ Vault's virtual decimals offset (`10^3` virtual shares) combined with the overridden
`total_assets()` returning an internal counter (not raw balance) provides two layers of
defense against inflation attacks:
1. Direct USDC transfers to the vault address do not affect share price calculations.
2. The virtual offset ensures the denominator is always large enough that rounding cannot
   steal depositor shares.

### Oracle Trust Model

1. Only `authorized_oracle` can write flight data to OracleAggregator.
2. Status is forward-only — cannot regress through the state machine.
3. Data updates for unregistered flights are rejected.
4. `get_flight_data()` never panics — returns `NotInitiated` as safe fallback.
5. Oracle is decoupled from settlement — can only write data, not trigger payouts or
   classify outcomes. Classification is done by the Controller using on-chain business rules.
6. **`set_landed` plausibility floor** (audit L-02): asserts
   `actual_arrival_time >= estimated_arrival_time`. An adversarial oracle cannot mark a
   delayed flight as on-time via an actual-before-estimated report.

**Trust assumption depends on executor backend.** With a centralized cron, trust the
server operator. With a TEE backend (Acurast, Phala), trust the hardware attestation chain.
The architecture is designed so that the trust model **improves over time** without touching
the contracts — only the authorized address changes.

### Soroban Storage Rent & Archival

All contracts must manage TTL (time-to-live) to prevent data archival:

- **Instance storage** (contract config, global state): TTL extended via existing cron
  `extend_ttl()` calls. Routes, ActiveFlightList, WithdrawalQueue, and other global state
  are in Instance storage — they share TTL with the contract instance.
- **Persistent storage** (per-flight data, per-user data): TTL extended via
  `ExtendFootprintTTLOp` cron for active flight entries (FlightConfig, FlightData). Per-user
  entries (Buyer, Claimed, ClaimableBalance) get TTL set on write proportional to claim window.
  TravelerFlights entries are extended by the TTL cron for active travelers.
- **Temporary storage** (SnapshotPrice): Used for disposable data with natural timeout.
  Permanent deletion after TTL — no archival rent.

The `ExtendFootprintTTLOp` cron (Cron #4) iterates active flights and extends per-flight
Persistent entries in both FlightPoolManager and OracleAggregator in a single transaction.

**`RestoreFootprintOp` safety net:** Instance and Persistent entries are never permanently
deleted — they are archived and can be restored via `RestoreFootprintOp`. Only Temporary
storage is truly permanent deletion. This means most TTL-related issues are "temporarily
inaccessible until restored" rather than "permanently lost."

### Known Limitations

- **Oracle manipulation** — single authorized executor; trust model depends on backend.
  Multi-oracle aggregation is a future enhancement.
- **Front-running** — Stellar's transaction ordering is validator-determined. A mempool
  watcher could theoretically front-run `buy_insurance`, but this is a legitimate purchase.
- **Correlated event risk** — simultaneous delays across many flights are protected only
  by `minimum_solvency_ratio`. At 100% the vault covers all; underwriters bear correlated risk.
- **No per-underwriter capital attribution** — `locked_capital` is pool-level.
- **Classification lag** — up to 1 hour between oracle data write and classification.
  Settlement lag is at most 5 minutes after classification.
- **Executor availability** — depends on backend choice and its uptime guarantees.
- **Storage rent** — if TTL management fails and data archives, a restore transaction is
  needed. The TTL cron is the primary extender; if it stops, manual `RestoreFootprintOp`
  intervention is required.
- **Single FlightPoolManager** — all flight USDC in one contract. A bug affects all flights.
  Tradeoff accepted for eliminating per-pool TTL bugs and simplifying the system.

---

## User Flows

### Traveler

**Buy insurance:**
1. Check `GovernanceModule.route_status(flight_id, origin, dest)` via frontend; match the
   returned `RouteStatus` enum:
   - `Active(ResolvedTerms)` — route is buyable; use `terms.payoff` for the solvency precheck.
   - `Disabled` or `Unknown` — show an error; do not let the user submit.
2. Solvency precheck: read `RiskVault.get_free_capital()` and compare against the
   `payoff` from step 1 (multiplied by `Controller.get_solvency_ratio() / 100`). The
   on-chain solvency gate enforces the same check on submit, so this is a UX optimisation
   to avoid wasted signatures.
3. Sign transaction that calls `Controller.buy_insurance(flight_id, origin, dest, date)`.
   Soroban auth framework handles USDC transfer authorization within the same signature.

**Claim payout (if delayed or cancelled):**
After settlement, call `FlightPoolManager.claim(traveler_address, flight_id, date)`. Must claim before expiry.

**If on time:** No action needed. Premium becomes underwriter yield.

**View my policies:**
Frontend calls `Controller.get_flights_for_traveler(address)` to show only the connected
user's policies — not all flights across the protocol.

### Underwriter

**Deposit:** Sign transaction calling `RiskVault.deposit(assets, receiver, from, operator)`.
Shares issued proportional to `total_managed_assets / total_supply`.

**Withdraw (immediate):** `RiskVault.redeem(shares, receiver, owner, operator)` — executes
when `free_capital >= redemption`.

**Withdraw (queued FIFO):** `RiskVault.request_withdrawal(caller, shares)` — enqueues when
capital is locked. Specify desired withdrawal amount. Queue drains FIFO after each
settlement — if solvency allows, the amount is unlocked. Call `RiskVault.collect(caller)`
to pull USDC.

**Cancel queued request:** `RiskVault.cancel_withdrawal(caller, request_id)` — uses the
stable id returned from `request_withdrawal`, NOT the current queue index (audit M-04).

### Function Reference

| Action | Who | Function |
|---|---|---|
| Set global defaults | Owner | `governance.set_defaults(premium, payoff, delay_hours)` |
| Whitelist route | Owner / Admin | `governance.whitelist_route(caller, flight_id, origin, dest, premium?, payoff?, delay_hours?)` |
| Disable route (soft) | Owner / Admin | `governance.disable_route(caller, flight_id, origin, dest)` |
| Enable route | Owner / Admin | `governance.enable_route(caller, flight_id, origin, dest)` |
| Remove route (hard, must be disabled first) | Owner / Admin | `governance.remove_route(caller, flight_id, origin, dest)` |
| Update route terms (partial) | Owner / Admin | `governance.update_route_terms(caller, flight_id, origin, dest, premium_op, payoff_op, delay_op)` |
| Add admin | Owner | `governance.add_admin(admin)` |
| Remove admin | Owner | `governance.remove_admin(admin)` |
| Read route status | Anyone | `governance.route_status(flight_id, origin, dest) -> RouteStatus` |
| Deposit capital | Underwriter | `risk_vault.deposit(assets, receiver, from, operator)` |
| Withdraw immediately | Underwriter | `risk_vault.redeem(shares, receiver, owner, operator)` |
| Withdraw (queued) | Underwriter | `risk_vault.request_withdrawal(caller, shares) -> request_id` |
| Collect credited USDC | Underwriter | `risk_vault.collect(caller)` |
| Cancel queued withdrawal | Underwriter | `risk_vault.cancel_withdrawal(caller, request_id)` |
| Recover uncollected balance | Owner | `risk_vault.recover_uncollected(user, amount, mode: RecoveryMode)` (Recredit must not underpay; Transfer requires prior credit) |
| Pause / unpause | Owner | `<contract>.pause(caller)` / `unpause(caller)` (every production contract) |
| Read free capital | Anyone | `risk_vault.get_free_capital()` |
| Buy insurance | Traveler | `controller.buy_insurance(flight_id, origin, dest, date)` |
| View my policies | Traveler | `controller.get_flights_for_traveler(address)` |
| Claim payout | Traveler | `flight_pool_manager.claim(traveler, flight_id, date)` |
| Sweep expired claims | Anyone | `flight_pool_manager.sweep_expired(flight_id, date)` |
| Withdraw recovered (swept) | Owner | `flight_pool_manager.withdraw_recovered(amount)` |
| Push estimated arrival | Oracle | `oracle.set_estimated_arrival(oracle, flight_id, date, eta)` |
| Push landed (with actual arrival) | Oracle | `oracle.set_landed(oracle, flight_id, date, actual)` |
| Mark cancelled | Oracle | `oracle.set_cancelled(oracle, flight_id, date)` |
| Classify flights | Keeper | `controller.classify_flights(keeper)` |
| Execute settlements | Keeper | `controller.execute_settlements(keeper)` |
| Drain withdrawal queue + snapshot | Keeper | `controller.run_queue_maintenance(keeper)` |
| Prune aged-out settled flights | Anyone | `oracle.prune_settled()` |
| Update keeper address | Owner | `controller.set_keeper(new_keeper)` |
| Update oracle address | Owner | `oracle.set_oracle(new_oracle)` |

---

## dApp Frontend — Scaffold Stellar

The frontend is built using **Scaffold Stellar**, providing:

### Project Structure

```
sentinel_soroban_phase_3/
├── contracts/                      # Soroban smart contracts (Rust)
│   ├── sentinel_types/             # Shared cross-contract types + TTL consts + test_support
│   │   ├── Cargo.toml
│   │   └── src/{lib,test_support}.rs
│   ├── governance_module/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   ├── risk_vault/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   ├── flight_pool_manager/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   ├── controller/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   ├── oracle_aggregator/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── integration_tests/          # Cross-contract test suite
├── packages/                       # Auto-generated TypeScript clients
│   ├── governance_module/
│   ├── risk_vault/
│   ├── flight_pool_manager/
│   ├── controller/
│   └── oracle_aggregator/
├── frontend/                       # React + Vite dApp
│   ├── src/
│   │   ├── components/
│   │   │   ├── TravelerDashboard.tsx
│   │   │   ├── UnderwriterDashboard.tsx
│   │   │   ├── AdminPanel.tsx
│   │   │   ├── RouteManager.tsx
│   │   │   ├── PoolStatus.tsx
│   │   │   └── VaultMetrics.tsx
│   │   ├── hooks/
│   │   │   ├── useController.ts
│   │   │   ├── useRiskVault.ts
│   │   │   ├── useGovernance.ts
│   │   │   └── useMyPolicies.ts
│   │   └── App.tsx
│   └── package.json
├── executor/                       # Off-chain executor (modular backend)
│   ├── src/
│   │   ├── core/                   # Shared logic — ALL backends use this
│   │   │   ├── flight_data_fetcher.ts
│   │   │   ├── flight_classifier.ts
│   │   │   ├── settlement_executor.ts
│   │   │   ├── ttl_extender.ts
│   │   │   ├── soroban_client.ts
│   │   │   ├── aeroapi_client.ts
│   │   │   └── types.ts
│   │   ├── backends/
│   │   │   ├── cron/               # Centralized cron (current default)
│   │   │   ├── acurast/            # Acurast TEE (future)
│   │   │   └── phala/              # Phala TEE (future)
│   │   └── scripts/
│   │       ├── rotate_keys.ts
│   │       └── check_health.ts
│   ├── .env.example
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── environments.toml               # Scaffold Stellar multi-env config
├── Cargo.toml                      # Workspace root
└── spec/
    ├── architecture.md
    ├── improvements.md
    └── changes.md
```

### Auto-Generated TypeScript Bindings

Scaffold Stellar generates typed clients for each contract:

```typescript
import { ControllerClient } from '../packages/controller';
import { RiskVaultClient } from '../packages/risk_vault';
import { FlightPoolManagerClient } from '../packages/flight_pool_manager';

// Buy insurance — single wallet signature covers Controller call + USDC transfer
const tx = await controllerClient.buy_insurance({
  flight_id: 'AA123',
  origin: 'DEN',
  dest: 'SEA',
  date: 1710000000n,
});
await tx.signAndSend();

// View my policies
const myFlights = await controllerClient.get_flights_for_traveler({
  address: walletAddress,
});

// Claim payout
const claimTx = await flightPoolManagerClient.claim({
  traveler: walletAddress,
  flight_id: 'AA123',
  date: 1710000000n,
});
await claimTx.signAndSend();
```

### Multi-Environment Configuration

`environments.toml` manages testnet / mainnet:

```toml
[development]
network = "testnet"
rpc_url = "https://soroban-testnet.stellar.org"
network_passphrase = "Test SDF Network ; September 2015"

[production]
network = "mainnet"
rpc_url = "https://soroban-rpc.mainnet.stellar.gateway.fm"
network_passphrase = "Public Global Stellar Network ; September 2015"
```

---

## Deployment Order

```
1. Build all contracts:
        stellar contract build          (compiles Rust -> WASM in target/)

2. Deploy contracts to Stellar (testnet or mainnet):

   a. GovernanceModule           — no dependencies
        stellar contract deploy --wasm target/.../governance_module.wasm
        -> returns CONTRACT_ID_GOVERNANCE

   b. OracleAggregator           — no dependencies at deploy time
        stellar contract deploy --wasm target/.../oracle_aggregator.wasm
        -> returns CONTRACT_ID_ORACLE

   c. FlightPoolManager          — no dependencies at deploy time
        stellar contract deploy --wasm target/.../flight_pool_manager.wasm
        -> returns CONTRACT_ID_FLIGHT_POOL_MANAGER

   d. RiskVault                  — constructor needs: USDC token address
        stellar contract deploy --wasm target/.../risk_vault.wasm \
          -- --asset <USDC_CONTRACT_ID> --offset 3
        -> returns CONTRACT_ID_VAULT

   e. Controller                 — constructor needs all addresses + config
        stellar contract deploy --wasm target/.../controller.wasm \
          -- --governance CONTRACT_ID_GOVERNANCE \
             --vault CONTRACT_ID_VAULT \
             --oracle CONTRACT_ID_ORACLE \
             --flight_pool_manager CONTRACT_ID_FLIGHT_POOL_MANAGER \
             --usdc USDC_CONTRACT_ID \
             --solvency_ratio 100 \
             --min_lead_time_secs 3600 \
             --claim_expiry_window_secs 5184000
        -> returns CONTRACT_ID_CONTROLLER

3. Post-deployment wiring:
        OracleAggregator.set_controller(CONTRACT_ID_CONTROLLER)   <- one-time, immutable
        RiskVault.set_controller(CONTRACT_ID_CONTROLLER)           <- one-time, immutable
        FlightPoolManager.set_controller(CONTRACT_ID_CONTROLLER)   <- one-time, immutable

4. Set global defaults:
        GovernanceModule.set_defaults(premium, payoff, delay_hours)

5. Whitelist initial routes:
        GovernanceModule.whitelist_route(...)                      <- one per route
        (custom terms optional — omit to use defaults)

6. Deploy executor backend:

   a. Generate Stellar keypairs for oracle and keeper:
        stellar keys generate oracle-executor
        stellar keys generate keeper-executor

   b. Configure and start executor (e.g. centralized cron):
        cd executor && cp .env.example .env
        # Set: AERO_API_KEY, STELLAR_RPC_URL, SECRET_KEYS, contract IDs
        npm run start:cron

7. Register executor addresses on-chain:
        OracleAggregator.set_oracle(ORACLE_EXECUTOR_ADDRESS)
        Controller.set_keeper(KEEPER_EXECUTOR_ADDRESS)

8. Fund executor accounts:
        Send XLM to ORACLE_EXECUTOR_ADDRESS (for Soroban tx fees)
        Send XLM to KEEPER_EXECUTOR_ADDRESS (for Soroban tx fees)

9. Generate frontend bindings:
        stellar scaffold build       (auto-generates TypeScript clients)
        npm start                    (launches React + Vite dev server)
```

**RiskVault / Controller circular dependency:** Deploy RiskVault first, deploy Controller
with vault address, then call `vault.set_controller()`.

**FlightPoolManager / Controller circular dependency:** Same pattern — deploy FlightPoolManager
first, deploy Controller with its address, then call `flight_pool_manager.set_controller()`.
