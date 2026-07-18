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
  - [Cron #4 — TTL Extender (instance `extend_ttl` + prune, every 24 hours)](#cron-4--ttl-extender-instance-extend_ttl--prune-every-24-hours)
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
| #3b | **QueueMaintainer** | Every 5 minutes | Prices matured LP deposit + withdrawal requests + share-price snapshot (split out from #3 per audit M-03 so settlement gas pressure can't block underwriter entries/exits) |

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
- **Term limits**: the owner bounds the magnitudes admin route writes may carry via
  `set_term_limits(max_payoff, max_payoff_ratio)`. The ratio cap (`payoff ≤ ratio ×
  premium`) is unit-free and active by default (100); the absolute per-policy payoff
  cap is asset-denominated and configured at wiring time (0 = disabled). This caps the
  blast radius of one compromised admin key — without it, a single signature could
  whitelist a dust-premium route whose one policy locks the vault's entire free
  capital. Both limits are enforced on every route write and on `set_defaults`, and
  `route_status` stops advertising a route that exceeds the current limits.
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
    FlightRoute(Symbol),                            // (origin, dest) uniqueness index — Persistent
    RetiredFlight(Symbol),                          // (origin, dest, retired_until) — Persistent
    MaxPayoff,                                      // i128 — Instance (0 = no absolute cap)
    MaxPayoffRatio,                                 // i128 — Instance (payoff ≤ premium × ratio)
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
fn get_term_limits(env: Env) -> (i128, i128);
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

// Term limits (owner-only)
fn set_term_limits(env: Env, max_payoff: i128, max_payoff_ratio: i128);

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
("sentinel", "gov_term_limits") → (max_payoff, max_payoff_ratio)
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
TTL on every `Route(...)` write maintains a 120-day window for actively edited routes; a
route idle past that window archives but stays restorable via `RestoreFootprintOp`. Folding
idle `Route(...)` keys into a key-level `ExtendFootprintTTLOp` executor job (using the
indexer's enumeration) is planned future work.

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
  `free_capital = total_managed_assets - locked_capital` is the nominal margin; every
  exit path is capped at the **withdrawable capital**
  `max(total_managed_assets - ceil(locked_capital * solvency_ratio / 100), 0)`, so LP
  exits preserve the same reserve the controller admits policies against (with the
  default 100% ratio the two figures coincide). The ratio is mirrored into the vault by
  `controller.set_solvency_ratio` (controller-only vault setter, atomic with the owner
  update); the vault cannot read it back on demand because the controller invokes
  `process_withdrawal_queue` and a read-back during that call would be reentrant.
  `max_withdraw` and `max_redeem` are overridden to cap redemptions at the withdrawable
  amount.
- **All LP entry and exit is two-phase (request → delayed pricing).** The immediate
  `deposit`/`mint`/`withdraw`/`redeem` operations are permanently disabled (they revert;
  the `max_*` views report zero): any call-time price can be stale with respect to a
  flight outcome that is publicly knowable but not yet written on-chain — the settlement
  barrier only engages once the oracle transaction lands. Instead, LPs commit value up
  front and are priced by queue processing only once their request outlives
  `LP_PRICING_DELAY_SECS` (6 h, sized above the oracle pipeline's worst-case
  observation-to-write latency with a missed-cycle margin). By pricing time, every
  outcome knowable at commitment is on-chain: settled (in the price) or pending (the
  barrier holds the request queued until settlement). Request cancellation carries no
  optionality — a queued request always prices post-outcome, so backing out never dodges
  a loss or captures a gain that belongs to others. `preview_*` remain as current-price
  estimates for request sizing.
  - **Entry (`request_deposit`)** — transfers the USDC into the vault immediately
    (escrowed — deliberately NOT counted in `total_managed_assets` and backing no shares
    yet), enqueues `(request_id, owner, assets, requested_at)` in the FIFO
    `DepositQueue`, and returns the stable `request_id`. `process_deposit_queue`
    (controller-only, driven by `run_queue_maintenance`) mints matured requests at the
    then-current share price; a request whose assets no longer buy one share (price rose
    sharply since it was queued) is returned and closed out via `DepositDropped`.
    `cancel_deposit(caller, request_id)` returns the escrow. Bounded: 100 entries
    (`DepositQueueFull`), 20 per address, same anti-dust floor as the exit queue.
  - **Exit (`request_withdrawal`)** — enqueues `(request_id, caller, shares,
    requested_at)` in a FIFO queue stored in **Instance** storage. Returns the
    freshly-issued `request_id: u64` (monotonic counter, audit M-04 fix; the counter is
    shared with the deposit queue). After each settlement cycle the keeper calls
    `run_queue_maintenance()`, which drives `process_deposit_queue()` then
    `process_withdrawal_queue()` (deposits first — fresh entries add capital that can
    fund matured exits in the same pass) and credits fulfilled requests to
    `claimable_balance`. Underwriters call `collect()` to pull USDC.
  - **Maturity stop.** Both queues are chronological, so the first request younger than
    the pricing delay defers itself and everything behind it — exactly like the capacity
    stop. A partial-fill remainder keeps its original `requested_at`: maturity, once
    reached, is never re-earned.
  - **Head partial fill.** When the oldest matured request prices above the current
    withdrawable capital, `process_withdrawal_queue` funds the share slice that amount
    covers (burn + credit), keeps the remainder at the head, and defers everything
    behind it. Strict FIFO fairness holds — withdrawable capital always goes to the
    oldest request first — but one oversized request can no longer pin the queue while
    payable capital sits idle. Each partial pass emits `Credited` plus
    `RequestPartiallyFilled(request_id, shares_filled, shares_remaining)`.
  - **Zero-value drop.** A request whose asset value has decayed to zero (share price fell
    after it was queued) is not left blocking the head: its escrowed shares are returned to
    the owner, `RequestDropped` is emitted (no `Credited` fires), and the scan continues.
  - **Queued exits hold no reservation against new underwriting (deliberate).** Purchases
    and queue processing are unsynchronized consumers of the same withdrawable capital:
    capital freed by a settlement can be re-locked by new policies before the keeper's next
    queue-maintenance pass, and nothing entitles the queue head to capital that was
    withdrawable at an earlier instant. Queued requests keep strict FIFO priority *among
    themselves* (and block direct exits), but sustained purchase demand can defer exits —
    a liquidity characteristic of the design, not a solvency issue (escrowed shares retain
    full value). Operator levers: the solvency ratio above 100% structurally reserves a
    margin purchases cannot lock, and the `wd_req` events carry queue occupancy for
    monitoring queue back-pressure. If product requirements ever demand that queued exits
    reserve future liquidity ahead of new underwriting, that rule must be specified and
    implemented explicitly (e.g. tightening the purchase solvency check by the queue's
    outstanding asset value).
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
  `decrease_locked`, `send_payout`, `process_deposit_queue`, `process_withdrawal_queue`,
  `record_premium_income`.
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
    DepositQueue,              // Vec<DepositRequest> — Instance (escrowed LP entries)
    NextRequestId,             // u64 — Instance (monotonic counter, shared by both queues)
    LastSnapshotTime,          // u64 — Instance
    Oracle,                    // Address — Instance (settlement-barrier target, wired at construction, owner-rotatable)
    MinWithdrawalRequest,      // i128 — Instance (anti-dust floor for both queues' entries, 0 disables)
    SolvencyRatio,             // u32 — Instance (controller-mirrored reserve ratio, absent = 100)
    ClaimableBalance(Address), // i128 — Persistent (TTL extended to 60 days on write)
    SnapshotPrice(u64),        // i128 — Temporary (30-day TTL, keyed by day)
}

#[contracttype]
pub struct WithdrawalRequest {
    pub request_id: u64,    // stable id — audit M-04
    pub owner: Address,
    pub shares: i128,
    pub requested_at: u64,  // load-bearing: pricing is gated on request age
}

#[contracttype]
pub struct DepositRequest {
    pub request_id: u64,
    pub owner: Address,
    pub assets: i128,       // escrowed — not in TMA until minted
    pub requested_at: u64,
}
```

The exact conservation identity is
`raw_balance == TMA + Σ uncollected ClaimableBalance + Σ DepositQueue escrow`;
`recover_uncollected`'s Recredit surplus bound subtracts the deposit escrow so a
mis-keyed recredit can never be satisfied out of pending entrants' funds.

**Upgrade note:** `WithdrawalRequest` gained the `requested_at` field, which changes the
stored layout of `VaultKey::WithdrawalQueue`. Upgrading an existing deployment requires
the withdrawal queue to be **empty** at the moment of upgrade — entries written under
the old layout do not deserialize under the new type. Runbook: pause the vault, have
outstanding requests cancelled (or drain them via a final maintenance pass before the
pause), verify `get_withdrawal_queue_len() == 0`, upgrade, unpause.

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
("sentinel", "credited",   <user>)  → Credited               (amount, new_balance)
("sentinel", "collected",  <user>)  → Collected              (amount)
("sentinel", "recovered",  <user>)  → Recovered              (amount, mode: RecoveryMode)
("sentinel", "snapshot",   <day>)   → SharePriceSnapshot     (price)
("sentinel", "wd_req",     <owner>) → WithdrawalRequested    (request_id, shares, queue_len)
("sentinel", "wd_cancel",  <owner>) → WithdrawalCancelled    (request_id, shares, queue_len)
("sentinel", "wd_partial", <owner>) → RequestPartiallyFilled (request_id, shares_filled, shares_remaining)
("sentinel", "wd_dropped", <owner>) → RequestDropped         (request_id, shares)
("sentinel", "controller_set", <controller>) → ControllerSet
("sentinel", "oracle_set", <oracle>)          → OracleSet (forced: bool — true when force_set_oracle skipped the pending-outcomes check)
("sentinel", "min_wd_req_set")                → MinWithdrawalRequestSet (min_assets)
("sentinel", "ratio_set")                     → SolvencyRatioSet (ratio)
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
    AssetToken,              // Address
    RiskVault,               // Address
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
fn get_active_flights(env: Env) -> Vec<(Symbol, u64)>;       // whole set — off-chain use
fn get_active_flights_page(env: Env, offset: u32, limit: u32)
    -> Vec<(Symbol, u64)>;                                   // bounded window
fn get_active_flight_count(env: Env) -> u32;                 // O(1)
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
- On on-time settlement, FlightPoolManager transfers the premiums to RiskVault and returns the total; the Controller then records it via the controller-only `record_premium_income()`
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
| Global config (Controller, AssetToken, etc.) | Instance | Existing cron `extend_ttl()` — no change |
| Active-flight set (`ActivePage`/`ActiveIdx`/`ActiveCount`) | Persistent pages + index, Instance count | Pages re-extended on every write and paged read; index extended to flight date (+ buffer) on write; archived pages restorable (`sentinel.page_miss` diagnostic) |
| `RecoveredBalance` | Instance | Kept alive with all other instance data — no separate management |
| `FlightConfig(id, date)` | Persistent | `extend_flight_ttl` (31d) on register; **on settle**, `extend_flight_ttl_to(claim_expiry + 30d)` so the claim window is self-sufficient on-chain (audit C-01). A key-level `ExtendFootprintTTLOp` executor job is the planned long-term layer. |
| `Buyer(id, date, addr)` | Persistent | Fixed 180-day (network-max) TTL at write, never re-extended — claim expiry is unknown at purchase time, and 180d comfortably covers the max 60d claim window |
| `Claimed(id, date, addr)` | Persistent | Fixed 180-day (network-max) TTL at write, never re-extended |

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
7. **Execute settlements** via `execute_settlements()` — process flights in `ToBeSettled*`
   status in a bounded rotating window (at most `MAX_SETTLE_BATCH = 10` per call): move
   money between FlightPoolManager and RiskVault, mark flights as `Settled`. Larger
   backlogs drain across successive keeper calls; `execute_settlements_bounded(keeper,
   limit)` lets an operator shrink the window down to one flight if a full window ever
   exceeds transaction resource budgets.
8. **Drain the underwriter withdrawal queue + share-price snapshot** via the separate
   keeper entry point `run_queue_maintenance()` (audit M-03 split). Decoupled from
   `execute_settlements` so queue payouts can't be blocked by settlement gas pressure.
9. Maintains aggregate counters — `total_policies_sold`, `total_premiums_collected`,
   `total_payouts_distributed`.
10. Maintains a **per-traveler index** — `TravelerFlights(Address)` in Persistent storage —
    for efficient frontend queries. Appended on each `buy_insurance()` call, capped at
    1,000 entries per traveler (oldest evicted on overflow; full history stays in events).
11. Exposes `get_flights_for_traveler(address)` for the frontend to show only a user's policies.
12. **Emits `sentinel.ttl_miss(flight_id, date)`** from `classify_flights` when oracle returns
    `NotInitiated` for a flight in the active list — diagnostic signal consumed by the
    off-chain TTL-extender cron (Improvement #6) so it can detect archived `FlightData`
    entries and react before settlement fails.
13. **Bounded owner setters** (audit H-07 + M-02): `set_solvency_ratio` ∈ [100, 10_000],
    `set_min_lead_time` < 90d, `set_claim_expiry_window` ∈ [1d, 60d]. Same bounds
    enforced in `__constructor`. `set_solvency_ratio` additionally mirrors the ratio
    into the RiskVault atomically (the vault validates the same bounds), so LP exits
    enforce the same reserve purchases are admitted against — it must therefore run
    after the vault's `set_controller` wiring.
14. **Pausable** (audit H-03). Owner-only pause halts `buy_insurance`, `classify_flights`,
    `execute_settlements`, `run_queue_maintenance`; admin setters and `extend_ttl` stay
    open so the owner can recover from a paused state.
15. **Buyer whitelist (Phase 11)** — opt-in allowlist on `buy_insurance`. Owner-only
    `set_whitelist_enabled(bool)` flips the kill-switch (default `false`, so deploy is
    non-breaking). When enabled, `buy_insurance` panics with `"buyer not whitelisted"`
    unless the traveler holds a currently valid approval. Approvals carry an explicit
    on-chain deadline (`now + 180 days`, stored in `BuyerApprovalExpiry(addr)`) that
    every gated purchase slides forward — an actively-buying address never lapses, a
    dormant one expires by the ledger clock and must be re-attested. The deadline is
    contract-checked state, NOT the storage entry's TTL: an archived Persistent entry
    is restored with its original value on next access rather than reading as absent,
    so a TTL alone could never expire an authorization. Admin-managed via
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
/// Processes ToBeSettled* flights in a bounded rotating window
/// (MAX_SETTLE_BATCH = 10 per call — settlement writes far more entries per
/// flight than classification: FlightData + FlightConfig + active-set
/// swap-removal writes + several events): moves money, marks Settled.
/// Does NOT touch the withdrawal queue or share-price snapshot.
fn execute_settlements(env: Env, keeper: Address) {
    keeper.require_auth();
    let authorized = env.storage().instance().get(&CtrlKey::AuthorizedKeeper).unwrap();
    assert!(keeper == authorized, "not authorized keeper");
    // ... settlement execution logic ...
}

/// Operator escape hatch: execute_settlements with a caller-chosen window
/// size, clamped to [1, MAX_SETTLE_BATCH]. If a window ever exceeds the
/// network's per-transaction resource budgets, the keeper can shrink it —
/// down to one flight — and still make progress (settlement failure is
/// atomic, so a too-large fixed window would otherwise retry-fail forever).
fn execute_settlements_bounded(env: Env, keeper: Address, limit: u32);

/// Exact-tuple variants: classify / settle ONE flight without scanning the
/// active list. The rotating sweeps guarantee eventual coverage, but their
/// latency grows with total active-set occupancy (future bookings and
/// recently-settled rows share the same enumeration windows), and while a
/// public outcome waits for the cursors the vault's settlement barrier stays
/// engaged protocol-wide. The executor knows exactly which flight's outcome
/// it just wrote, so it drives that tuple straight through these two calls;
/// the sweeps remain the repair backstop. Both are keeper-gated, require the
/// flight to be in the oracle active set (FlightNotListed = 321 otherwise —
/// tombstones and evicted flights are unreachable), and are idempotent on
/// state: the bool reports whether a transition/settlement actually ran.
fn classify_flight(env: Env, keeper: Address, flight_id: Symbol, date: u64) -> bool;
fn settle_flight(env: Env, keeper: Address, flight_id: Symbol, date: u64) -> bool;

/// Called by QueueMaintainer cron (every 5 minutes, decoupled from settlement).
/// Prices both LP request queues (deposits first — fresh entries add capital
/// that can fund matured exits in the same pass) + records the daily
/// share-price snapshot. Split out from execute_settlements so heavy
/// settlements can't block underwriter entries/exits (audit M-03).
fn run_queue_maintenance(env: Env, keeper: Address) {
    keeper.require_auth();
    let authorized = env.storage().instance().get(&CtrlKey::AuthorizedKeeper).unwrap();
    assert!(keeper == authorized, "not authorized keeper");
    vault.process_deposit_queue(&controller_addr);
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
("sentinel", "bought",            <traveler>, <flight_id>, <date>) → InsuranceBought             (premium)
("sentinel", "classified",        <flight_id>, <date>)             → FlightClassified            (status)
("sentinel", "settled",           <flight_id>, <date>)             → FlightSettledEvent          (outcome)
("sentinel", "ttl_miss",          <flight_id>)                     → TtlMiss                     (date)
("sentinel", "buyer_whitelisted", <addr>)                          → BuyerWhitelistedEvent
("sentinel", "buyer_removed",     <addr>)                          → BuyerWhitelistRemovedEvent
("sentinel", "whitelist_toggled")                                  → WhitelistToggled            (enabled)
("sentinel", "cfg_missing",       ...)                             → FlightConfigMissing
("sentinel", "voided",            ...)                             → FlightVoided
("sentinel", "timed_out",         ...)                             → FlightTimedOutActive
("sentinel", "evict_settled",     ...)                             → EvictedFlightSettled
("sentinel", "keeper_set" | "solvency_ratio_set" |
 "min_lead_time_set" | "claim_expiry_window_set")                  → owner-setter audit events
```

The first three are domain events covering the buy / classify / settle
lifecycle, each with a distinct verb topic so indexers can discriminate at
the topic-filter level without decoding payloads. `InsuranceBought` gained
`flight_id` and `date` as topics
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
    Governance,                // Address — Instance
    RiskVault,                 // Address — Instance
    Oracle,                    // Address — Instance
    FlightPoolManager,         // Address — Instance (set once)
    AssetToken,                // Address — Instance
    AuthorizedKeeper,          // Address — Instance (executor backend — shared by classifier + settler)
    SolvencyRatio,             // u32 — Instance (default 100)
    MinLeadTime,               // u64 — Instance (seconds)
    ClaimExpiryWindow,         // u64 — Instance (seconds)
    TotalPoliciesSold,         // u64 — Instance
    TotalPremiumsCollected,    // i128 — Instance
    TotalPayoutsDistributed,   // i128 — Instance (gross claimable value opened by delayed/cancelled settlements)
    WhitelistEnabled,          // bool — Instance (Phase 11; default false → open buys)
    ClassifyCursor,            // u32 — Instance (rotating index into the oracle active list)
    SettleCursor,              // u32 — Instance (rotating index into the oracle active list)
    TravelerFlights(Address),  // Vec<(Symbol, u64)> — Persistent (per-user flight index)
    BuyerWhitelisted(Address), // bool — Persistent, RETIRED (was the whitelist flag; a TTL
                               // lapse cannot express expiry — archived entries restore
                               // with their original value. Legacy entries are ignored.)
    BuyerApprovalExpiry(Address), // u64 unix secs — Persistent; approval valid while
                               // now < value, slid forward by each gated purchase
                               // (180d window). The deadline (not the entry's TTL) is
                               // the authorization lifetime — a restored archived
                               // entry still expires on time.
}
```

The owner address is not a `CtrlKey` variant — it lives in the OpenZeppelin
`Ownable` storage slot, as in every other contract.

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
       |          |                                         audit L-01)
       |          +-----------------> ToBeSettledOnTime    (void: terminal outcome
       |                                                    never arrived; allowed
       |                                                    only >= 14 days past the
       |                                                    recorded scheduled
       |                                                    arrival — premiums to
       |                                                    vault, collateral
       |                                                    released, no payout)
       +----------------------------> ToBeSettledOnTime    (void: no flight data
                                                            ever arrived; allowed
                                                            only >= 14 days past
                                                            departure — premiums
                                                            to vault, collateral
                                                            released, no payout)
```

Every state that locks vault collateral has a bounded terminal path: `Landed`
and `Cancelled` settle through classification; a `NotInitiated` row that never
receives data voids via the stale timeout; an `Active` row whose terminal
outcome never arrives voids via the active timeout. Both voids settle as
on-time (never a payout — paying without an attested outcome would let a data
outage mint claims), and the oracle can still write the real outcome at any
moment before the void is classified.

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

- `estimated_arrival_time: u64` — set by oracle when transitioning `NotInitiated -> Active`.
  This is the flight's **published scheduled arrival** (AeroAPI `scheduled_in`). It is the
  baseline that delay classification measures against, so the oracle must never write a
  delay-adjusted live estimate (AeroAPI `estimated_in`) here — a live ETA absorbs announced
  delays and would classify genuinely delayed flights as on-time.
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
- **`set_landed` / `set_estimated_arrival` input validation**: zero timestamps
  (the unset sentinel) and arrivals before the departure day's midnight are
  rejected (`InvalidTimestamp`). Early arrivals (`actual < estimated`) are
  deliberately **accepted** — they are legitimate flight outcomes, and rejecting
  them would strand such flights `Active` forever (never classifiable, collateral
  locked). The delay math in `classify_flights` saturates a negative delay to
  zero, so an early arrival classifies as on-time.
- **Delayed prune.** `set_settled` records `settled_at` but does NOT remove the flight
  from `ActiveFlightList`. A separate permissionless `prune_settled()` entry is what
  evicts settled flights from the list, and only after they have been settled for at
  least `SETTLED_RETENTION_DAYS = 7` days. **Missing `FlightData`** (an entry
  archived past its TTL) is **retained**, not evicted — archived is not settled, and
  the flight may still have money riding on it. The pruner emits `MissingFlightData`
  so operators restore the entry; freeing the slot without restoration requires the
  owner-only `evict_missing_flight`, which must then be followed by
  `Controller.settle_evicted_flight` to release the flight's pool bucket and vault
  collateral.
- **Pausable** (audit H-03). Owner-only pause halts every oracle/controller write
  entry point; `prune_settled` and `extend_ttl` stay open as permissionless
  housekeeping.

**Storage layout:**

```rust
#[contracttype]
pub enum OracleKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    AuthorizedOracle,
    AuthorizedController,
    PruneCursor,     // u32 — rotating slot cursor into the paginated active set
    PendingOutcomes, // u64 — outcomes public but not yet settled; read by the
                     // vault's settlement barrier to block entry/exit

    // Persistent — keyed multi-row state
    FlightData(Symbol, u64),         // FlightData

    // Temporary — short-lived sale authorizations (value: expiry timestamp).
    // Temporary storage is deliberate: a lapsed authorization must vanish,
    // and archival-restoration semantics must never resurrect one.
    SaleAuth(Symbol, u64),           // u64 (expires_at)
}

// The live active-flight set is the shared paginated structure in
// sentinel_types::active_set (used by both the oracle and the pool):
//   ActivePage(u32)        — Persistent: Vec<(Symbol, u64)> pages (≤ 100 entries)
//   ActiveIdx(Symbol, u64) — Persistent: the entry's global slot (O(1) removal)
//   ActiveCount            — Instance:  total entries (O(1) saturation gauge)

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

const SETTLED_RETENTION_DAYS: u64 = 7;
const SECONDS_PER_DAY: u64 = 86_400;
```

**Storage tier rationale:**

- **The active-flight set is paginated Persistent storage** (`sentinel_types::active_set`):
  pages of at most 100 `(flight_id, date)` tuples, a per-entry reverse index for O(1)
  swap-removal, and an Instance-tier count. The previous single Instance `Vec` shared the
  65,536-byte contract-instance entry and had to be capped at 1,000 flights — at the cap,
  `register_flight` rejected every first purchase of a new flight protocol-wide. Pages
  scale independently of instance state (the remaining `MAX_ACTIVE_FLIGHTS = 100,000` cap
  is a pure sanity bound), and readers pay only for the pages they touch: a keeper batch
  reads at most two page entries via `get_active_flights_page(offset, limit)`. Page TTLs
  are re-extended by every write and every paged read (the keeper's rotating scans sweep
  all pages every few hours); index entries are extended to the flight date (+ buffer) at
  write, like the `FlightData` rows they shadow. An archived page degrades availability,
  never integrity: enumeration skips it and emits `sentinel.page_miss(page)` so operators
  restore it. The delayed-prune scheme still bounds the set to (active flights) +
  (settled-but-not-yet-evicted flights), the latter capped by the 7-day retention window.
- **`FlightData(Symbol, u64)`** is in **Persistent** storage (per-flight, unbounded
  entries — can't move to Instance). TTL is self-managed: every oracle write extends the
  entry to the flight date (or, once an outcome is recorded, to a settlement deadline)
  plus a buffer via `extend_flight_ttl_to`, so the record outlives its own settlement
  window without external help. A key-level `ExtendFootprintTTLOp` executor job remains
  a planned backstop for idle entries.

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
                                                           // also deletes any live
                                                           // sale authorization

// Oracle-only — sale window (purchase-gate attestation). A live, unexpired
// authorization is the oracle's affirmative statement that the flight
// instance was verified scheduled-and-not-cancelled at write time; the
// Controller's buy_insurance requires one and fails closed without it.
fn open_sale(env: Env, oracle: Address,
             flight_id: Symbol, date: u64,
             expires_at: u64);                             // expires_at bounded by
                                                           // now + 24h and the
                                                           // departure-day boundary;
                                                           // rejected once an outcome
                                                           // is recorded
fn close_sale(env: Env, oracle: Address,
              flight_id: Symbol, date: u64);               // revoke ahead of expiry;
                                                           // idempotent. Pause-EXEMPT:
                                                           // open windows outlive a
                                                           // pause (temporary storage,
                                                           // read by the controller),
                                                           // so the revoking write
                                                           // must stay available
                                                           // during incidents

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
fn get_active_flights(env: Env) -> Vec<(Symbol, u64)>;       // whole set — off-chain use;
                                                             // footprint grows with pages
fn get_active_flights_page(env: Env, offset: u32, limit: u32)
    -> Vec<(Symbol, u64)>;                                   // bounded window — what the
                                                             // keeper loops iterate with
fn get_active_flight_count(env: Env) -> u32;                 // O(1) from stored count
fn is_flight_listed(env: Env, flight_id: Symbol, date: u64) -> bool; // exact membership
                                                             // (page-scan fallback)
fn get_flights_by_status(env: Env, status: FlightStatus) -> Vec<(Symbol, u64)>;
fn is_sale_open(env: Env, flight_id: Symbol, date: u64) -> bool;   // purchase gate;
                                                                   // fails closed
fn get_sale_auth(env: Env, flight_id: Symbol, date: u64) -> Option<u64>; // expiry, for
                                                                   // frontend/executor
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
`@stellar/stellar-sdk` v14 + `node-cron` + `express` + `dotenv`. Six cron
jobs (SaleAuthorizer, FlightDataFetcher, FlightClassifier, SettlementExecutor,
QueueMaintainer, TTLExtender), one HTTP API for health / logs / manual
triggers, and a single-shot CLI (`npm run
{authorize,fetch,classify,settle,queue,ttl}`) for ops + tests.
Acurast TEE backend planned as a sibling under `executor/acurast/` in a
later phase — same core logic, different deployment manifest.

### Cron Job Summary

| Cron | Name | Frequency | On-chain target | Authorization |
|------|------|-----------|-----------------|---------------|
| #0 | **SaleAuthorizer** | Every 2 hours (offset :30) | `OracleAggregator.open_sale()` / `close_sale()` / `set_cancelled()` | `authorized_oracle` |
| #1 | **FlightDataFetcher** | Every 2 hours | `OracleAggregator` | `authorized_oracle` |
| #2 | **FlightClassifier** | Every 1 hour | `Controller.classify_flights()` | `authorized_keeper` |
| #3 | **SettlementExecutor** | Every 5 minutes | `Controller.execute_settlements()` | `authorized_keeper` |
| #3b | **QueueMaintainer** | Every 5 minutes | `Controller.run_queue_maintenance()` | `authorized_keeper` |

### Cron #0 — SaleAuthorizer (Oracle, every 2 hours at :30)

Keeps the purchase gate's sale windows attested. `buy_insurance` requires a
live, unexpired `open_sale` authorization — absence of an on-chain outcome is
not evidence the real flight is insurable (a publicly cancelled flight looks
identical to a valid unreported one until the cancellation write lands), so
the oracle attests insurability affirmatively and purchases fail closed
without it.

For every flight number in `SALE_AUTH_FLIGHT_IDS` and every day within
`SALE_AUTH_HORIZON_DAYS` (default 90, matching the booking horizon), each run:

1. queries AeroAPI for the (flight, day) schedule;
2. pushes `set_cancelled` the moment a cancellation is visible — the
   tombstone closes sales instantly (and deletes the live authorization)
   without waiting for it to lapse;
3. `close_sale`s a window whose instance became unverifiable (no data /
   ambiguous candidates) — fail closed, never guess;
4. otherwise opens/refreshes the window with expiry
   `min(flight date, now + SALE_AUTH_VALIDITY_SECS)` (default 6h; the
   contract caps validity at 24h).

Ops invariants:

- **The flight-id list must track the governance route whitelist.** A
  whitelisted route missing from the list is never sellable.
- **Cadence must stay well inside the validity window**, or every sale
  window lapses between runs and sales halt protocol-wide. That halt is the
  intended fail-safe when the authorizer is down — availability degrades,
  never safety.
- Days beyond the provider's schedule visibility return no data and stay
  closed; the effective sale horizon is `min(horizon, provider visibility)`.
- Runs on the oracle key, off-tempo from the fetcher (:30 vs :00) to avoid
  sequence-number contention.

### Cron #1 — FlightDataFetcher (Oracle, every 2 hours)

Fetches flight data from AeroAPI and writes it to the OracleAggregator. This cron is the
only off-chain process that talks to external APIs.

> **Semantics contract:** the "estimated arrival time" written on-chain in Step A is
> AeroAPI's **`scheduled_in`** (the published schedule), NOT the live `estimated_in`
> ETA. The classifier computes delay as `actual − estimated`, so writing a
> delay-adjusted ETA would systematically classify delayed flights as on-time. Every
> executor backend (cron, Acurast, Phala) must preserve this.
>
> **Day-key contract:** the `date` in every `(flight_id, date)` key is the flight's
> **UTC departure day** (midnight UTC, unix seconds). Deriving it from the *local*
> departure date breaks the oracle's timestamp floor: `set_estimated_arrival` /
> `set_landed` reject arrivals earlier than `date`, and a short flight departing
> early-morning local time east of UTC (e.g. 01:00 JST = 16:00 UTC the previous day)
> can arrive before midnight UTC of its local departure date. A mis-keyed instance
> strands in `Active` and is voided as on-time by the active timeout — travelers on
> genuinely delayed or cancelled flights lose both payout and premium. Every executor
> backend AND every frontend deriving day keys must preserve this.

```
FlightDataFetcher
    |
    +-> reads OracleAggregator.get_active_flight_count() +
    |   get_active_flights_page(offset, limit) via Stellar RPC (paged)
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

**Targeted fast path.** The hourly sweep is the backstop, not the primary latency path:
whichever executor job writes an outcome (`set_landed` / `set_cancelled`) immediately
calls `controller.classify_flight(keeper, flight_id, date)` followed by
`controller.settle_flight(...)` for that exact tuple, so a fresh outcome normally
classifies and settles within seconds regardless of active-set size.

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

The cron drives this in a drain loop, not as a single submission: while
`oracle.get_pending_outcomes() > 0` it alternates `classify_flights` and
`execute_settlements` passes (bounded per run, stopping early when passes make no
progress), because the vault blocks every LP entry/exit until the pending count
reaches zero. When nothing is pending the run submits no transaction at all.

### Cron #3b — QueueMaintainer (Keeper, every 5 minutes)

```
QueueMaintainer -> signs + submits Soroban tx:
    Controller.run_queue_maintenance(keeper_address)
        |
        +-> keeper.require_auth()
        +-> vault.process_deposit_queue()      (FIFO, matured requests only)
        +-> vault.process_withdrawal_queue()   (FIFO — see Underwriter Entry/Exit)
        +-> vault.snapshot()                   (no-op if already snapshotted today)
```

Same authorized_keeper as #3; separate keeper job (or the same one looping both)
because the two should not share resource budget.

### Cron #4 — TTL Extender (instance `extend_ttl` + prune, every 24 hours)

A permissionless cron that keeps the contract instances (and everything in their
Instance storage) alive, and prunes settled flights from the oracle's active set.

```
TTL Extender
    |
    +-> calls extend_ttl() on all five contracts
    |       (instance + code TTL; covers Routes, WithdrawalQueue,
    |        active-set count, and all other Instance state)
    |
    +-> calls OracleAggregator.prune_settled()
            (removes Settled flights past the 7-day retention window
             from the active set)
```

Per-flight Persistent entries (`FlightConfig`, `FlightData`) are self-extending: their
TTL is bumped on every contract read/write that touches them. Deeper key-level TTL
extension via a raw Soroban `ExtendFootprintTTLOp` (covering idle `FlightConfig` /
`FlightData` / `Route` / `TravelerFlights` / `ClaimableBalance` entries enumerated
off-chain) is a planned, separate executor concern — not part of this cron. Archived
Persistent entries remain restorable via `RestoreFootprintOp` in the meantime.

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
  1. Read OracleAggregator.get_active_flight_count() +
     get_active_flights_page(offset, limit) via Stellar RPC (paged)
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
├── centralized_cron/              # Current backend: node-cron + Express
│   ├── src/
│   │   ├── index.ts               # node-cron scheduler entry point (all job schedules)
│   │   ├── config.ts              # Loads .env, RPC URLs, keypairs
│   │   ├── server.ts              # Express ops API: /api/health, /api/logs, /api/trigger/<job>
│   │   ├── run_once.ts            # CLI single-run entry (npm run authorize/fetch/classify/settle/queue/ttl)
│   │   ├── run_log.ts             # In-memory run history backing /api/logs
│   │   ├── sale_authorizer.ts     # open_sale / close_sale / set_cancelled attestations
│   │   ├── flight_data_fetcher.ts # AeroAPI fetch + oracle data writes
│   │   ├── flight_classifier.ts   # classify_flights tx
│   │   ├── settlement_executor.ts # execute_settlements tx
│   │   ├── queue_maintainer.ts    # run_queue_maintenance tx
│   │   ├── ttl_extender.ts        # extend_ttl on all contracts + prune_settled
│   │   ├── soroban_client.ts      # Stellar SDK wrapper (build, sign, submit)
│   │   ├── aeroapi_client.ts      # AeroAPI HTTP client
│   │   └── types.ts               # FlightStatus, FlightData, etc.
│   ├── package.json
│   └── tsconfig.json
│
└── mock-api/                      # Local AeroAPI stand-in (scenarios.json per flight)
```

The job modules contain the business logic and are runtime-agnostic; `index.ts`
(scheduling), `run_once.ts` (CLI), and `server.ts` (on-demand trigger) are thin harnesses
around them. A future decentralized backend (e.g. Acurast/Phala TEE workers) would wrap
the same modules in its own harness — typically under 20 lines of glue code.

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
        Route TTL extended (120-day window) on this write
        emits route.listed event -> off-chain indexer materializes the row
        NO flight entry created yet — lazy creation on first purchase
```

### Buying Insurance

```
Traveler -> Controller.buy_insurance(flight_id, origin, dest, date)
                |
                +-> traveler.require_auth()
                +-> date must be midnight-UTC aligned             revert if not day-aligned
                +-> if WhitelistEnabled: traveler must hold a     revert "buyer not whitelisted"
                |       currently valid approval (explicit
                |       180-day inactivity deadline; this
                |       purchase slides it forward on success)
                +-> GovernanceModule.route_status(flight_id, origin, dest)
                |       match { Active(terms) => use terms (premium, payoff, delay_hours)
                |               Disabled      => revert "route is disabled"
                |               Unknown       => revert "route not whitelisted" }
                +-> enforce minimum_lead_time                     revert if departure too soon
                +-> OracleAggregator.get_flight_data(flight_id, date).status
                |       must be NotInitiated or Active            revert if outcome recorded
                +-> OracleAggregator.is_sale_open(flight_id, date)
                |       must be true — a live, unexpired oracle   revert "sale not open"
                |       attestation that the flight instance is
                |       scheduled and not cancelled (fails closed
                |       when missing, lapsed, closed, or archived)
                |
                +-> flight exists in FlightPoolManager for (flight_id, date)?
                |       +- YES -> use the bucket's snapshotted terms, then
                |                 GovernanceModule.terms_valid(snapshot)
                |                 must be true — the snapshot was taken under
                |                 the limits in force at first purchase, and
                |                 new exposure must satisfy the limits in
                |                 force NOW      revert "snapshot terms exceed limits"
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
    +-> reads OracleAggregator.get_active_flight_count() +
    |   get_active_flights_page(offset, limit) via Stellar RPC (paged)
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
    +-> panic if env.ledger().timestamp() >= claim_expiry
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

### Underwriter Entering and Exiting Capital (two-phase FIFO)

There is no immediate path: `deposit`/`mint`/`withdraw`/`redeem` revert
(`DirectEntryDisabled` / `DirectExitDisabled`) and the `max_*` views report zero. Every
entry and exit commits first and is priced by queue processing only after the request
outlives the LP pricing delay (6 h).

```
-- Entry --

Underwriter -> RiskVault.request_deposit(caller, assets) -> request_id
    +-> caller.require_auth()
    +-> panic if assets <= 0, previews to zero shares, or below the request floor
    +-> usdc_client.transfer(caller, vault, assets)      <- escrowed, NOT in TMA
    +-> request queued as (request_id, caller, assets, requested_at) (Instance)
    +-> returns request_id (monotonic counter) — cancel_deposit returns the escrow

                (keeper maintenance drives process_deposit_queue)
                    +-> no-op while a written outcome is unsettled (barrier)
                    +-> walks FIFO list; stops at the first request younger
                        than the pricing delay (chronological queue)
                    +-> shares minted at the CURRENT price; TMA += assets
                    +-> zero-share requests (price outgrew them) are returned

-- Exit --

Underwriter -> RiskVault.request_withdrawal(caller, shares) -> request_id
    +-> caller.require_auth()
    +-> panic if shares == 0 or shares > balance
    +-> request queued as (request_id, caller, shares, requested_at) (Instance)
    +-> shares escrowed
    +-> returns request_id (monotonic counter) — use to cancel later, audit M-04

                (queue drains after each settlement via process_withdrawal_queue)
                    +-> no-op while a written outcome is unsettled (barrier)
                    +-> walks FIFO list in order; stops at the first immature request
                    +-> for each matured request: if solvency allows, priced NOW
                    +-> shares burned; ClaimableBalance(caller) += redemption amount
                    +-> total_managed_assets -= redemption amount   <- TMA reduced HERE,
                                                                       at credit time
                    +-> TTL extended to 60 days on ClaimableBalance write

Underwriter -> RiskVault.collect(caller)
    +-> caller.require_auth()
    +-> amount = ClaimableBalance(caller)
    +-> panic if zero
    +-> ClaimableBalance(caller) removed
    +-> usdc_client.transfer(vault, caller, amount)
        (total_managed_assets is NOT touched here — it was already reduced when
         the queue processor credited the balance; uncollected credits sit in the
         vault's raw token balance but outside TMA)
```

**Why the delay:** the settlement barrier only engages once the oracle WRITES an outcome,
which is strictly after that outcome becomes publicly knowable. Pricing a request only
after it is older than the oracle pipeline's worst-case observation-to-write latency
guarantees the price it receives reflects everything knowable at commitment — an
informed LP can no longer exit before a known loss or enter before a known gain at the
other LPs' expense.

**FIFO withdrawal semantics:** Underwriters are in a list. When flights are settled and
capital is freed, the queue processor walks the list in order. If the vault's solvency
allows it, each matured request is priced and credited. The underwriter then calls
`collect()` to pull the USDC. Requests that cannot be fulfilled yet remain in the queue
for the next settlement cycle.

---

## Solvency Invariant

**Never sell insurance unless we have money to cover it.** Before every insurance purchase:

```
total_managed_assets >= ceil((locked_capital + new_payoff) * solvency_ratio / 100)
```

**And never let capital leave below the same reserve.** Every LP exit (direct
withdraw/redeem, `max_*` views, queue processing) is bounded by:

```
withdrawable_capital = max(total_managed_assets - ceil(locked_capital * solvency_ratio / 100), 0)
```

- `free_capital()` = `total_managed_assets` - `locked_capital` (nominal margin, reporting only)
- `locked_capital` increases by `payoff` on each purchase; decreases by `payoff * buyer_count`
  on settlement
- `solvency_ratio` defaults to 100 — fully collateralised; the controller mirrors every
  owner update into the vault so both sides of the invariant use the same value
- Enforcing the ratio only on purchase would be one-sided: any LP could withdraw the
  nominal margin and collapse the configured reserve to 100% backing between purchases
- Underwriter withdrawals that would breach the reserve are queued, not rejected
- Queue processor re-checks the reserve at fulfillment time

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
settle archived claims during a pause. Two further deliberate exemptions:
`flight_pool_manager.claim` stays open (the claim window runs on the ledger clock;
gating it would let a pause silently expire valid, already-funded payouts), and
`governance.route_status` — nominally a read — still commits its protective side
effects (route/index TTL renewals and the uniqueness-index self-heal) while the
module is paused. Those writes grant no privilege; the pause switch halts the
governance module's *administrative* entry points only.

**Operate pause/unpause as a set.** The keeper loops call pause-gated entry points
cross-contract (`pool.settle_*`, `oracle.set_to_be_settled` / `set_settled`), so
pausing the pool or the oracle alone makes `classify_flights` /
`execute_settlements` revert wholesale rather than skip — settlement halts for
every flight, and any already-public outcome keeps the vault's settlement barrier
engaged (LP entry/exit blocked) until the paused contract is resumed and the
keeper catches up. Incident procedure: pause all five contracts together, and
unpause them together.

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
6. **Outcome-write input validation**: `set_estimated_arrival` and `set_landed`
   reject zero timestamps and arrivals before the departure day's midnight
   (`InvalidTimestamp`). There is deliberately NO `actual >= estimated` floor —
   early arrivals are legitimate outcomes and rejecting them would strand flights
   `Active` forever; the classifier saturates a negative delay to zero, so an
   early arrival settles as on-time. The oracle remains trusted for the
   truthfulness of the reported times themselves.
7. **Delay baseline is the published schedule.** `estimated_arrival_time` must carry
   the scheduled arrival (`scheduled_in`), never a delay-adjusted live ETA — see the
   FlightDataFetcher semantics contract above. The contracts cannot enforce this
   distinction; it is part of the trusted-oracle contract.
8. **Day keys are UTC.** The `date` in every `(flight_id, date)` key is the flight's
   UTC departure day (midnight UTC) — see the FlightDataFetcher day-key contract
   above. The contracts enforce this only indirectly (the arrival-timestamp floor
   rejects the writes a local-date key would produce), so keying by UTC is part of
   the executor/frontend contract and must survive backend migrations.

**Trust assumption depends on executor backend.** With a centralized cron, trust the
server operator. With a TEE backend (Acurast, Phala), trust the hardware attestation chain.
The architecture is designed so that the trust model **improves over time** without touching
the contracts — only the authorized address changes.

### Soroban Storage Rent & Archival

All contracts must manage TTL (time-to-live) to prevent data archival:

- **Instance storage** (contract config, global state): TTL extended via existing cron
  `extend_ttl()` calls. WithdrawalQueue, the active-set count, and other global
  state are in Instance storage — they share TTL with the contract instance. (The
  active-flight set's pages and reverse index are Persistent — self-extending on every
  write and paged read, restorable if they archive anyway. `Route(...)` entries are
  Persistent too, with a 120-day TTL refreshed on every route write.)
- **Persistent storage** (per-flight data, per-user data): self-extending — TTL is
  bumped on every contract read/write that touches the entry (FlightConfig, FlightData,
  Route). Per-user entries (Buyer, Claimed, ClaimableBalance) get TTL set on write
  proportional to the claim window.
- **Temporary storage** (SnapshotPrice): Used for disposable data with natural timeout.
  Permanent deletion after TTL — no archival rent.

A future `ExtendFootprintTTLOp` executor job (enumerating idle Persistent entries
off-chain and extending them in bulk) is planned but not part of the current
centralized-cron backend; Cron #4 today performs instance-level `extend_ttl()` plus
`prune_settled()` only.

**`RestoreFootprintOp` safety net:** Instance and Persistent entries are never permanently
deleted — they are archived and can be restored via `RestoreFootprintOp`. Only Temporary
storage is truly permanent deletion. This means most TTL-related issues are "temporarily
inaccessible until restored" rather than "permanently lost."

### Known Limitations

- **Oracle manipulation** — single authorized executor; trust model depends on backend.
  Multi-oracle aggregation is a future enhancement.
- **Front-running** — Stellar's transaction ordering is validator-determined. A mempool
  watcher could theoretically front-run `buy_insurance`, but this is a legitimate purchase.
- **LP pricing is delayed, not immediate (deliberate).** Every entry and exit is a
  two-phase request priced only once it outlives `LP_PRICING_DELAY_SECS` (6 h). This
  closes the window between a flight outcome becoming publicly knowable and the oracle
  writing it on-chain (where the settlement barrier cannot see it): by pricing time,
  everything knowable at commitment is settled into the price or barrier-held. The
  residual is an oracle-pipeline outage longer than the delay — outcomes then stay
  unwritten past request maturity and matured requests price stale. **Operational
  requirement:** on an oracle/fetcher outage approaching the pricing delay, pause the
  vault (queue processing stops with it); the sale authorizer's fail-closed windows
  already stop new exposure in the same outage.
- **Void-path income is predictable in advance** — for a flight voided via the stale
  timeout, the outcome (premiums become vault income) is deterministically computable
  from on-chain state the moment `date + 14 days` passes, but the vault's settlement
  barrier only engages when the classifier writes `ToBeSettledOnTime`. The pricing delay
  does not close this one: the income is knowable arbitrarily far in advance, so an LP
  can time a deposit request to mature inside the gap (up to one classifier cycle) and
  capture a pro-rata slice at the pre-income share price. Exposure is bounded by the
  voided flights' premiums — and an attacker seeding bogus flights always loses more in
  premiums than they can recapture — so this is accepted; a tight classifier cadence
  minimizes the window.
- **An extended oracle outage can void real flights.** The stale-void timeout assumes a
  row still `NotInitiated` 14 days past departure never matched a physical flight, and
  the active-void timeout assumes a row still `Active` 14 days past its recorded
  scheduled arrival will never receive a terminal outcome. Both premises fail under a
  partial outage: if the oracle executor stops writing while the keeper keeps
  classifying, real flights cross their timeout and are voided as on-time — travelers on
  genuinely delayed or cancelled flights lose both payout and premium, irreversibly (the
  state machine is forward-only). **Operational requirement:** on any oracle-executor
  outage, pause the Controller (or stop the classifier) well before day 14, and alert
  off the `sentinel.ttl_miss` event stream (fires for overdue `NotInitiated` flights) —
  overdue `Active` flights have no periodic diagnostic before the void, so monitor the
  oracle executor's own health directly. The void events (`sentinel.voided` for
  dataless rows, `sentinel.timed_out` for stuck-`Active` rows) are the after-the-fact
  audit trail.
- **Sale availability depends on the authorizer.** `buy_insurance` requires a live
  oracle sale authorization (max validity 24h), so sales are only as available as the
  SaleAuthorizer cron: if it stops, every window lapses within its validity and new
  purchases halt protocol-wide (existing policies settle normally). This is the intended
  failure direction — an oracle that cannot verify flights must not admit new risk. The
  residual purchase-time exposure is bounded by the authorization's remaining validity
  plus the authorizer's observation cadence: a cancellation that becomes public
  immediately after a refresh stays purchasable until the next authorizer pass writes
  the tombstone (or the window lapses), so keep the cadence tight relative to
  `SALE_AUTH_VALIDITY_SECS`.
- **Correlated event risk** — simultaneous delays across many flights are protected only
  by `minimum_solvency_ratio`. At 100% the vault covers all; underwriters bear correlated risk.
- **No per-underwriter capital attribution** — `locked_capital` is pool-level.
- **Classification lag** — the primary path is targeted: whichever executor job writes
  an outcome immediately calls `classify_flight` + `settle_flight` for that exact tuple,
  so outcome-to-settlement latency is a few transactions, independent of active-set size.
  If the targeted call fails (paused controller, RPC glitch), the sweeps pick the flight
  up: up to 1 hour to the next classifier pass, plus settler rotation.
- **Sweep-based settlement latency scales with active-set occupancy.** The vault blocks
  LP entry/exit from the moment any outcome is written until it settles. The sweeping
  passes inspect at most `MAX_CLASSIFY_BATCH = 25` / `MAX_SETTLE_BATCH = 10` consecutive
  active-set slots per call (settlement writes far more ledger entries per flight), and
  the set mixes future bookings, in-flight rows, and a 7-day retention window of settled
  rows — so a full rotation at high volume takes many calls. The targeted per-flight
  entry points exist precisely so ready work never depends on that rotation; the settler
  cron additionally loops classify+settle passes until `PendingOutcomes == 0` (bounded
  per run) rather than submitting a single fixed window.
  **Operational invariant:** alert on the age of the oldest pending outcome (the
  `PendingOutcomes` counter plus status events give the signal), not merely on cron
  success. If a settlement window ever exceeds the network's per-transaction resource
  budgets, `execute_settlements_bounded(keeper, limit)` shrinks the window — down to one
  flight — so the ready set always drains.
  A flight that can never settle (missing pool config, stalled restore) keeps the barrier
  on until operations resolves it — see `evict_missing_flight` for the terminal escape
  hatch and its `outcome_pending` flag.
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
2. Solvency precheck: read `RiskVault.get_total_managed_assets()` and
   `RiskVault.get_locked_capital()`, and check that TMA covers
   `(locked + payoff) * Controller.get_solvency_ratio() / 100` with the `payoff` from
   step 1. The on-chain solvency gate enforces the same check on submit, so this is a UX
   optimisation to avoid wasted signatures.
3. Sign transaction that calls `Controller.buy_insurance(flight_id, origin, dest, date)`.
   Soroban auth framework handles USDC transfer authorization within the same signature.

**Claim payout (if delayed or cancelled):**
After settlement, call `FlightPoolManager.claim(traveler_address, flight_id, date)`. Must claim before expiry.

**If on time:** No action needed. Premium becomes underwriter yield.

**View my policies:**
Frontend calls `Controller.get_flights_for_traveler(address)` to show only the connected
user's policies — not all flights across the protocol.

### Underwriter

All entry/exit is two-phase — commit now, priced after the 6-hour LP pricing delay at
the then-current share price. The immediate `deposit`/`mint`/`withdraw`/`redeem` calls
revert.

**Deposit:** `RiskVault.request_deposit(caller, assets)` — the USDC escrows immediately;
the keeper's maintenance pass mints shares (proportional to
`total_managed_assets / total_supply` at processing time) once the request matures.
Cancel with `RiskVault.cancel_deposit(caller, request_id)` to take the escrow back.

**Withdraw (queued FIFO):** `RiskVault.request_withdrawal(caller, shares)` — always the
exit path. The request's asset value must meet the owner-configured minimum
(`get_min_withdrawal_request`, shared by both queues) — a floor that keeps the bounded
queues' slots from being occupied by dust requests. Queue drains FIFO after each
settlement, matured requests first — if solvency allows, the amount is credited. Call
`RiskVault.collect(caller)` to pull USDC.

**Cancel queued request:** `RiskVault.cancel_withdrawal(caller, request_id)` — uses the
stable id returned from `request_withdrawal`, NOT the current queue index (audit M-04).

### Function Reference

| Action | Who | Function |
|---|---|---|
| Set global defaults | Owner | `governance.set_defaults(premium, payoff, delay_hours)` |
| Set term limits | Owner | `governance.set_term_limits(max_payoff, max_payoff_ratio)` (bounds every route write; caps a compromised admin key's blast radius) |
| Whitelist route | Owner / Admin | `governance.whitelist_route(caller, flight_id, origin, dest, premium?, payoff?, delay_hours?)` |
| Disable route (soft) | Owner / Admin | `governance.disable_route(caller, flight_id, origin, dest)` |
| Enable route | Owner / Admin | `governance.enable_route(caller, flight_id, origin, dest)` |
| Remove route (hard, must be disabled first) | Owner / Admin | `governance.remove_route(caller, flight_id, origin, dest)` (the flight_id stays reserved ~160 days; remapping it to a different origin/dest is blocked until then) |
| Update route terms (partial) | Owner / Admin | `governance.update_route_terms(caller, flight_id, origin, dest, premium_op, payoff_op, delay_op)` (applies to not-yet-registered flight dates; already-registered dates keep their snapshotted terms) |
| Add admin | Owner | `governance.add_admin(admin)` |
| Remove admin | Owner | `governance.remove_admin(admin)` |
| Read route status | Anyone | `governance.route_status(flight_id, origin, dest) -> RouteStatus` |
| Deposit capital (queued) | Underwriter | `risk_vault.request_deposit(caller, assets) -> request_id` (escrows; minted after the pricing delay) |
| Cancel queued deposit | Underwriter | `risk_vault.cancel_deposit(caller, request_id)` |
| Withdraw (queued) | Underwriter | `risk_vault.request_withdrawal(caller, shares) -> request_id` (escrows; priced after the pricing delay) |
| Collect credited USDC | Underwriter | `risk_vault.collect(caller)` |
| Cancel queued withdrawal | Underwriter | `risk_vault.cancel_withdrawal(caller, request_id)` |
| Read deposit queue | Anyone | `risk_vault.get_deposit_queue()` / `get_deposit_queue_len()` |
| Recover uncollected balance | Owner | `risk_vault.recover_uncollected(user, amount, mode: RecoveryMode)` (Recredit must not underpay; Transfer requires prior credit) |
| Rotate settlement-barrier oracle | Owner | `risk_vault.set_oracle(oracle)` (refuses while the current oracle has pending outcomes) |
| Force-rotate barrier oracle (old oracle unreachable) | Owner | `risk_vault.force_set_oracle(oracle)` (requires the vault paused; emits `oracle_set` with `forced = true`) |
| Pause / unpause | Owner | `<contract>.pause(caller)` / `unpause(caller)` (every production contract) |
| Read free capital (nominal margin) | Anyone | `risk_vault.get_free_capital()` |
| Read withdrawable capital (exit bound) | Anyone | `risk_vault.get_withdrawable_capital()` |
| Read vault solvency ratio (controller-mirrored) | Anyone | `risk_vault.get_solvency_ratio()` |
| Check resolved terms vs current limits | Anyone | `governance.terms_valid(terms) -> bool` (used by `buy_insurance` to re-validate a bucket's snapshotted terms) |
| Buy insurance | Traveler | `controller.buy_insurance(flight_id, origin, dest, date)` |
| View my policies | Traveler | `controller.get_flights_for_traveler(address)` |
| Claim payout | Traveler | `flight_pool_manager.claim(traveler, flight_id, date)` |
| Sweep expired claims | Anyone | `flight_pool_manager.sweep_expired(flight_id, date)` |
| Withdraw recovered (swept) | Owner | `flight_pool_manager.withdraw_recovered(amount)` |
| Read active bucket count | Anyone | `flight_pool_manager.get_active_flight_count()` (alert as it nears the list cap) |
| Push estimated arrival | Oracle | `oracle.set_estimated_arrival(oracle, flight_id, date, eta)` |
| Push landed (with actual arrival) | Oracle | `oracle.set_landed(oracle, flight_id, date, actual)` |
| Mark cancelled | Oracle | `oracle.set_cancelled(oracle, flight_id, date)` (also deletes any live sale authorization) |
| Open / refresh sale window | Oracle | `oracle.open_sale(oracle, flight_id, date, expires_at)` (required by `buy_insurance`; validity capped at 24h) |
| Close sale window early | Oracle | `oracle.close_sale(oracle, flight_id, date)` |
| Check sale window | Anyone | `oracle.is_sale_open(flight_id, date)` / `oracle.get_sale_auth(flight_id, date)` |
| Classify flights | Keeper | `controller.classify_flights(keeper)` (window of `MAX_CLASSIFY_BATCH = 25` per call) |
| Classify one exact flight | Keeper | `controller.classify_flight(keeper, flight_id, date) -> bool` (must be active-listed; no cursor dependency) |
| Execute settlements | Keeper | `controller.execute_settlements(keeper)` (window of `MAX_SETTLE_BATCH = 10` per call) |
| Execute settlements, smaller window | Keeper | `controller.execute_settlements_bounded(keeper, limit)` (limit clamped to [1, 10]; escape hatch if a full window exceeds tx resource budgets) |
| Settle one exact flight | Keeper | `controller.settle_flight(keeper, flight_id, date) -> bool` (must be active-listed; no cursor dependency) |
| Drain withdrawal queue + snapshot | Keeper | `controller.run_queue_maintenance(keeper)` |
| Toggle buyer whitelist | Owner | `controller.set_whitelist_enabled(bool)` (default off — open purchases) |
| Approve / revoke a buyer | Owner or Governance admin | `controller.add_whitelisted_buyer(caller, addr)` / `remove_whitelisted_buyer(caller, addr)` (approval carries an explicit 180-day inactivity deadline; each purchase slides it forward) |
| Check buyer approval | Anyone | `controller.is_whitelisted(addr)` (valid = added, not removed, deadline not passed) |
| Prune aged-out settled flights | Anyone | `oracle.prune_settled()` |
| Read active flight count | Anyone | `oracle.get_active_flight_count()` (alert as it nears the list cap) |
| Check flight data physically exists | Anyone | `oracle.has_flight_data(flight_id, date)` (distinguishes archived from unregistered) |
| Evict archived flight from list | Owner | `oracle.evict_missing_flight(flight_id, date, outcome_pending)` (only when FlightData is missing; after off-chain finality confirmation. Restore-and-settle is always preferred. `outcome_pending = true` iff the flight's outcome was already public — Landed/Cancelled/ToBeSettled\* per its event history — so the eviction releases the settlement-barrier count that settlement would have released; getting the flag wrong either strands the barrier or opens it early. **Eviction is step one of two** — follow with `controller.settle_evicted_flight`, or the flight's pool bucket and vault collateral stay stranded forever) |
| Settle an evicted flight's bucket | Owner | `controller.settle_evicted_flight(flight_id, date)` (terminal reconciliation after `evict_missing_flight`: settles the pool bucket with void semantics — premiums to the vault, no payout — and releases the flight's locked collateral. Requires the FlightData row to still be absent and the flight to be out of the oracle active list; do not restore the row after eviction) |
| Update keeper address | Owner | `controller.set_keeper(new_keeper)` |
| Update oracle address | Owner | `oracle.set_oracle(new_oracle)` |
| Set min withdrawal request size | Owner | `risk_vault.set_min_withdrawal_request(min_assets)` (0 disables; deployment must set a per-asset floor; enforcement clamped to TMA/2500) |
| Read queue occupancy | Anyone | `risk_vault.get_withdrawal_queue_len()` (alert as it nears the queue cap) |

---

## dApp Frontend — Sentinel Playground

The frontend is the **Sentinel Playground**, a hand-scaffolded Next.js (App Router,
TypeScript) dApp in [`playground/`](../playground/) using `@stellar/stellar-sdk` and
`@creit.tech/stellar-wallets-kit` for multi-wallet connect + signing. Contract addresses
come from [`deployments/testnet.json`](../deployments/testnet.json).

### Project Structure

```
sentinel_soroban_v3/
├── contracts/                      # Soroban smart contracts (Rust workspace)
│   ├── sentinel_types/             # Shared cross-contract types, TTL consts, active_set, test_support
│   ├── governance_module/
│   ├── risk_vault/
│   ├── flight_pool_manager/
│   ├── controller/
│   ├── oracle_aggregator/
│   ├── mock_usdc/                  # Testnet-only settlement token
│   └── integration_tests/          # Cross-contract test suite
├── executor/
│   ├── centralized_cron/           # Off-chain cron executor (see structure above)
│   └── mock-api/                   # Local AeroAPI stand-in
├── playground/                     # Next.js dApp
│   ├── app/                        # Pages: / (global state), /account, /interact
│   ├── components/                 # Header, WalletButton, FunctionForm, AddressLine
│   └── lib/                        # soroban.ts, walletKit.ts, queries.ts, registry.ts, scval.ts, config.ts
├── deployments/                    # testnet.json — addresses, wasm hashes, constructor params
├── docs/                           # Docusaurus documentation site
├── audits/                         # Audit reports + remediations
└── spec/                           # architecture.md, sequence diagrams, phase plans
```

### Auto-Generated TypeScript Bindings

Instead of generated per-contract clients, the playground drives every contract
through a curated function registry (`lib/registry.ts` — every public entrypoint
with arg specs and auth badges) plus generic RPC helpers (`lib/soroban.ts` —
read-only calls via `simulateTransaction`, writes via simulate → assemble →
wallet-sign → send → poll). Everything runs client-side; the app never touches a
secret key:

```typescript
// Read — free simulation, decoded to native JS values
const myFlights = await simulateRead(
  CONTRACTS.controller.address, 'get_flights_for_traveler', [addressToScVal(wallet)]);

// Write — single wallet signature covers the Controller call + USDC transfer
await invokeWrite(CONTRACTS.controller.address, 'buy_insurance', [
  addressToScVal(wallet), symbolToScVal('AA123'),
  symbolToScVal('DEN'), symbolToScVal('SEA'), u64ToScVal(1785542400n),
]);
```

Network configuration (testnet RPC URL, passphrase, contract addresses) lives in
`lib/config.ts`, sourced from `deployments/testnet.json`.

---

## Deployment Order

```
1. Build all contracts:
        stellar contract build          (compiles Rust -> WASM in target/)

2. Deploy contracts to Stellar (testnet or mainnet):

   a. GovernanceModule           — no dependencies
        stellar contract deploy --wasm target/.../governance_module.wasm
        -> returns CONTRACT_ID_GOVERNANCE

   b. OracleAggregator           — constructor needs: owner + authorized oracle address
        stellar contract deploy --wasm target/.../oracle_aggregator.wasm \
          -- --owner OWNER_ADDRESS --authorized_oracle ORACLE_EXECUTOR_ADDRESS
        -> returns CONTRACT_ID_ORACLE

   c. RiskVault                  — constructor needs: owner + USDC token address
                                   + OracleAggregator contract address
        (must deploy AFTER OracleAggregator — the oracle address is a
         constructor argument that wires the settlement barrier at genesis,
         so there is no unwired fail-open window between deploy and wiring)
        stellar contract deploy --wasm target/.../risk_vault.wasm \
          -- --owner OWNER_ADDRESS --asset_token <USDC_CONTRACT_ID> \
             --oracle CONTRACT_ID_ORACLE
        (the share-decimals offset is hardcoded to 3 in the constructor)
        -> returns CONTRACT_ID_VAULT

   d. FlightPoolManager          — constructor needs: owner + USDC + RiskVault address
        (must deploy AFTER RiskVault — the vault address is a constructor argument)
        stellar contract deploy --wasm target/.../flight_pool_manager.wasm \
          -- --owner OWNER_ADDRESS --asset_token <USDC_CONTRACT_ID> \
             --risk_vault CONTRACT_ID_VAULT
        -> returns CONTRACT_ID_FLIGHT_POOL_MANAGER

   e. Controller                 — constructor needs all addresses + config
        stellar contract deploy --wasm target/.../controller.wasm \
          -- --owner OWNER_ADDRESS \
             --governance CONTRACT_ID_GOVERNANCE \
             --risk_vault CONTRACT_ID_VAULT \
             --oracle CONTRACT_ID_ORACLE \
             --flight_pool_manager CONTRACT_ID_FLIGHT_POOL_MANAGER \
             --asset_token USDC_CONTRACT_ID \
             --authorized_keeper KEEPER_EXECUTOR_ADDRESS \
             --min_lead_time_secs 3600 \
             --claim_expiry_window_secs 5184000
        -> returns CONTRACT_ID_CONTROLLER
        (solvency ratio is not a constructor argument — it initializes to 100
         and is tuned afterwards via controller.set_solvency_ratio, which also
         mirrors the value into the RiskVault; call it only AFTER the vault's
         set_controller wiring below, or the mirror push will revert)

3. Post-deployment wiring:
        OracleAggregator.set_controller(CONTRACT_ID_CONTROLLER)   <- one-time, immutable
        RiskVault.set_controller(CONTRACT_ID_CONTROLLER)           <- one-time, immutable
        FlightPoolManager.set_controller(CONTRACT_ID_CONTROLLER)   <- one-time, immutable
        (RiskVault's settlement-barrier oracle is wired in the constructor,
         step 2c — no post-deploy call needed. RiskVault.set_oracle exists
         only to rotate it if the oracle contract is ever redeployed; it
         refuses while the CURRENT oracle still reports pending public
         outcomes, because a fresh oracle starts at zero pending and the
         swap would open the barrier at a stale share price mid-incident.
         If the old oracle is unreachable, pause the vault and use
         RiskVault.force_set_oracle — the vault then stays paused until the
         old oracle's pending PnL is reconciled and the owner deliberately
         unpauses. Both paths and set_min_withdrawal_request emit
         `oracle_set` (with a `forced` flag) / `min_wd_req_set` audit
         events. Note set_oracle points at the oracle CONTRACT — distinct
         from OracleAggregator.set_oracle, which sets the off-chain oracle
         executor address.)
        RiskVault.set_min_withdrawal_request(MIN_ASSETS)           <- REQUIRED: minimum asset value
                                                                      per queued withdrawal request.
                                                                      Ships disabled (0); if left at 0,
                                                                      one actor can occupy every slot of
                                                                      the bounded withdrawal queue with
                                                                      dust requests spread across many
                                                                      addresses, locking other LPs out
                                                                      of the exit path. Choose per
                                                                      underlying asset: meaningfully
                                                                      above dust, well below typical LP
                                                                      position sizes (e.g. ~100_0000000
                                                                      = 100 USDC at 7 decimals).
                                                                      Owner-updatable at any time —
                                                                      also the response lever if queue
                                                                      saturation is observed. Bounded:
                                                                      enforcement is clamped at request
                                                                      time to TMA/2500, so no configured
                                                                      value can lock positions above
                                                                      0.04% of the vault out of the
                                                                      queue.

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
        cd executor/centralized_cron && cp .env.example .env
        # Set: AERO_API_KEY, STELLAR_RPC_URL, SECRET_KEYS, contract IDs
        npm run start

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
