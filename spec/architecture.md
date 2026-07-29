# Architecture

## Table of Contents

- [System Overview](#system-overview)
- [How It Works — In Plain Language](#how-it-works--in-plain-language)
- [Contracts (all Soroban / Rust)](#contracts-all-soroban--rust)
  - [GovernanceModule](#governancemodule)
  - [RiskVault](#riskvault)
  - [FlightPoolManager](#flightpoolmanager)
  - [Controller](#controller)
  - [OracleAggregator](#oracleaggregator)
- [The Off-Chain Layer: Three Systems + a Frontend](#the-off-chain-layer-three-systems--a-frontend)
- [Off-Chain Keeper & Oracle Layer](#off-chain-keeper--oracle-layer)
  - [Job Summary](#job-summary)
  - [Cron #0 — SaleAuthorizer (Oracle, every 2 hours at :30)](#cron-0--saleauthorizer-oracle-every-2-hours-at-30)
  - [Cron #1 — FlightDataFetcher (Oracle, every 2 hours)](#cron-1--flightdatafetcher-oracle-every-2-hours)
  - [Cron #2 — FlightClassifier (Keeper, every 1 hour)](#cron-2--flightclassifier-keeper-every-1-hour)
  - [Cron #3 — SettlementExecutor (Keeper, every 5 minutes)](#cron-3--settlementexecutor-keeper-every-5-minutes)
  - [Cron #3b — QueueMaintainer (Keeper, every 5 minutes)](#cron-3b--queuemaintainer-keeper-every-5-minutes)
  - [Cron #4 — TTL Extender (instance `extend_ttl` + prune, every 24 hours)](#cron-4--ttl-extender-instance-extend_ttl--prune-every-24-hours)
  - [Why separate crons?](#why-separate-crons)
  - [The keeper/oracle interface](#the-keeperoracle-interface)
  - [Backend structure](#backend-structure)
  - [Job-Ops Layer](#job-ops-layer)
  - [Backend migration](#backend-migration)
- [Off-Chain Governance Automation](#off-chain-governance-automation)
- [Data Flow](#data-flow)
  - [The Life of One Insured Flight](#the-life-of-one-insured-flight)
  - [Whitelisting a Route](#whitelisting-a-route)
  - [Buying Insurance](#buying-insurance)
  - [Traveler Claiming a Payout](#traveler-claiming-a-payout)
  - [Sweeping Expired Claims](#sweeping-expired-claims)
  - [Owner Withdrawing Recovered Funds](#owner-withdrawing-recovered-funds)
  - [Underwriter Entering and Exiting Capital (two-phase FIFO)](#underwriter-entering-and-exiting-capital-two-phase-fifo)
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
- [dApp Frontend — FLIGHTS.FUN](#dapp-frontend--flightsfun)
  - [Project Structure](#project-structure)
  - [Generated contract bindings](#generated-contract-bindings)
  - [Pages](#pages-dappsrcpages)
- [Deployment Order](#deployment-order)
- [Admin Runbook — Route Seeding](#admin-runbook--route-seeding)
- [End-to-End Testing](#end-to-end-testing)

---

## System Overview

Decentralised flight delay insurance on **Stellar**. **Underwriters** deposit capital to back
claims; **travelers** pay a premium to receive a fixed payoff if their flight is delayed
beyond a configurable threshold (per-route `delay_hours`). All contracts are written in
**Rust** and compiled to **Soroban WASM**.

Nothing on-chain self-triggers, so scheduled off-chain jobs keep the protocol
ticking: `fetcher` writes real flight data on-chain, `sale_authorizer` attests
flights insurable, `classifier` / `settler` / `queue_maintainer` drive
classification, settlement, and the LP queues, `ttl_extender` keeps storage alive,
and two governance jobs (`gov_reconcile`, `route_agent`) manage the route rulebook.
All run today as **Vercel serverless functions** in `dapp/api/cron/`, but the
contracts don't know or care what backend calls them — each write is gated by
`require_auth()` on an **owner-updatable address** (`authorized_oracle`,
`authorized_keeper`, gov-admin), so swapping the whole backend for a TEE keeper
(Acurast, Phala) or anything else is a single owner transaction per contract, no
redeployment. Full schedule table in [Off-Chain Keeper & Oracle
Layer](#off-chain-keeper--oracle-layer); the rulebook automation in [Off-Chain
Governance Automation](#off-chain-governance-automation).

All payouts and withdrawals are **pull-based**: funds are credited on-chain and actors
claim them explicitly. Insurance is never sold unless the system has enough capital to
cover the payout — the protocol is **always solvent**.

The **Controller never holds any money** — it orchestrates everything by calling functions
on other contracts that change state and move funds.

The frontend is **FLIGHTS.FUN** (`dapp/`), a Vite + React single-page app that drives
every contract through generated TypeScript bindings and cohabits one Vercel project
with the serverless backend above. See [dApp Frontend](#dapp-frontend--flightsfun).

---

## How It Works — In Plain Language

*A newcomer's map of the whole system. Every claim here is spelled out precisely in
the sections that follow — this is the on-ramp, not the fine print.*

Sentinel is an **automated betting house for flight delays**, run entirely by smart
contracts. No company holds the money; the code does.

**The two kinds of people:**

- **Travelers** buy a policy on one specific flight. They pay a small **premium** up
  front. If that flight is delayed past a set threshold (or cancelled), they collect a
  fixed **payout**. If it lands on time, they get nothing back — like an insurance
  premium.
- **Underwriters** are "the house." They put money into a shared pot that backs those
  payouts. When flights land on time they keep the premiums as profit; when flights
  are delayed, their pot pays the claims. They earn yield for taking that risk.

**The five contracts (the on-chain machinery):**

1. **GovernanceModule — the rulebook.** Lists which flights can be insured and on what
   terms (premium, payout, and how many hours late counts as "delayed").
2. **RiskVault — the shared pot.** Holds all the underwriters' money and tracks each
   one's share. It refuses to let the system promise more than the pot can cover.
3. **FlightPoolManager — the policy cashier.** Holds each traveler's premium, remembers
   who is insured on which flight, and pays out valid claims.
4. **OracleAggregator — the scoreboard.** The single record of every flight's status:
   scheduled → landed → on-time-or-late → settled. Only a trusted data-writer can
   update it.
5. **Controller — the referee.** The only contract that gives orders. It checks the
   rulebook before a sale, moves money between the pot and the cashier, and marks
   flights settled. Crucially, **it never holds money itself** — it only directs the
   others.

**The off-chain helpers (keepers & oracle).** Smart contracts can't wake themselves
up — there is no on-chain timer. Small programs on a schedule (today, serverless
functions) do the waking:

- The **oracle** job fetches real flight data from a flight API and writes it to the
  scoreboard.
- The **keeper** jobs read the scoreboard and tell the referee to classify each
  outcome and move the money.
- A **TTL** job periodically touches storage so it doesn't expire.

Each helper proves it's allowed by **signing with a registered key**. Want to swap a
helper (say, move to tamper-proof hardware later)? You just point the contract at the
new key — the contracts themselves never change.

**"Just-in-time" (JIT) settlement — the fast path.** The scheduled helpers are the
safety net, but waiting for the next timed run adds lag — and there's a catch: from
the instant a flight's result is *public but not yet settled on-chain*, the vault
**freezes everyone's deposits and withdrawals** (so nobody can trade on a result the
pot hasn't absorbed yet). So instead of waiting for the next sweep, the moment the
oracle writes a flight's result it **immediately** pushes that one exact flight through
classification and settlement. Flights settle in seconds, and the freeze lifts fast.
The timed sweeps only mop up anything the instant path missed.

**Automated governance — a rulebook that manages itself.** Nobody hand-edits the
rulebook mid-crisis. Instead, real-world **signals** (a storm at an airport, a
geopolitical event, too much exposure on one route) are recorded as plain **facts** in
a database. Once an hour, a **reconciler** program reads those facts, decides what the
rulebook *should* say — pause a dangerous route, raise a premium, re-open it once the
storm clears — and makes exactly those changes on-chain through one audited path. A
machine-learning model can suggest baseline prices. Human admins oversee it all from a
dashboard, but they too only **write facts**; the reconciler is the only thing that
touches the chain.

That's the entire system: travelers and underwriters on one side, five contracts
holding the state and money, timed + just-in-time helpers keeping it moving, and a
self-managing rulebook on top. Everything below is the exact, audited detail.

---

## Contracts (all Soroban / Rust)

### GovernanceModule

> **In plain terms — the rulebook.** It answers one question the referee asks before
> every sale: "Is this flight allowed, and on what terms?" It stores the list of
> insurable routes and their premium / payout / delay-threshold, plus global defaults.
> Owner and admins edit it; everyone else only reads it.

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
  governance write entry points except `remove_admin`, which stays callable while
  paused so a compromised admin key can be revoked mid-incident; `route_status()` /
  `get_defaults()` reads remain available.

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
    Disabled,               // entry exists but not purchasable: approved == false,
                            // or resolved terms fail current validity rules / term limits
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
prefix), which lets indexers filter by flight at the RPC layer. `route_listed` and
`route_updated` carry **`Option<T>`** for `premium` / `payoff` / `delay_hours` — `None`
means "use default" — so the indexer can mirror option-ness in its schema (e.g. SQL `NULL`)
and re-resolve against the latest `gov_defaults` row at read time. This means a defaults
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

> **In plain terms — the shared pot.** This is where every underwriter's money lives.
> Put money in, you get **shares** (like fund units) that track your slice of the pot;
> take money out, you burn shares. It always keeps back enough to cover the payouts it
> has promised, and — to stop anyone trading on a flight result the pot hasn't absorbed
> yet — entering and exiting are **queued and priced on a delay**, not instant.

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
  `max_deposit` / `max_mint` / `max_withdraw` / `max_redeem` are overridden to return
  zero unconditionally — the immediate entry/exit paths they advertise are permanently
  disabled; the withdrawable-capital bound is enforced inside queue processing.
- **All LP entry and exit is two-phase (request → delayed pricing).** The immediate
  `deposit`/`mint`/`withdraw`/`redeem` operations are permanently disabled (they revert;
  the `max_*` views report zero): any call-time price can be stale with respect to a
  flight outcome that is publicly knowable but not yet written on-chain — the settlement
  barrier only engages once the oracle transaction lands. Instead, LPs commit value up
  front and are priced by queue processing only once their request outlives
  `LP_PRICING_DELAY_SECS` (6 h, sized above the oracle pipeline's worst-case
  observation-to-write latency with a missed-cycle margin). By pricing time, every
  outcome the oracle could have written at commitment — roughly, anything observable at
  or after landing minus 6 h — is on-chain: settled (in the price) or pending (the
  barrier holds the request queued until settlement). Outcomes publicly predictable
  before the oracle can possibly write them sit outside that horizon — see the
  pricing-delay-horizon residuals under Known Limitations. Request cancellation carries no
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
    `claimable_balance`. Underwriters call `collect()` to pull USDC. Bounded: 150
    entries (`WithdrawalQueueFull`), 20 per address, same anti-dust floor as the
    entry queue.
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
    themselves* (the queue is the only exit path), but sustained purchase demand can defer exits —
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
    MinWithdrawalRequest,      // i128 — Instance (owner-configured component of the request-value
                               // floor for both queues; 0 disables only this component — the
                               // occupancy-scaled protocol floor always applies)
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
  Instance so it shares TTL with the contract instance. The queue is drained by the
  QueueMaintainer keeper every few minutes and is hard-capped at 150 entries (the deposit
  queue at 100), keeping the shared Instance entry well under Soroban's 64 KB limit.
- **`ClaimableBalance(Address)`** is in **Persistent** storage (account-specific, not global).
  Three-layer TTL defense (per Improvement #3):
  1. **On-write extension** — Phase 8: `process_withdrawal_queue` and the Recredit path of
     `recover_uncollected` extend TTL by 60 days every time the entry is written.
  2. **Cron #4 secondary defense** — Phase 11 executor work: the off-chain TTL-extender
     cron includes `ClaimableBalance(addr)` keys in its `ExtendFootprintTTLOp` footprint,
     sourced from the off-chain indexer's `claimable_balances` table (Improvement #9, fed
     by the `sentinel.credited` / `sentinel.collected` / `sentinel.recovered` events).
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
("sentinel", "dep_req",    <owner>) → DepositRequested       (request_id, assets, queue_len)
("sentinel", "dep_cancel", <owner>) → DepositCancelled       (request_id, assets, queue_len)
("sentinel", "dep_minted", <owner>) → DepositProcessed       (request_id, assets, shares)
("sentinel", "dep_dropped", <owner>) → DepositDropped        (request_id, assets)
("sentinel", "controller_set", <controller>) → ControllerSet
("sentinel", "oracle_set", <oracle>)          → OracleSet (forced: bool — true when force_set_oracle skipped the rotation-safety checks)
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

> **In plain terms — the policy cashier.** One contract for every flight. It takes in
> each traveler's premium and holds it, remembers who bought a policy on which flight,
> and — after a flight is settled as delayed or cancelled — lets those travelers come
> **claim** their payout. Money the referee tells it to; travelers pull their own
> payouts (nobody pushes money at them). Unclaimed payouts eventually expire and become
> protocol revenue.

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
- **Swept funds are protocol revenue — a deliberate economic choice underwriters should
  know.** Each swept payoff has two components: the buyer's own premium (held by the pool
  since purchase) and the `(payoff - premium)` top-up the vault transferred at settlement.
  That second component was funded from LP capital and recognized as an LP loss when the
  flight settled; when the claim then expires unclaimed, the recovered value accrues to the
  owner via `withdraw_recovered` rather than flowing back to the vault. Underwriters
  therefore bear the full settlement loss even for claims that are never collected. The
  alternative — routing the vault-funded component back through `record_premium_income` to
  make LPs whole on expired claims — was considered and not taken: unclaimed payoffs are
  expected to be rare (travelers claim what they are owed), and a single owner-facing
  recovery pot keeps the sweep path accounting-only and trivially auditable. Revisit if
  expiry volume ever becomes material.
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

// Permissionless housekeeping: trims a fully-settled flight left in the active
// set (returns true if it removed one). Tolerant of archived active-set pages.
fn reconcile_settled_active_entry(env: Env, flight_id: Symbol, date: u64) -> bool;

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
| `Buyer(id, date, addr)` | Persistent | Fixed 180-day (network-max) TTL at write, never re-extended — claim expiry is unknown at purchase time, and 180d exactly covers the worst case (90-day booking horizon + the pool's 90-day date-anchored claim-deadline cap, compile-time-asserted) |
| `Claimed(id, date, addr)` | Persistent | Fixed 180-day (network-max) TTL at write, never re-extended |

---

### Controller

> **In plain terms — the referee.** The only contract that gives orders, and the one a
> traveler actually calls to buy. On a purchase it checks the rulebook, confirms the pot
> can cover the payout, and sends the premium straight to the cashier. On settlement it
> reads the scoreboard and moves money between the pot and the cashier. It **touches
> every other contract but never keeps a cent itself.**

The system orchestrator. **Never holds USDC** — routes premiums directly from the traveler
to FlightPoolManager via the Soroban token `transfer()` interface. The Controller orchestrates
everything: it calls functions on other contracts that change state and move money.

**Responsibilities:**

1. **Validate routes** against GovernanceModule before every purchase.
2. **Read terms** (premium, payoff, delay_hours) from GovernanceModule (with defaults resolved).
3. **Register flights** on FlightPoolManager on first purchase for a given `(flight_id, date)`.
4. **Gate purchases** behind a solvency check, a configurable `minimum_lead_time`
   (default 1 hour), and a fixed 90-day maximum booking horizon (bounds the policy
   lifecycle inside the buyer key's fixed 180-day TTL).
5. **Route USDC premiums** from travelers to FlightPoolManager.
6. **Classify flights** via `classify_flights()` — read OracleAggregator for flights with
   `Landed` or `Cancelled` status, read FlightPoolManager `delay_hours`, compute outcome, and
   set the appropriate `ToBeSettled*` status on OracleAggregator. The same pass voids
   `NotInitiated` rows ≥ 14 days past departure and `Active` rows ≥ 14 days past their
   recorded scheduled arrival — classified straight to `ToBeSettledOnTime` (premiums to
   the vault, no payout), emitting `voided` / `timed_out` diagnostics.
7. **Execute settlements** via `execute_settlements()` — process flights in `ToBeSettled*`
   status in a bounded rotating window (at most `MAX_SETTLE_BATCH = 10` per call): move
   money between FlightPoolManager and RiskVault, mark flights as `Settled`. Larger
   backlogs drain across successive keeper calls; `execute_settlements_bounded(keeper,
   limit)` lets an operator shrink the window down to one flight if a full window ever
   exceeds transaction resource budgets.
8. **Drain both LP request queues + share-price snapshot** via the separate keeper
   entry point `run_queue_maintenance()` (audit M-03 split) — deposits first, so fresh
   mints can fund matured exits in the same pass. Decoupled from `execute_settlements`
   so queue payouts can't be blocked by settlement gas pressure.
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
    dormant one expires by the ledger clock and must be re-attested. Deadline slides
    emit no event (and are skipped while the stored deadline is within a 10-day
    refresh interval), so dormancy monitors must reconstruct the deadline as
    `latest(buyer_whitelisted event, last GATED InsuranceBought by the address) +
    180 days` — "gated" meaning a purchase made while the whitelist was enabled
    (`whitelist_toggled` events delimit those periods; purchases made while the
    gate was off never slide the deadline). Watching `buyer_whitelisted` events
    alone false-alarms on active buyers; `is_whitelisted` is the on-chain truth
    at any instant. The deadline is
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

> **In plain terms — the scoreboard.** It records where every flight is in its life:
> *registered → flying → landed (or cancelled) → classified on-time/late → settled*. The
> status only ever moves **forward**, never backward. The trusted oracle job writes the
> raw facts (scheduled time, actual landing time); the referee writes the outcome and
> marks it settled. It also holds short-lived "this flight is insurable right now"
> stamps (**sale windows**) that a purchase requires, and a counter of results that are
> public-but-not-yet-settled — the signal that freezes the vault.

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
  (the unset sentinel), arrivals before the departure day's midnight, and arrivals
  implausibly far after it — past `date + 3 days` for the scheduled arrival, past
  `date + 30 days` for the actual — are rejected (`InvalidTimestamp`). The upper
  bounds exist for unit confusion: a milliseconds-for-seconds timestamp from a
  future executor backend passes every lower bound but would irreversibly corrupt
  the delay classification (a ~10¹²-second "delay" pays every flight; a
  ms-scale ETA classifies every delayed flight on-time). Early arrivals
  (`actual < estimated`) are deliberately **accepted** — they are legitimate
  flight outcomes, and rejecting them would strand such flights `Active` forever
  (never classifiable, collateral locked). The delay math in `classify_flights`
  saturates a negative delay to zero, so an early arrival classifies as on-time.
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
  entry point; `prune_settled`, `close_sale`, and `extend_ttl` stay open — the first
  two as housekeeping/revocation paths that must survive a pause.

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
                 flight_id: Symbol, date: u64);            // NotInitiated/Active ->
                                                           // Cancelled (pre-purchase
                                                           // tombstone incl.); also
                                                           // deletes any live
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
                     status: FlightStatus);                // Landed/Cancelled -> ToBeSettled*;
                                                           // also the timeout-void edges
                                                           // NotInitiated/Active ->
                                                           // ToBeSettledOnTime
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

## The Off-Chain Layer: Three Systems + a Frontend

Everything off-chain is **three systems with deliberately different trust
postures**, plus the user-facing frontend. The detailed sections follow; this
is the map.

### 1. Keepers — open-source, anyone can run one

The settlement muscle: `classifier`, `settler`, `queue_maintainer`,
`ttl_extender`. Keepers move **no new information on-chain** — they only
execute what the oracle already attested (classify → settle → queue/TTL
housekeeping), and the contracts re-verify everything. That is why this is
the **decentralization target**: running a keeper needs only a Stellar RPC
URL and a funded key — no AeroAPI, no database, no permission from us
(see "Run a keeper bot yourself" in [dapp/README](../dapp/README.md)). A
stalled keeper costs latency, never correctness.

### 2. Oracle — centralized trust root, ours by design

The two jobs that put facts on-chain: the **sale authorizer** (attests
which flight-days are insurable — sales fail closed without it) and the
**flight data fetcher** (writes ETAs, landings, corroborated cancellations
via AeroAPI). This is the protocol's trust root; its key is the
`authorized_oracle` address, and its future trust upgrade is a TEE backend
(Acurast/Phala) taking over the same address — not multi-party operation.
The oracle **must run with no database** (the DB-optional invariant below);
it may *opportunistically* use the DB as a `/schedules` response cache and
for run telemetry, but degrades to direct API calls without it.

### 3. Governance — centralized automation with two subsystems

The rulebook manager: collectors write **facts** (weather forecasts, live
airport delays, exposure concentration, ML pricing anchors, schedule
drift) as self-expiring `signals`; the hourly **reconciler** decides within
rails; the **GovSubmitter** — the single audited actor — writes on-chain.
Humans set appetite (rails, defaults, term limits) and keep emergency
controls (freeze, pins). Two subsystems:

- **The ML prediction service** (`agent/`, Render service
  `flight-delay-predictions`) — a pure, insurance-blind FastAPI:
  route + date + time in, calibrated covered-event probability out. The
  premium math lives protocol-side. Details:
  [The ML prediction service](#the-ml-prediction-service-render-hosted).
- **The Supabase DB** — the governance system's memory, audit trail, and
  coordination point: the route registry the reconciler evaluates,
  self-expiring `signals`, the `actions_log`/`pause_events` audit trail,
  runtime brakes (`ops_flags.gov_frozen`), the policies/settlements event
  mirror (durable history past RPC retention), `cron_runs` telemetry, and
  the AeroAPI response cache. **It is NOT strictly needed**: only the
  governance tier requires it — without the DB, automated governance
  simply stops *safely* (no signals → no actions; on-chain terms and
  statuses persist unchanged) while sales, settlement, claims, and manual
  governance (owner/admin calls and scripts) continue untouched. Signals
  self-expire (~26h), so a DB outage leaves no stale automation state to
  clean up on recovery. In short: without the DB the protocol *works*;
  with it, the protocol *governs itself*.

### 4. Frontend

The FLIGHTS.FUN SPA plus the hidden `/admin` console — same Vercel project
as the crons. Details: [dApp Frontend](#dapp-frontend--flightsfun).

**The invariant tying it together:** keepers and oracle must run DB-less
(the hermetic E2E suite enforces this every run); only governance may
require the DB — because the governance tier essentially *is* the DB plus
one signer.

## Off-Chain Keeper & Oracle Layer

> **In plain terms — the helpers on a timer.** The contracts are patient machines that
> only act when someone calls them; nothing on-chain can start itself. These jobs are
> the callers. The **oracle** job goes out to a flight API and writes what really
> happened onto the scoreboard. The **keeper** jobs then nudge the referee to classify
> and settle. A **TTL** job keeps storage from expiring. Each one signs with its own
> key, so if you ever replace a job you just register the new key — the contracts are
> none the wiser.

Nothing on-chain self-triggers — Soroban has no scheduler. A set of off-chain jobs
must poll flight data, drive the settlement pipeline, keep storage alive, and
automate governance. All of them are **backend-agnostic**: every contract gates
its writes with `require_auth()` on an owner-updatable address
(`authorized_oracle`, `authorized_keeper`), so the jobs prove identity by signing,
and the whole backend can be swapped with a single owner transaction per contract —
no redeployment, no contract knowledge of *which* backend is calling.

**Current backend: Vercel serverless functions.** The jobs run as scheduled
serverless handlers under [`dapp/api/cron/`](../dapp/api/) — one file per job, each
a thin wrapper around a runtime-agnostic implementation in `dapp/api/_lib/jobs/`
(settlement path) or `dapp/api/_lib/governance/` (governance automation). Stack:
TypeScript + `@stellar/stellar-sdk` talking to Stellar RPC, backed by a Supabase
Postgres for off-chain state (governance signals, run history, exposure mirror).
The frontend and this backend cohabit the **same Vercel project** (`dapp/`): the
SPA is served from `dist/`, the jobs from `/api/*` (see the SPA-vs-API rewrite in
`dapp/vercel.json`).

> **History.** An earlier `executor/centralized_cron/` service (node-cron +
> Express) was **deleted 2026-07-19** — it covered only the settlement-path jobs
> and was superseded by these Vercel crons, which additionally carry the
> governance automation. The old AeroAPI fixture moved to
> [`tools/mock-aeroapi/`](../tools/mock-aeroapi/) (keyless mock, port 3001) for
> local demos via `AEROAPI_BASE_URL`. A decentralized TEE backend (Acurast/Phala)
> remains a future option — it would wrap the same `_lib/jobs` modules in its own
> harness and take over the authorized addresses.

**The canonical job list lives in code, not config.** `JOB_REGISTRY` in
[`dapp/api/_lib/governance/runs.ts`](../dapp/api/_lib/governance/runs.ts) is the
single source of truth for every job's name, schedule, and signer key.
`dapp/vercel.json`'s `crons` block mirrors it when the backend is deployed — but is
**currently removed on purpose**: the present Vercel deploy is frontend-only
(`dapp/.vercelignore` excludes `api/` while the backend is WIP; restore the crons
block and delete `.vercelignore` to re-enable). Every run, scheduled or manual, is
recorded to the Supabase `cron_runs` table (see [Job-Ops Layer](#job-ops-layer)).

### Job Summary

The registry defines nine jobs. Six drive the settlement path and storage (this
section); two automate governance (`gov_reconcile`, `route_agent` — see [Off-Chain
Governance Automation](#off-chain-governance-automation)); `health` is a liveness
probe. Four signer roles keep blast radius separated: **oracle** writes flight
data, **keeper** drives classification/settlement, **ttl** extends storage,
**gov-admin** writes governance. Each address is owner-updatable on-chain.

| Job (registry name) | Endpoint | Schedule | On-chain target | Signer |
|------|------|-----------|-----------------|--------|
| `fetcher` | `/api/cron/fetcher` | `0 */2 * * *` (every 2h) | `OracleAggregator.set_estimated_arrival` / `set_landed` / `set_cancelled` | oracle |
| `sale_authorizer` | `/api/cron/authorize` | `30 */2 * * *` (every 2h, :30) | `OracleAggregator.open_sale` / `close_sale` / `set_cancelled` | oracle |
| `classifier` | `/api/cron/classify` | `0 * * * *` (hourly) | `Controller.classify_flights` | keeper |
| `settler` | `/api/cron/settle` | `*/5 * * * *` (every 5 min) | `Controller.execute_settlements` | keeper |
| `queue_maintainer` | `/api/cron/queue` | `2-59/5 * * * *` (every 5 min, +2) | `Controller.run_queue_maintenance` | keeper |
| `ttl_extender` | `/api/cron/ttl` | `0 0 * * *` (daily) | `extend_ttl` ×5 + `OracleAggregator.prune_settled` | ttl |
| `gov_signals` | `/api/cron/gov-signals` | `5 * * * *` (hourly, :05) | — (facts only: AeroAPI `/airports/delays` → Supabase `signals`) | none |
| `gov_exposure` | `/api/cron/gov-exposure` | `7 * * * *` (hourly, :07) | — (facts only: on-chain liability concentration → `exposure` signals) | none |
| `gov_reconcile` | `/api/cron/gov-reconcile` | `10 * * * *` (hourly, :10) | `GovernanceModule.disable_route` / `enable_route` / `update_route_terms` (fleet guardrails: `ops_flags.gov_frozen` runtime brake, mass-disable circuit breaker, flap damping) | gov-admin |
| `gov_onboard` | `/api/cron/gov-onboard` | `15 */6 * * *` (6-hourly, :15) | — (fleet STATUS sync only: file/chain→DB; route intake is the manual admin pipeline in `scripts/`, never a cron) | gov-admin |
| `route_agent` | `/api/cron/agent` | `0 6 * * *` (daily 06:00 UTC) | facts only: `pricing` + `weather` signals (no chain writes) | — |
| `health` | `/api/cron/health` | liveness probe | — | — |

The `:30` and `+2` offsets keep the two oracle jobs (and the two keeper jobs) off
the same minute to avoid Stellar sequence-number contention; `gov_signals` (:05)
and `gov_exposure` (:07) run just before `gov_reconcile` (:10) so every
reconcile tick acts on a fresh airport-delay AND exposure picture. One registry
name (`gov_schedule_check`) remains a placeholder that rejects as "not
implemented" (it needs AeroAPI schedule comparison).

**Three tiers, one decentralization target.** The jobs split into
**governance** (gov_signals/gov_reconcile/route_agent — centralized, ours by
design), **oracle** (fetcher/sale_authorizer — the centralized trust root:
they spend AeroAPI calls and attest real-world facts), and
**keepers/liquidators** (classifier/settler/queue_maintainer/ttl_extender —
they move no new information on-chain, only execute what the oracle already
attested). **Only the keeper tier is open-source-and-anyone-can-run**: every
job runs standalone via `npm run bot -- <name>`, `ttl_extender` is
permissionless today, and the planned bounty upgrade (spec/TODO.md §E) makes
the remaining keeper entry points permissionless-and-paid. **Governance and
oracle stay centralized** — the oracle's future trust upgrade is a TEE
backend (address rotation, unchanged contracts), not permissionless
operation.

**Optional by design — the system runs without them:**

- **The database is optional (DB-optional invariant).** The oracle and
  keeper tiers never require the governance DB: with `GOVERNANCE_DB_URL`
  unset they run fully (run-history recording is skipped), and with the DB
  down, recording fails silently while the job still completes its on-chain
  work — the e2e suite runs the entire settlement pipeline with no database
  attached. Only the governance tier requires the DB, because that tier *is*
  the DB (signals, audit log, route registry). A dead Supabase degrades
  governance to manual admin ops; purchases, attestation, settlement,
  claims, and TTL are untouched. Any future DB feature (e.g. the planned
  AeroAPI response cache) must degrade to direct calls, never gate.
- **The webhook is optional.** The planned AeroAPI push-alert webhook
  (spec/TODO.md §B) only improves cancellation/arrival *latency* from hours
  to seconds — polling remains the guaranteed base layer and the
  reconciliation path for missed alerts. If both webhook and polling die,
  sale windows self-expire (≤6h on-chain cap) and sales fail closed. The
  webhook must never become a single point of failure.

### Cron #0 — SaleAuthorizer (Oracle, every 2 hours at :30)

Keeps the purchase gate's sale windows attested. `buy_insurance` requires a
live, unexpired `open_sale` authorization — absence of an on-chain outcome is
not evidence the real flight is insurable (a publicly cancelled flight looks
identical to a valid unreported one until the cancellation write lands), so
the oracle attests insurability affirmatively and purchases fail closed
without it.

The flight list is derived from the enabled routes in
`config/routes.testnet.json` (env `SALE_AUTH_HORIZON_DAYS` overrides the
file's `sale_horizon_days`). Each run attests every (flight, day) in the
horizon, **split by AeroAPI visibility** (`/flights/{ident}` only accepts
queries within 10 days past → 2 days future):

**Near window (days 1–2) — live tracking data via `GET /flights/{ident}`:**

1. queries AeroAPI for the (flight, day) instance;
2. on a cancellation signal, revokes any live window with the pause-exempt
   `close_sale` FIRST (safe on the bare `cancelled` flag — fail closed), then
   pushes the `set_cancelled` tombstone **only when corroborated**: AeroAPI's
   `cancelled` flag alone means "no longer tracked", which the spec says "will
   not always" be an airline cancellation — and the tombstone pays every
   buyer, so it additionally requires a cancelled status text. A bare flag is
   logged for ops and retried;
3. `close_sale`s a window whose instance became unverifiable (no data /
   ambiguous candidates) — fail closed, never guess;
4. otherwise opens/refreshes the window with expiry
   `min(flight date, now + SALE_AUTH_VALIDITY_SECS)` (default 6h; the
   contract caps validity at 24h).

**Far window (days 3..horizon) — published schedules via `GET /schedules`:**
one call per ≤20-day chunk (the endpoint sees up to 1 year out, ≤3-week
windows, filtered by airline + flight number + route origin/destination)
attests which days the airline has published the flight for. Exactly one
instance on a day → open/refresh; verified absent → close; more than one →
ambiguous, fail closed; the schedules *call itself* failed → no action (live
windows lapse within their ≤6h validity rather than being mass-revoked by a
transient API error). Published-schedule existence deliberately does NOT
attest "not cancelled" — cancellation detection lives on live tracking data
in the near window and the fetcher's watch window.

Call economy: per flight per run ≈ 2 `/flights` calls + `ceil((horizon−2)/20)`
`/schedules` calls — ~7 calls for a 90-day horizon instead of 90 (the old
per-day sweep also queried `/flights` for days it structurally cannot see,
so days 3+ never opened at all).

Ops invariants:

- **The routes file must track the governance route whitelist.** A
  whitelisted route missing/disabled in the file is never sellable.
- **Cadence must stay well inside the validity window**, or every sale
  window lapses between runs and sales halt protocol-wide. That halt is the
  intended fail-safe when the authorizer is down — availability degrades,
  never safety.
- Far-window attestation needs a parsable ident (airline + flight number,
  e.g. `UA100`/`UAL100`); unparsable idents keep near-window attestation and
  their far days stay closed.
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
    +-> reads the oracle active set + get_flight_data per flight
    |
    +-> Step A: For flights in NotInitiated status:
    |       PHASE GATE (no API call): skip if flight date > now + 2d
    |         (/flights/{ident} cannot see further future schedule — the call
    |          could never succeed) or if now > date + 10d (past the API's
    |          history window; the stale-void timeout reclaims the row)
    |       calls AeroAPI for the day's instance
    |       +- confirmed cancellation (cancelled flag AND cancelled status)
    |       |    -> set_cancelled (NotInitiated -> Cancelled)
    |       |    -> targeted classify_flight + settle_flight
    |       +- cancelled flag WITHOUT corroborating status -> log + retry
    |       |    (tracking gap, not proof — the tombstone pays every buyer)
    |       +- otherwise signs + submits:
    |            OracleAggregator.set_estimated_arrival(flight_id, date,
    |                                                   scheduled_in)
    |            (NotInitiated -> Active)
    |
    +-> Step B: For flights in Active status:
    |       PHASE GATE (no API call): skip until
    |         now >= estimated_arrival − FETCHER_WATCH_SECS (default 6h);
    |         skip after estimated_arrival + 10d (history window passed —
    |         the active-void timeout reclaims the row)
    |       inside the watch window, calls AeroAPI every cycle:
    |           |
    |           +- confirmed cancellation -> set_cancelled
    |           |    (Active -> Cancelled) + targeted classify + settle
    |           +- cancelled flag, uncorroborated -> log + retry
    |           +- confirmed diversion -> set_cancelled  (POLICY: diverted
    |           |    pays as cancellation; actual_in is the DIVERSION
    |           |    airport's arrival and is never attested as a landing)
    |           +- diverted flag, uncorroborated -> log + retry
    |           +- before estimated_arrival + 1h -> cancellation watch only
    |           +- actual_in present -> set_landed(actual_in)
    |           |    (Active -> Landed) + targeted classify + settle
    |           +- still in flight / HTTP error -> skip, retry next cycle
```

**Why the watch window?** Nothing between the ETA write (T-2d) and shortly
before arrival can produce an attestable outcome except a cancellation, and
the pre-departure cancellation check lives inside the window (sale windows
never extend past the departure-day boundary, so the gap adds no purchase
exposure). A flight therefore costs ~1 call at T-2d plus ~3–6 calls around
arrival — and **zero** calls the rest of its life, regardless of how far
ahead it was bought.

**Why the extra 1-hour buffer?** Landing resolution only starts 1 hour after
the scheduled arrival — flights still in the air need no landing query, and
AeroAPI gets time to record final gate-arrival data.

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
                |
                +- NotInitiated >= 14d past departure, or Active >= 14d past
                   recorded scheduled arrival -> voided:
                   oracle.set_to_be_settled(flight_id, date, ToBeSettledOnTime)
                   (premiums to the vault, no payout)
```

**Why separate from settlement?** Classification is a read-heavy operation (reads oracle
data + FlightPoolManager terms). Settlement is a write-heavy operation (moves money). Separating
them allows the classification to run less frequently (1 hour) while settlement runs more
frequently (5 minutes) to process the queue quickly.

Pre-flight skip: when the oracle active set is empty
(`get_active_flight_count() == 0`) there is nothing to classify, void, or
diagnose — the run submits no transaction. With any flights listed the
hourly sweep always runs, because it also carries the 14-day timeout voids
and `ttl_miss` diagnostics, which need the pass even when nothing is
Landed/Cancelled yet.

**Targeted "just-in-time" fast path — the primary latency route.** The hourly and
5-minute sweeps are the *backstop*, not the main path. Whichever job writes an
outcome doesn't wait for the next sweep: the moment `fetcher`/`sale_authorizer`
lands a `set_landed` / `set_cancelled`, the off-chain `classifyAndSettleFlight`
helper (`dapp/api/_lib/targeted_settlement.ts`) immediately drives that *exact*
`(flight_id, date)` tuple through two dedicated on-chain entry points —
`controller.classify_flight(keeper, flight_id, date)` then
`controller.settle_flight(keeper, flight_id, date)`. Both are keeper-gated, take an
exact tuple (no cursor scan), require the flight to be active-listed, and are
idempotent (each returns a `bool` reporting whether a transition actually ran). So a
fresh outcome normally classifies and settles within seconds, **independent of
active-set size** — which matters because the vault's settlement barrier (see
`PendingOutcomes`) freezes every LP entry/exit protocol-wide from the instant an
outcome is written until it settles. The sweeps (`MAX_CLASSIFY_BATCH = 25` /
`MAX_SETTLE_BATCH = 10` per call, rotating cursors) exist only to repair anything
the targeted call missed (paused controller, RPC glitch).

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
reaches zero. When nothing is pending the run submits no transaction at all
(the pre-flight check is a free simulation read — the on-chain empty path
still writes TTL extensions, so a blind submit is a real fee). If
`execute_settlements` fails (a window exceeding per-tx resource budgets),
the run falls back to `execute_settlements_bounded` with windows 3 then 1 —
the contract's escape hatch, now automated — and two no-progress passes end
the run as FAILED so the stall surfaces on the jobs board instead of
silently burning fees.

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

Pre-flight skips (free simulation reads, no tx submitted): while the vault's
settlement barrier is engaged (`get_pending_outcomes() > 0`) the on-chain
queue processors early-return anyway, so the run skips — clearing the
barrier is the settler's job; and when both LP queues are empty AND today's
share-price snapshot already exists (`get_snapshot_price(today) > 0`) there
is nothing the call could do, so it skips too.

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
    +-> calls OracleAggregator.prune_settled() in a drain loop
            (each call evicts at most MAX_PRUNE_BATCH = 60 slots from a
             rotating cursor over the whole active set; the job repeats the
             call while get_active_flight_count keeps dropping, so each
             daily run fully clears whatever has aged past the 7-day
             retention window — a backlog spike can't outrun one pass/day)
```

Per-flight Persistent entries (`FlightConfig`, `FlightData`) are self-extending: their
TTL is bumped on every contract read/write that touches them. Deeper key-level TTL
extension via a raw Soroban `ExtendFootprintTTLOp` (covering idle `FlightConfig` /
`FlightData` / `Route` / `TravelerFlights` / `ClaimableBalance` entries enumerated
off-chain) is a planned, separate executor concern — not part of this cron. Archived
Persistent entries remain restorable via `RestoreFootprintOp` in the meantime.

### Why separate crons?

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

### The keeper/oracle interface

Every job is the same shape — read on-chain + external state, sign, submit over
Stellar RPC. The logic is **runtime-agnostic TypeScript** in `dapp/api/_lib/jobs/`;
the Vercel handlers in `dapp/api/cron/` are ~10-line wrappers
(`export default makeCronHandler(run)` + `config = { maxDuration: 300 }`). A
different backend (TEE workers, a long-running node) wraps the same modules in its
own scheduler.

```
fetcher (signer: oracle)
  1. Read OracleAggregator active set (paged) + get_flight_data per flight
  2. NotInitiated, within T-2d -> AeroAPI schedule -> set_estimated_arrival
     (-> Active; earlier flights cost ZERO calls — outside API visibility)
  3. Active, inside the watch window (ETA - 6h .. ETA + 10d) -> AeroAPI
     status -> set_landed / set_cancelled (+ targeted classify + settle)
  4. Corroborated cancellation OR diversion seen in a watched phase ->
     set_cancelled (diverted pays as cancellation, by policy); flag-only
     signals are never attested

sale_authorizer (signer: oracle)
  Days 1-2: live /flights check  -> open_sale / close_sale / set_cancelled
  Days 3+:  published /schedules -> open_sale / close_sale (chunked, ~5 calls/90d)
    (affirmative "this flight is insurable" attestation;
     buy_insurance fails closed without a live window)

classifier / settler / queue_maintainer (signer: keeper)
  Build + sign + submit one Controller call:
    classify_flights | execute_settlements | run_queue_maintenance

ttl_extender (signer: ttl)
  extend_ttl() on all five contracts, then OracleAggregator.prune_settled()
```

Shared plumbing lives in `dapp/api/_lib/`: `soroban_client.ts` (build/sign/submit
via `@stellar/stellar-sdk`; contract IDs from env, defaulting to
`deployments/testnet.json`), `aeroapi_client.ts` (FlightAware AeroAPI, or the
keyless `tools/mock-aeroapi` via `AEROAPI_BASE_URL`), `weather_client.ts`
(Open-Meteo), `agent_client.ts` (the ML prediction service), and the `governance/`
subsystem.

### Backend structure

```
dapp/
├── api/                          # Vercel serverless backend (same project as the SPA)
│   ├── cron/                     # one thin handler per scheduled job
│   │   ├── fetcher.ts  authorize.ts  classify.ts  settle.ts  queue.ts  ttl.ts
│   │   ├── gov-reconcile.ts  agent.ts        # governance automation
│   │   └── health.ts                         # liveness probe
│   ├── admin/                    # authenticated ops API (Supabase JWT + email allowlist)
│   │   └── actions.ts  jobs.ts  routes.ts  signals.ts
│   ├── status/runs.ts            # PUBLIC sanitized job-health feed
│   └── _lib/
│       ├── jobs/                 # runtime-agnostic settlement-path job logic
│       │   ├── fetcher.ts  authorizer.ts  classifier.ts  settler.ts
│       │   └── queue.ts  ttl.ts  route_agent.ts
│       ├── governance/           # governance automation subsystem (see next section)
│       │   ├── reconciler.ts  rules.ts  submitter.ts  model.ts
│       │   └── db.ts  config.ts  action_log.ts  admin_auth.ts  runs.ts
│       ├── soroban_client.ts  aeroapi_client.ts  weather_client.ts
│       └── agent_client.ts  targeted_settlement.ts  config.ts  handler.ts
├── packages/                     # generated TS contract bindings, one per contract
├── src/                          # the React SPA (see "dApp Frontend")
└── vercel.json                   # framework: vite; /api/* -> functions, everything else -> SPA

supabase/migrations/              # governance_core.sql + cron_runs.sql
agent/                            # Python XGBoost prediction service (Render-hosted)
tools/mock-aeroapi/               # keyless AeroAPI mock for local demos
```

### Job-Ops Layer

Every job — cron-triggered or hand-run — funnels through one wrapper
(`makeCronHandler` / `makeGovCronHandler`, `dapp/api/_lib/handler.ts` +
`governance/config.ts`) that authorizes the request (a shared `CRON_SECRET`), runs
the job, and — **best-effort only** (`recordRun` no-ops without
`GOVERNANCE_DB_URL` and swallows DB errors; a history blip never fails a job
that did its on-chain work) — appends a row to the Supabase `cron_runs` table (job
name, trigger = `schedule | external | manual:<email>`, duration, success/error,
actions). Two surfaces read that history:

- **`/admin` JOBS board** (`api/admin/jobs.ts`, authenticated) — lists the
  `JOB_REGISTRY` with each job's latest + recent runs, plus a POST that runs any job
  **now**, on the same code path as its cron, recorded as `manual:<email>`.
- **`/status` page** (`api/status/runs.ts`, public) — a **sanitized** feed: job
  identity, schedule, last-run time, duration, pass/fail only. No error text, action
  payloads, or actor attribution — those stay behind auth.

### Backend migration

Because every write is gated on an owner-updatable address, migrating the backend
(e.g. Vercel -> TEE workers) is **zero-downtime, no-redeployment**:

```
1. Stand up the new backend (new Vercel project, TEE workers, etc.)
2. Read its Stellar public key(s) — oracle, keeper, ttl, gov-admin
3. Fund the new account(s) with XLM
4. Run both backends in parallel (only the currently-authorized keys succeed)
5. Rotate the authorized addresses:
     owner -> OracleAggregator.set_oracle(new_oracle_address)
     owner -> Controller.set_keeper(new_keeper_address)
     owner -> GovernanceModule.add_admin(new_gov_admin) / remove_admin(old)
     (the ttl signer needs no rotation — extend_ttl is permissionless)
6. Verify the new backend's txs land on-chain
7. Retire the old backend
```

During the dual-running window both backends submit, but only the authorized keys
succeed — unauthorized transactions fail the auth check with no side effects and no
double execution. Rollback = point the addresses back.

**Rotation as a compromise response needs one extra step.** Sale authorizations the
outgoing oracle opened live in temporary storage (not enumerable on-chain) and survive
`OracleAggregator.set_oracle`: they keep authorizing purchases until each expires (up to
24 h) or is individually closed. Routine migrations can ignore this — the windows are
honest. If the rotation is revoking a compromised oracle key, the new oracle must
immediately sweep `close_sale` over every window still open (reconstructed from the
`SaleOpened`/`SaleClosed` event stream), or the Controller must be paused for the full
24 h validity horizon — otherwise the attacker's parting attestations (including windows
on publicly cancelled flights, each a deterministic claim once the cancellation is
recorded) stay purchasable after the key swap.

---

## Off-Chain Governance Automation

> **In plain terms — the rulebook manages itself.** The GovernanceModule *stores* the
> rules, but something has to *decide* them: raise a premium when a storm is brewing,
> pause a route that's gotten too risky, re-open it when things calm down. That
> decision-making is this off-chain system. It works like a newsroom with one editor:
> anyone can file a **fact** ("storm at DEN", "too many policies on this route"), but
> only one careful **editor** (the reconciler) decides what to actually publish to the
> chain — and it double-checks against the live on-chain state every time, so a hiccup
> never leaves things half-done.

The `GovernanceModule` contract is the on-chain route authority (terms, whitelist,
lifecycle), but the *decisions* — which routes to disable in a storm, how much to
raise a premium when risk spikes — are made off-chain and pushed on-chain by
automated jobs. The design has one governing principle:

> **Humans and collectors never call the chain directly. They write *facts* into
> Supabase; one idempotent reconciler is the sole actor; every mutation flows
> through a single audited choke point.**

The whole subsystem signs with a dedicated **gov-admin key** — a fourth identity,
distinct from the contract owner and from the oracle/keeper — registered on the
module via `GovernanceModule.add_admin`. (On testnet this `add_admin` is still
pending the owner key, so the reconciler runs with `GOV_DRY_RUN=true`: it computes
and logs every decision but submits nothing. See below.)

### What data is held (Supabase, `supabase/migrations/`)

The database serves the **governance tier only** — the oracle and keeper
jobs run fully without it (see the DB-optional invariant in the keeper
layer). It is never on the purchase/settlement money path: a dead database
degrades governance automation to manual admin operations and nothing else.

All tables have RLS enabled with **zero policies (deny-all)** — only the server-side
Vercel functions reach them, over the Supavisor transaction pooler. Row types are
mirrored in `dapp/api/_lib/governance/model.ts`.

| Table | Role |
|---|---|
| `routes` | One row per insurable route (`flight_id+origin+dest` = the on-chain key). Holds admin-set **base/anchor terms**, canonical schedule (for drift detection), the `status` lifecycle (`candidate/active/disabled/removed`), and the **admin pin** (`pinned`, `pin_until`). The reconciler treats pin + lifecycle as law. |
| `signals` | **Layer-1 facts.** Collectors and admins write here; only the reconciler acts on them. `type` (weather / geopolitical / exposure / schedule_drift / manual), `scope_kind` (route / origin / dest), `severity` (`info` / `elevated` / `severe`), `payload` jsonb (e.g. `{factor}`), `expires_at`, `cleared_at`. Active = uncleared and unexpired. |
| `pause_events` | History of every pause enacted on-chain, with the causing `signal_id`; `ended_at` on re-enable. The reconciler only auto-re-enables a route whose *own* pause_event is still open. |
| `premium_adjustments` | Every premium change (base, multiplier stack, clamped result). Doubles as the **hysteresis / one-change-per-day** record. |
| `actions_log` | **Append-only audit** of every on-chain governance call (actor, action, tx hash, before/after `route_status` snapshots, success/error). No update or delete path exists. |
| `policies` | Durable mirror of `InsuranceBought` events (ingested from RPC) for exposure counting. |
| `ingest_cursors` | Per-collector resume points (last-seen ledger). |
| `cron_runs` | One row per job execution — feeds the admin JOBS board and public `/status` (see Job-Ops Layer). |

### The reconciler (`dapp/api/_lib/governance/reconciler.ts`, hourly at `:10`)

Runs after the signal collectors. It is **idempotent** — desired state is recomputed
from scratch every tick, so a crashed run self-heals next hour:

```
1. Bulk-load DB state: routes, active signals, recently-ended signals (hysteresis
   window), open pause_events, open + last-24h premium_adjustments.
2. Per route: read the ACTUAL on-chain status via submitter.readStatus(),
   filter matching signals by scope, then call the PURE decideReconcileAction(...).
3. Execute the returned action through GovSubmitter, and mirror the result into
   pause_events / premium_adjustments.
```

The decision function in `rules.ts` is **pure — no I/O** — and applies a fixed
priority order (returning one of `noop | disable | enable | set_premium |
revert_premium | flag`):

1. **Admin pin wins** — a pinned, unexpired route is never overridden (`noop`).
2. **Not on-chain yet** → `noop` — whitelisting new routes is deliberately
   manual: the admin pipeline in `scripts/` (discover → ML price → admin
   review → seed; see [Whitelisting a Route](#whitelisting-a-route)),
   never the reconciler.
3. **Severe signal → `disable`** — any active `severe` signal matching the route's
   scope disables an Active route.
4. **Admin lifecycle** — a route the admin set `disabled` is never auto-re-enabled.
5. **Reactivation** — a Disabled route re-`enable`s only if the engine's *own*
   pause_event is open (else it `flag`s for review — someone acted outside the
   engine) **and** all pause signals have been clear for `HYSTERESIS_HOURS = 2`.
6. **Premium multipliers** — each active `elevated` signal contributes a factor
   (`payload.factor`), factors **stack multiplicatively** over the route's base
   premium, then clamp to the configured rails. Guards: a `terms_valid` mirror
   check (`premium < payoff`, `payoff/premium ≤ 100`, else `flag`), a
   `DRIFT_THRESHOLD` no-churn skip (≈1 USDC), and **max one change per route per
   day**. When the adjusters clear, `revert_premium` walks terms back to base.

### GovSubmitter — the single on-chain choke point (`submitter.ts`)

Both the reconciler and the admin API mutate the chain **only** through
`GovSubmitter`, so every write is identically audited. Each `submit()`:

1. Snapshots `route_status` **before**;
2. simulates / signs / submits the contract call with the gov-admin key (captures
   the tx hash);
3. snapshots `route_status` **after**;
4. appends the whole thing to `actions_log` (a failed submit is logged too).

It wraps the **generated TypeScript bindings** (the `governance_module` package) for
compiler-checked `Keep | Set | UseDefault` term-update unions, and exposes methods
that map 1:1 to contract entry points: `disable` → `disable_route`, `enable` →
`enable_route`, `updateTerms` → `update_route_terms`, plus `whitelist` / `remove` /
`revertTerms`. An off-chain signal therefore becomes, literally, a `disable_route` /
`update_route_terms` call — with the contract's owner-set **term limits as the final
backstop** no automated write can exceed.

### The ML prediction service (Render-hosted)

`agent/` is a Python **FastAPI + XGBoost** service deployed on Render
(`render.yaml` → **`flight-delay-predictions`**; it lives off-Vercel because
xgboost/sklearn/pandas exceed the serverless size limit). It is deliberately a
**pure prediction API — it knows nothing about premiums, payoffs, or
insurance**; the protocol turns its probability into a price on the dapp side.

**Live:** <https://flight-delay-predictions.onrender.com> (free plan — spins
down when idle, so the first request after a quiet spell cold-starts in
~1 min; interactive Swagger docs at `/docs`). Deployed 2026-07-28 via the
Render REST API; auto-deploys on every push to the linked branch.

**What the endpoint does.** `POST /predict` takes a route-level flight
description — carrier, origin, dest, month, day-of-month, day-of-week,
scheduled departure `HHMM` (optional, default noon), distance in miles
(optional, default 1000) — and returns the **calibrated probability of the
protocol's covered event**:

```
p_covered = P( arrival ≥ 180 min late  OR  cancelled  OR  diverted )
```

plus a grade relative to the network baseline (`risk`: low < 0.75×, moderate
< 2×, high ≥ 2× the 3.42% network-average rate), and the model version.
Flight numbers are never a feature — a route+calendar+time tuple IS the
model's entire input, so "UA, ORD→SFO, a December Tuesday around 9am" is a
complete query. `GET /healthz` reports the loaded model version. An optional
`AGENT_TOKEN` bearer-gates `/predict`.

**How to call it** (copy-paste runnable):

```sh
curl -s -X POST https://flight-delay-predictions.onrender.com/predict \
  -H "Content-Type: application/json" \
  -d '{"carrier": "B6", "origin": "JFK", "dest": "BOS",
       "month": 1, "day_of_month": 28, "day_of_week": 7,
       "dep_time_hhmm": 2100, "distance_mi": 187}'
```

| Field | Meaning |
|---|---|
| `carrier`, `origin`, `dest` | IATA codes — the route |
| `month`, `day_of_month`, `day_of_week` | the date (`day_of_week`: Mon=1 … Sun=7) |
| `dep_time_hhmm` | 24-hour HHMM (`900` = 9am, `2100` = 9pm). Optional, default noon; minute precision is irrelevant — the model learned time-of-day bands |
| `distance_mi` | optional, default 1000 |

Response — `p_covered` is the answer ("11.5% of flights like this get
disrupted"), `vs_baseline` the multiple of the network average:

```json
{
  "p_covered": 0.1150,
  "risk": "high",
  "baseline": 0.0342,
  "vs_baseline": 3.36,
  "model_version": "2026-07-27T18:01:47Z-btsM24-arr180m"
}
```

Unknown carriers/airports never error (the encoder ignores them and predicts
from the remaining features). If `AGENT_TOKEN` is set on the service, add
`-H "Authorization: Bearer <token>"`.

**What the model is.** XGBoost (300 gradient-boosted trees) over one-hot
route/calendar features + numeric departure-time/distance, followed by
**isotonic calibration** — when it says 5%, ~5% of such flights actually miss.
Trained on **15.4M flights** from the BTS **[Marketing Carrier On-Time
Performance (Beginning January
2018)](https://transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FGK&QO_fu146_anzr=b0-gvzr)**
table — the official US DOT per-flight record (every scheduled domestic
flight: carrier, route, scheduled/actual times, delay minutes, cancellations,
diversions; published monthly, ~2 months behind the calendar, free with no
account). The current window is the 24 months ending 2026-05, fetched
automatically from the prezipped monthlies (`make download-data`); v3
baseline: test AUC 0.789, mean-p 0.0341 vs actual 0.0342. It answers "what
fraction of flights like this get disrupted?", not "will this specific
flight be late" — it carries no forecast or live operational data.
**Retraining every 6 months on fresh BTS data is a maintenance requirement —
the full runbook, including the BTS links and copy-paste Claude prompts that
execute the whole refresh, is [maintenance.md](maintenance.md).**

**How the protocol consumes it.** The daily `route_agent` collector calls it
via `dapp/api/_lib/agent_client.ts` (15 s timeout, bearer token) and computes
the premium anchor **protocol-side** (`route_rules.ts`):

```
anchor = clampPremium( p_covered × payoff × 1.3 , rails )
```

which it writes as a `pricing` **signal**; the reconciler — the single audited
actor — uses it as the premium anchor. **Any failure returns `null`**, so a
down or unset model degrades gracefully to admin-set terms — never a broken
cron, never a blocked route.

### How the premium is clamped (formula + where to change the limits)

Current terms (2026-07-28): **premium clamped to $10–$30, payoff $100** per
policy, delay threshold 3h. The full pipeline from probability to on-chain
premium, in order:

```
p_covered                       ← POST /predict (the ML service)
raw      = p_covered × payoff × 1.3        expectedLossPremiumUnits()   route_rules.ts
anchor   = clamp(raw, MIN, MAX)            clampPremium() rails         route_rules.ts
target   = anchor × Π(active elevated multipliers, default ×1.25)       governance/rules.ts
final    = clamp(target, MIN, MAX, ±50%/day vs current premium)         governance/rules.ts
on-chain: update_route_terms(final) — rejected if it exceeds the
          owner-set term limits (the backstop no automation can pass)
```

Any `severe` signal skips pricing entirely and pauses the route.

Worked example at today's terms: a typical route (p ≈ 0.034) prices at
0.034 × $100 × 1.3 ≈ $4.40 → **floors at $10**; premiums rise above the
floor from p ≈ 0.077 and **cap at $30** from p ≈ 0.23 (rare — multi-x
storm-season routes, which weather multipliers can also push to the cap).

**Where to change MIN/MAX (or the payoff)** — one file, three knobs, all in
[`dapp/config/routes.testnet.json`](../dapp/config/routes.testnet.json):

- `rails.premium_usdc.min` / `.max` — the clamp bounds ($10/$30 today).
  Rails changes take effect on the **next cron pass automatically** (both
  route_agent's anchor and the reconciler's final clamp re-read the file).
- `defaults.payoff_usdc` — the payoff ($100 today) and
  `defaults.premium_usdc` — the admin base premium used when no ML anchor
  is live ($15 today). On-chain, every route (all file overrides are null)
  stores `UseDefault` and resolves against the module's global defaults —
  so the whole fleet reprices with **one owner transaction**:
  `GovernanceModule.set_defaults(premium, payoff, delay_hours)` (verified
  2026-07-28: one call moved all 202 routes from $50/$500 to $15/$100).
  Also update the DB `routes` base-term columns the reconciler prefers
  (manual today — see TODO §D on teaching `gov_onboard` to sync terms).
  Per-route *overrides* in the file are the exception: those need
  `npm run whitelist:routes -- --sync-terms` (one `update_route_terms`
  per changed route, gov-admin signed).
- The margin (×1.3) is `EXPECTED_LOSS_MARGIN` in
  `dapp/api/_lib/route_rules.ts`.

The final backstop lives on-chain: `GovernanceModule.set_term_limits`
(owner-only) caps `max_payoff` and `max_payoff_ratio` — no file edit or
automated write can price past those.

### Human oversight

Admins never touch the chain by hand either — they write facts and let the pipeline
act. All admin APIs (`dapp/api/admin/*`) are gated by `verifyAdmin`: a Supabase Auth
JWT verified live via `auth.getUser`, then checked against an `ADMIN_EMAILS`
allowlist (Supabase Auth is used for **identity only**; data access stays on the
deny-all pooler).

- **`/admin`** (`src/pages/Admin.tsx`, hidden "Route Control" board) — declare/clear
  **signals** (facts, picked up next reconciler tick — *not* direct chain calls),
  pin/unpin routes, set lifecycle, run direct ops (which still go through
  `GovSubmitter`, actor `admin:<email>`), and watch the job board + `actions_log`.
- **`/status`** (`src/pages/Status.tsx`, public) — the sanitized job-health board.
- **`GOV_DRY_RUN=true`** — while set (current testnet state, pending the on-chain
  `add_admin`), the reconciler decides and logs every action but submits nothing and
  writes no mirror rows — a safe rollout switch.

```
SIGNAL INGESTION      collectors + admins  --INSERT-->  signals (facts)
                        gov_signals (hourly :05): ONE AeroAPI /airports/delays
                        call covers the whole network — red airport -> severe
                        (pause), yellow -> elevated (premium multiplier), two
                        scoped rows per airport (origin + dest), self-expiring
        |
        v
RULES (hourly :10)    reconciler: readStatus(on-chain) + decideReconcileAction(pure)
        |                 pin? noop | severe? disable | cleared+hysteresis? enable
        |                 elevated? base x Pi(factors), clamp, guards
        v
ML PRICING            anchor: p_covered from Render /predict × payoff × margin, rails-clamped
        |
        v
SUBMITTER             GovSubmitter: before-snap -> disable/enable/update_route_terms
        |                          -> after-snap -> actions_log   (gov-admin key)
        v
ON-CHAIN              GovernanceModule  (+ owner term-limits backstop)
        |             + DB mirror: pause_events / premium_adjustments
        v
OVERSIGHT             /admin (declare signals, pin, direct ops) | /status (public)
```

### The autonomy ladder (L1 → L3)

Governance is designed to become **fully automated** in staged levels — each
level keeps the same inversion (facts in, one audited actor out) and adds
capability, never new trust. The task-level plan lives in
[TODO.md §D](TODO.md); the architecture-level intent:

**L1 — rules on weather.** The reconciler acts on airport-delay
signals (`gov_signals`) and admin-declared facts. Humans still do route
onboarding, base terms, non-weather signals, and signal clearing.
(`route_agent` was absorbed 2026-07-27: it is now a facts-only collector —
ML `pricing` + Open-Meteo `weather` signals, zero chain writes.)

**L2 — the complete deterministic pipeline (no LLM).** *Status 2026-07-27:
three of the four additions below are IMPLEMENTED (`gov_onboard`, the
exposure collector as `gov_exposure`, and the fleet guardrails — runtime
freeze flag `ops_flags.gov_frozen` + admin endpoint, mass-disable circuit
breaker, flap damping). Remaining: `gov_schedule_check` (needs AeroAPI) and
the route_agent absorption.* Four additions close every routine human loop:
- `gov_onboard` — fleet STATUS sync (file/chain→DB), closing the
  *invisibility gap*: routes whitelisted by script but absent from the DB
  are invisible to the reconciler. NOTE (2026-07-29 product decision):
  route INTAKE is permanently out of scope for automation — new routes
  enter only through the manual admin pipeline (`scripts/`: discover →
  ML price → admin review → seed); the earlier candidate-ingest +
  auto-promote design was removed.
- **Exposure collector** — `InsuranceBought` events ingested from RPC into
  `policies` (resume via `ingest_cursors`), projected as `exposure`
  signals when a route/airport concentration crosses thresholds.
- `gov_schedule_check` — published-schedule drift vs the stored canonical
  schedule → `schedule_drift` signals.
- **Fleet-level guardrails** — a mass-disable circuit breaker (beyond
  per-route hysteresis), a runtime freeze flag (kill switch without a
  redeploy), and disable/enable flap damping.
After L2 the only human actions left are appetite changes (rails, defaults,
term limits — owner), emergencies (pause, pins), and — if propose-only mode
is chosen — approving onboarding candidates.

**L3 — the agentic layer.** An LLM **analyst agent** joins as *just another
collector*: it reads signals, exposure, run health, and open-web context
(storms, geopolitics, airline disruptions) and writes ONLY schema-validated
facts — `signals` rows with rationale in the payload, candidate-route
annotations. It holds no keys and never calls the chain; the reconciler
remains the sole actor. A read-only **auditor agent** reviews the actions
log for anomalies (premium oscillation, over-pausing) and reports to the
admin console.

**Why full autonomy is safe here — three nested cages:**

```
on-chain     term limits, payoff ratio, gov key is admin-not-owner, pausable
  └ rules    rails clamps, hysteresis, 1-change/day, fleet breaker, pins win
     └ agent facts only, JSON-schema validated, per-run caps, fully logged
```

The worst outcome of a wrong automated judgment at any level is a bounded
premium tweak or an unnecessary pause — never a payout, never insolvency.

---

## Data Flow

> For visual, editable Mermaid sequence diagrams of these flows (deployment,
> purchase, underwriter, settlement, claim), see
> [sequence_diagrams.md](../sequence_diagrams.md).

### The Life of One Insured Flight

Every mechanism in this document exists to serve this one story. Flight `UA100`
DEN→SFO on March 3, premium $10, payoff $50, delay threshold 2h:

```
 1. LISTED     Governance admin (or the reconciler, via GovSubmitter) calls
               governance.whitelist_route(UA100, DEN, SFO, $10, $50, 2h).
               Nothing else happens — no flight entry exists yet.

 2. ATTESTED   sale_authorizer (oracle key, every 2h) verifies with AeroAPI that
               March 3's UA100 is scheduled and not cancelled, then stamps a
               sale window: oracle.open_sale(UA100, Mar3, expires_at = now+6h).
               No live window -> no sale, ever. Fail closed.

 3. BOUGHT     Traveler signs controller.buy_insurance(UA100, DEN, SFO, Mar3):
                 governance.route_status()        -> Active($10/$50/2h)
                 lead time >= 1h, horizon <= 90d  -> OK
                 oracle.get_flight_data().status  -> NotInitiated/Active only
                 oracle.is_sale_open()            -> must be true
                 FIRST buyer -> pool.register_flight(terms snapshot)
                             +  oracle.register_flight()  (-> NotInitiated)
                 solvency: TMA >= ceil((locked + $50) x ratio/100)
                 usdc.transfer(traveler -> pool, $10)      premium locked
                 vault.increase_locked(controller, $50)    collateral reserved
                 pool.add_buyer(UA100, Mar3, traveler)
               (Each later buyer repeats from the solvency check down.)

 4. TRACKED    fetcher (oracle key, every 2h) writes the published schedule:
               oracle.set_estimated_arrival(scheduled_in). NotInitiated -> Active.
               Then silence until landing time.

 5. LANDED     March 3, UA100 lands 3h07m late. On its next pass (ETA+1h buffer)
               the fetcher writes oracle.set_landed(actual). Active -> Landed.
               >>> BARRIER ON: oracle PendingOutcomes > 0 — the vault refuses to
               price ANY LP deposit/withdrawal until this outcome settles. <<<

 6. SETTLED    JIT — same job run, seconds later, no waiting for the sweeps
     (JIT)     (classifyAndSettleFlight in targeted_settlement.ts):
                 controller.classify_flight(keeper, UA100, Mar3):
                   delay 3h07m >= 2h -> oracle.set_to_be_settled(Delayed)
                 controller.settle_flight(keeper, UA100, Mar3):
                   vault.send_payout(pool, ($50-$10) x buyers)
                   vault.decrease_locked($50 x buyers)
                   pool.settle_delayed(UA100, Mar3, claim_expiry = now+60d)
                   oracle.set_settled(UA100, Mar3)
               >>> BARRIER OFF. <<<  (If this instant path fails — paused
               contract, RPC glitch — the hourly classify_flights and 5-min
               execute_settlements sweeps repair it.)

 7. CLAIMED    Traveler calls pool.claim(traveler, UA100, Mar3) within 60 days:
               Claimed(...) flag set, usdc.transfer(pool -> traveler, $50).
               Unclaimed after 60d -> anyone calls pool.sweep_expired ->
               RecoveredBalance (owner pulls via withdraw_recovered).

 (On-time instead: step 6 becomes oracle.set_to_be_settled(OnTime) ->
  pool.settle_on_time transfers all premiums pool -> vault +
  vault.record_premium_income (underwriter yield), vault.decrease_locked,
  oracle.set_settled. No step 7 — travelers get nothing back.)
```

The keeper internals of steps 4–6 are specified in [Cron #1](#cron-1--flightdatafetcher-oracle-every-2-hours)
– [Cron #3b](#cron-3b--queuemaintainer-keeper-every-5-minutes) above; the exact
money movements per outcome are in the
[FlightPoolManager payout example](#flightpoolmanager). The remaining flows below
are the ones not covered by that story.

### Whitelisting a Route

**Where routes come from — the MANUAL, admin-gated intake pipeline
(2026-07-29 product decision: route whitelisting is NEVER automated — no
cron, no auto-promote, no schedule; an admin runs it ad hoc):**

```
1. DISCOVER   npx tsx ../scripts/discover_routes.ts        (from dapp/)
              One /schedules call per directed city pair per sample day
              (80 pairs, paced). HARD filters: attestable idents only
              (airline-code+number — the oracle can't track what it can't
              query), operating mainline flights, and TRACKED CARRIERS
              ONLY (American, Delta, United, Alaska, Southwest, JetBlue,
              Frontier, Spirit, Hawaiian — everything else ignored).
              Everything eligible merges into the deduped, UNCAPPED
              catalog config/routes.discovered.json (real departure time
              captured per flight). Nothing else is touched.

2. PRICE      npx tsx ../scripts/price_routes.ts
              Every catalog candidate is priced by the LIVE ML service
              (/predict with its real local departure time + great-circle
              distance): premium = clamp(p_covered × $100 × 1.3, $10–$30),
              payoff $100, delay 3h → staged into
              config/route_whitelist.json with p_covered + model version.

3. REVIEW     THE ADMIN LOOKS AT route_whitelist.json AND SAYS GO.
              (git diff, or seed_routes --dry-run for the table view.)
              Nothing reaches the chain without this step.

4. SEED       npx tsx ../scripts/seed_routes.ts            (gov-admin key)
              Whitelists each staged route on-chain with its EXACT staged
              terms (Set premium/payoff/delay — what was reviewed is what
              the chain gets), via the audited GovSubmitter. Idempotent:
              Active → noop (terms drift reported, never auto-fixed),
              Disabled → skipped (governance decision respected). Seeded
              routes are mirrored into config/routes.testnet.json — the
              operational fleet file the sale_authorizer reads — and
              gov_onboard's status sync mirrors them into the DB so the
              reconciler manages them.
```

Re-running any step against already-listed routes is harmless: discovery
skips them, the whitelist script no-ops on `Active`, and the contract itself
treats a same-route `whitelist_route` as an idempotent refresh (only a
*conflicting* origin/dest for an existing flight_id panics — deliberate
protection, not breakage). The on-chain call underneath:

```
Owner or Admin -> GovernanceModule.whitelist_route(flight_id, origin, dest,
                                                  premium?, payoff?, delay_hours?)
    +-> route stored in Persistent storage, keyed Route(flight_id, origin, dest)
        if custom terms provided -> stored per-route
        if not -> will fall back to global defaults when queried via route_status()
        Route TTL extended (120-day window) on this write
        emits route_listed event -> off-chain indexer materializes the row
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
                +-> enforce 90-day maximum booking horizon        revert if departure too far out
                |       (policy lifecycle must fit inside the
                |       fixed 180-day buyer-key TTL)
                +-> OracleAggregator.get_flight_data(flight_id, date).status
                |       must be NotInitiated or Active            revert if outcome recorded
                +-> OracleAggregator.is_sale_open(flight_id, date)
                |       must be true — a live, unexpired oracle   revert "sale not open"
                |       attestation that the flight instance is
                |       scheduled and not cancelled (fails closed
                |       when missing, lapsed, closed, or archived)
                |
                +-> flight exists in FlightPoolManager for (flight_id, date)?
                |       +- YES -> oracle must still hold the flight's data row
                |                 (has_flight_data)  revert "oracle data unavailable"
                |                 then use the bucket's snapshotted terms, then
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
    +-> panic if env.ledger().timestamp() < claim_expiry
        (strict complement of claim's `>= claim_expiry` cutoff — the instant
         the window closes to claims it opens to sweeping)
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

**And never let capital leave below the same reserve.** Capital leaves only through
withdrawal-queue processing (the immediate exit operations are disabled and the
`max_*` views report zero), which is bounded by:

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
         Owner  (owner txns: set defaults / term limits / add_admin / rotate signer keys)
           |
           v
      GovernanceModule <---- gov_reconcile / route_agent  (gov-admin key, off-chain:
           |                    signals -> rules -> GovSubmitter -> disable/enable/update_route_terms)
           |  resolved terms (cross-contract client)
           v
          Controller  <---- classifier       (keeper, hourly)
          |    |    |  <---- settler          (keeper, every 5 min)
          |    |    |  <---- queue_maintainer (keeper, every 5 min)
    +-----+    |    +------------+
    v          v                 v
RiskVault  FlightPoolManager   OracleAggregator  <---- fetcher + sale_authorizer
(OZ Vault)                          ^                    (oracle key, every 2 hr)
                                    |
                             ttl_extender: extend_ttl x5 + prune_settled (daily, ttl key)

  All off-chain jobs run as Vercel serverless crons (dapp/api) — a swappable backend,
  each gated on an owner-updatable address. See Off-Chain Keeper & Oracle Layer +
  Off-Chain Governance Automation.

Underwriters --request_deposit / request_withdrawal--> RiskVault
                               +-- collect() <-- Underwriters (two-phase FIFO queues)

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
settle archived claims during a pause. Three further deliberate exemptions:
`flight_pool_manager.claim` stays open (the claim window runs on the ledger clock;
gating it would let a pause silently expire valid, already-funded payouts);
`flight_pool_manager.sweep_expired` stays open for the same clock reason — the
FlightConfig TTL buffer past `claim_expiry` keeps counting down during a pause,
and the sweep is the last routine touch before the entry archives, so gating it
would let a long pause strand the unclaimed obligation outside `RecoveredBalance`
until a manual storage restore (the sweep is accounting-only; the actual transfer,
`withdraw_recovered`, remains owner-only and pause-gated); and
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

**Pausing governance alone does NOT stop sales — and blocks the
route-disable lever.** The governance pause halts only its administrative
writes; `route_status` deliberately keeps serving `Active` (with its
protective TTL side effects), so the controller keeps admitting purchases on
every listed route while governance is paused — and `disable_route` /
`remove_route` are pause-gated, so the intuitive combination "pause
governance + disable the bad route" is internally contradictory: the disable
reverts and sales continue. To stop sales mid-incident, pause the
**Controller** (halts every purchase) or use the oracle's pause-exempt
`close_sale` (kills insurability per flight); unpause governance first if a
route must be disabled or removed.

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
   reject zero timestamps, arrivals before the departure day's midnight, and
   arrivals past a plausibility ceiling (`date + 3 days` scheduled /
   `date + 30 days` actual — bounds a unit-confused millisecond-scale timestamp
   could never pass) (`InvalidTimestamp`). There is deliberately NO `actual >= estimated` floor —
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
9. **Cancellations are corroborated, never inferred from the bare flag.**
   AeroAPI's `cancelled` boolean means "no longer being tracked", which the
   provider documents as *not always* an airline cancellation. Because
   `set_cancelled` is forward-only and settles every buyer at full payoff, the
   executor writes it only when the status text also reports a cancellation;
   a flag-only signal closes the sale window (safe) and is surfaced for ops.
   Every executor backend must preserve this two-signal rule.
10. **Diverted flights pay as cancellations (product policy).** A diverted
   leg's `actual_in` is the gate arrival at the *diversion* airport, so it is
   never attested as a normal landing — instead, once the diversion is
   corroborated (flag + diverted status text or a concluded leg), the
   executor writes `set_cancelled`: the insured journey to the filed
   destination did not happen as sold, and the Cancelled outcome already
   moves exactly the right money (full payoff per buyer) with no contract
   change. On-chain, diversions are therefore indistinguishable from airline
   cancellations (the run logs record which was which); if diversion
   economics ever diverge from cancellation, a contract-level `Diverted`
   outcome (appended to `FlightStatus` — variant order is XDR-load-bearing)
   becomes necessary.

**Trust assumption depends on the backend.** Today the jobs run as Vercel serverless
functions signing with server-held keys, so you trust that operator. With a TEE
backend (Acurast, Phala) you would instead trust the hardware attestation chain. The
architecture is designed so that the trust model **improves over time** without
touching the contracts — only the authorized address changes.

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

A future `ExtendFootprintTTLOp` job (enumerating idle Persistent entries off-chain
and extending them in bulk) is planned but not yet built; the `ttl_extender` cron
today performs instance-level `extend_ttl()` on all five contracts plus
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
- **LP pricing is delayed, not immediate (deliberate) — and the delay has a stated
  horizon.** Every entry and exit is a two-phase request priced only once it outlives
  `LP_PRICING_DELAY_SECS` (6 h). This closes the window between a flight outcome being
  **observed by the oracle** and the oracle writing it on-chain (where the settlement
  barrier cannot see it): by pricing time, everything the oracle could have written at
  commitment is settled into the price or barrier-held. The guarantee's horizon is
  therefore *outcomes observable at or after landing minus 6 h* — not everything an
  informed LP can predict. Three accepted residuals share this single boundary, and
  any retuning of `LP_PRICING_DELAY_SECS` or the barrier semantics must be evaluated
  against all three at once:
  1. **Oracle-pipeline outage longer than the delay** — outcomes stay unwritten past
     request maturity and matured requests price stale. **Operational requirement:** on
     an oracle/fetcher outage approaching the pricing delay, pause the vault (queue
     processing stops with it); the sale authorizer's fail-closed windows already stop
     new exposure in the same outage.
  2. **Pre-landing delay foreknowledge (healthy pipeline).** For delay outcomes the
     earliest possible oracle write is the landing itself, but the outcome is often
     near-certain at departure: a departure delay beyond the route threshold makes the
     arrival delay effectively certain a full flight-duration before `set_landed` can
     land on-chain. For any flight whose duration plus write latency exceeds the 6 h
     delay (most long-haul traffic), an LP watching public flight-tracking data can
     request a withdrawal at departure, mature mid-flight, and be priced pre-loss —
     shifting that flight's pending loss, up to `(payoff − premium) × buyer_count`, to
     the remaining LPs (the entry-side mirror captures premium income and is
     premium-bounded). Accepted: closing it would require the barrier to treat every
     flight past its scheduled arrival as pending (barrier duty-cycle cost) or a
     pricing delay near the scheduled-arrival horizon (UX cost), and neither is
     airtight against departure-delay foreknowledge. Bounded per event, requires
     capital already at risk in the vault, and no protocol insolvency.
  3. **Void-path income predictability** — for a flight voided via the stale timeout,
     the outcome (premiums become vault income) is deterministically computable from
     on-chain state the moment `date + 14 days` passes, but the barrier only engages
     when the classifier writes `ToBeSettledOnTime`. The income is knowable arbitrarily
     far in advance, so an LP can time a deposit request to mature inside the gap (up
     to one classifier cycle) and capture a pro-rata slice at the pre-income share
     price. Exposure is bounded by the voided flights' premiums — and an attacker
     seeding bogus flights always loses more in premiums than they can recapture — so
     this is accepted; a tight classifier cadence minimizes the window.
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
| Rotate settlement-barrier oracle | Owner | `risk_vault.set_oracle(oracle)` (refuses while the current oracle has pending outcomes or while any policy collateral is still locked — outstanding exposure settles on the old oracle's pipeline) |
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
| Drain LP deposit + withdrawal queues + snapshot | Keeper | `controller.run_queue_maintenance(keeper)` |
| Toggle buyer whitelist | Owner | `controller.set_whitelist_enabled(bool)` (default off — open purchases) |
| Approve / revoke a buyer | Owner or Governance admin | `controller.add_whitelisted_buyer(caller, addr)` / `remove_whitelisted_buyer(caller, addr)` (approval carries an explicit 180-day inactivity deadline; each purchase slides it forward) |
| Check buyer approval | Anyone | `controller.is_whitelisted(addr)` (valid = added, not removed, deadline not passed) |
| Prune aged-out settled flights | Anyone | `oracle.prune_settled()` |
| Read active flight count | Anyone | `oracle.get_active_flight_count()` (alert as it nears the list cap) |
| Check flight data physically exists | Anyone | `oracle.has_flight_data(flight_id, date)` (distinguishes archived from unregistered) |
| Evict archived flight from list | Owner | `oracle.evict_missing_flight(flight_id, date, outcome_pending)` (only when FlightData is missing; after off-chain finality confirmation. Restore-and-settle is always preferred. `outcome_pending = true` iff the flight's outcome was already public — Landed/Cancelled/ToBeSettled\* per its event history — so the eviction releases the settlement-barrier count that settlement would have released; getting the flag wrong either strands the barrier or opens it early. **Eviction is step one of two** — follow with `controller.settle_evicted_flight`, or the flight's pool bucket and vault collateral stay stranded forever. Record the emitted `FlightEvicted` event — including its `outcome_pending` flag — in the change record: step two cannot verify the pairing on-chain) |
| Settle an evicted flight's bucket | Owner | `controller.settle_evicted_flight(flight_id, date)` (terminal reconciliation after `evict_missing_flight`: settles the pool bucket with void semantics — premiums to the vault, no payout — and releases the flight's locked collateral. Requires the FlightData row to still be absent and the flight to be out of the oracle active list; do not restore the row after eviction. The on-chain gates cannot verify an eviction happened for this flight or which flag it carried — before calling, quote the paired `FlightEvicted` event in the change record and confirm from the flight's status-event history that denying its buyers a payout is the intended outcome) |
| Update keeper address | Owner | `controller.set_keeper(new_keeper)` |
| Update oracle address | Owner | `oracle.set_oracle(new_oracle)` |
| Set min request value floor (both queues) | Owner | `risk_vault.set_min_withdrawal_request(min_assets)` (0 disables only the configured component — the occupancy-scaled protocol floor always applies; enforcement clamped to max(TMA/2500, one whole token)) |
| Read queue occupancy | Anyone | `risk_vault.get_withdrawal_queue_len()` (alert as it nears the queue cap) |

---

## dApp Frontend — FLIGHTS.FUN

The frontend is **FLIGHTS.FUN** (`dapp/`, package `sentinel-arcade`), a **Vite 7 +
React 19** single-page app (TypeScript, Tailwind v4). It ships two switchable looks
via a `data-theme` attribute — `fun` (the default pixel-arcade "FLIGHTS.FUN" CRT
aesthetic) and `serious` (a clean professional insurance UI) — toggled from a theme
dock and persisted to local storage. Wallet connect + signing use
`@creit.tech/stellar-wallets-kit` (SEP-43 modules, so Freighter and others); balances
come from Horizon. The SPA and the serverless backend (`dapp/api/`, above) are the
**same Vercel project**.

### Project Structure

```
sentinel_soroban_phase_3/
├── contracts/                      # Soroban smart contracts (Rust workspace)
│   ├── sentinel_types/             # Shared cross-contract types, TTL consts, active_set, test_support
│   ├── governance_module/  risk_vault/  flight_pool_manager/
│   ├── controller/  oracle_aggregator/
│   ├── mock_usdc/                  # Testnet-only settlement token
│   └── integration_tests/          # Cross-contract test suite
├── dapp/                           # FLIGHTS.FUN SPA + Vercel serverless backend (one project)
│   ├── src/                        # React app: pages/, contracts/, hooks/, providers/, config/
│   ├── api/                        # serverless backend: cron/, admin/, status/, _lib/ (see Backend structure)
│   ├── packages/                   # generated TS contract bindings, one per contract
│   └── vercel.json
├── supabase/                       # migrations: governance_core.sql, cron_runs.sql (governance DB)
├── agent/                          # Python XGBoost prediction service (Render-hosted)
├── tools/mock-aeroapi/             # keyless AeroAPI mock for local demos
├── deployments/                    # testnet.json — addresses, wasm hashes, constructor params
├── playground/                     # legacy Next.js dApp (superseded by dapp/)
├── docs/                           # Docusaurus documentation site
├── audits/                         # Audit reports + remediations
└── spec/                           # architecture.md, sequence diagrams, phase plans
```

### Generated contract bindings

The app calls contracts through **generated TypeScript bindings** — one npm workspace
package per contract under `dapp/packages/*` (`controller`, `risk_vault`,
`flight_pool_manager`, `governance_module`, `oracle_aggregator`, `mock_usdc`), each
produced by `stellar contract bindings typescript` from the deployed spec and rebuilt
via `dapp/rebuild-bindings.sh` (`npm run install:contracts`, also run during the
Vercel build). `dapp/src/contracts/*.ts` instantiates one typed client per contract;
`dapp/src/hooks/useContracts.ts` wraps them in React-Query read hooks and pushes the
connected wallet onto each client for signing. Everything runs client-side; the app
never holds a secret key.

**Deployment target.** Contract IDs are **hardcoded in `dapp/src/contracts/*.ts`**,
matching `deployments/testnet.json` (the 2026-07-18 testnet deployment — e.g.
controller `CCWDQVAJ…QZGHB`); only network/RPC come from `PUBLIC_*` env
(`dapp/.env.example` defaults to testnet). Because governance keeps no on-chain route
enumeration, the app resolves a candidate route list (`dapp/src/config/routes.ts`)
against `route_status`.

### Pages (`dapp/src/pages/`)

| Route | Page | Purpose |
|---|---|---|
| `/` | `Markets.tsx` | Main insurance-market board — browse routes, buy delay policies |
| `/markets` | `MarketsGlobe.tsx` | Globe visualization of routes |
| `/bets` | `MyBets.tsx` | The connected traveler's policies — claim state, expiry countdowns |
| `/house` | `House.tsx` | The "House" / underwriter (LP) page — vault deposit/withdraw, share price, free/locked capital |
| `/calculator` (`/quant`) | `Quant.tsx` | Monte-Carlo underwriting / pricing simulator |
| `/status` | `Status.tsx` | Public automation/ops health board (reads `api/status`) |
| `/admin` | `Admin.tsx` | Hidden "Route Control" ops console (not in nav; governance signals, pins, jobs, action log) |
| `/privacy`, `/terms` | `Legal.tsx` | Legal pages |

> **Legacy note.** `playground/` — a hand-scaffolded Next.js app that drove contracts
> through a curated function registry (no generated bindings) — still exists in the
> repo but is **superseded** by `dapp/` and is no longer the shipped frontend.

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
        RiskVault.set_min_withdrawal_request(MIN_ASSETS)           <- optional dust floor  (wiring note 2)
        RiskVault.request_deposit(owner_lp, SEED_ASSETS)           <- recommended genesis seed (wiring note 3)

4. Set global defaults:
        GovernanceModule.set_defaults(premium, payoff, delay_hours)

5. Whitelist initial routes:
        cd dapp && npm run discover:routes      <- optional: find candidates via
                                                   /schedules (~60 API calls for
                                                   a 30-pair matrix); review +
                                                   merge into routes.testnet.json
        npm run whitelist:routes                <- diffs on-chain state, then
                                                   GovernanceModule.whitelist_route
                                                   per missing route (idempotent;
                                                   custom terms optional — omit
                                                   to use defaults)

6. Provision off-chain signer keys (one per role, blast-radius separated):
        stellar keys generate oracle-executor    # flight data + sale windows
        stellar keys generate keeper-executor    # classify + settle + queue maintenance
        stellar keys generate ttl-extender       # extend_ttl (permissionless; any funded key)
        stellar keys generate gov-admin          # governance automation writes

7. Register signer addresses on-chain:
        OracleAggregator.set_oracle(ORACLE_EXECUTOR_ADDRESS)
        Controller.set_keeper(KEEPER_EXECUTOR_ADDRESS)
        GovernanceModule.add_admin(GOV_ADMIN_ADDRESS)   <- gates gov-reconcile / route_agent
        (until add_admin lands, run the governance jobs with GOV_DRY_RUN=true)

8. Fund the signer accounts with XLM (oracle, keeper, ttl, gov-admin) for tx fees.

9. Run the backend LOCALLY first (no Vercel needed — every job is a
   standalone bot; this is the current mode until a Vercel Pro plan exists):
        - Apply supabase/migrations/ to the governance database.
        - Env per run (or a local .env): the signer secret keys,
          GOVERNANCE_DB_URL, and AEROAPI_KEY when real flight data is
          wanted (without it the oracle bots fail soft: no data, no
          wrong writes; point AEROAPI_BASE_URL at tools/mock-aeroapi for
          scripted local data).
        - cd dapp && npm run bot -- <name>   # settler, fetcher, gov_onboard, ...
          npm run test:e2e                   # full pipeline against mocks
        - Governance safety during local runs: GOV_DRY_RUN=true computes
          without submitting; the ops_flags.gov_frozen DB flag is the
          runtime brake; GOV_ONBOARD_AUTO stays unset for propose-only
          onboarding.
        - `npm run dev` serves the SPA on :5175 against testnet.

10. Deploy to Vercel LATER (one project serves SPA + backend; 5-minute
    crons and maxDuration 300 require Vercel Pro):
        - mv dapp/vercel.backend.json dapp/vercel.json   <- ready-made config
          (adds the full crons block for all 11 scheduled jobs — kept out of
          the live vercel.json so the current frontend-only deploy and the
          Hobby plan aren't broken by failing crons)
        - rm dapp/.vercelignore                          <- stop excluding api/
        - Set the Vercel env: four signer secret keys, AEROAPI_KEY,
          GOVERNANCE_DB_URL, CRON_SECRET, ADMIN_EMAILS, AGENT_BASE_URL,
          GOV_DRY_RUN/GOV_ONBOARD_AUTO as desired; contract IDs default to
          the 07-18 testnet set.
        - Deploy; verify /api/cron/health (hasKeys + pendingOutcomes) and
          the /admin JOBS board.
        - The prediction service (agent/) deploys separately to Render
          (render.yaml).
```

**Wiring notes (step 3):**

1. **Barrier-oracle rotation.** The vault's settlement-barrier oracle is wired in its
   constructor (step 2c) — no post-deploy call. `RiskVault.set_oracle` exists only to
   rotate to a *redeployed oracle contract*, and refuses while the current oracle
   reports pending public outcomes **or** any policy collateral is still locked
   (together spanning the whole policy lifetime — a fresh oracle starts at zero
   pending, so an early swap would open the barrier at a stale share price). If the
   old oracle is unreachable: pause the vault, `force_set_oracle`, reconcile the
   pending PnL, deliberately unpause. Both paths emit `oracle_set` (with a `forced`
   flag). Not to be confused with `OracleAggregator.set_oracle`, which sets the
   *off-chain executor address*.
2. **Request floor.** `set_min_withdrawal_request` configures the optional component
   of the request-value floor for both LP queues (ships at 0). The occupancy-scaled
   protocol floor — `max(TMA/2500, one whole token)` — is always active regardless,
   so dust squatting is priced even when unset. Pick a value above dust and below
   typical LP sizes (e.g. 100 USDC); owner-updatable anytime, and the response lever
   if the queues saturate. Anti-lockout: enforcement is clamped to the same
   `max(TMA/2500, one token)`, so no configured value can lock positions above
   ~0.04% of the vault out of the queue.
3. **Genesis seed.** Push a seed deposit through the normal two-phase queue **before**
   announcing public LP entry. Near zero TMA, every floor term degenerates to the
   one-token minimum, so pinning the bounded queues full would cost only ~50–75
   tokens of refundable escrow; seeding first makes the `TMA/2500` term dominate from
   the first public request. Size it so `TMA/2500` clearly exceeds one token (the
   relative term only binds above 2,500 tokens of TMA).

**RiskVault / Controller circular dependency:** Deploy RiskVault first, deploy Controller
with vault address, then call `vault.set_controller()`.

**FlightPoolManager / Controller circular dependency:** Same pattern — deploy FlightPoolManager
first, deploy Controller with its address, then call `flight_pool_manager.set_controller()`.

## Admin Runbook — Route Seeding

Route intake is MANUAL and admin-gated by design: no cron runs any of
this, nothing is auto-promoted, and nothing reaches the chain until you
have reviewed the staged whitelist and said go. Run it ad hoc — new
routes might be added once a quarter, or never.

**Prerequisites** (one-time): `dapp/.env` with `AEROAPI_KEY` (discovery)
and `AGENT_BASE_URL` (pricing; defaults to the live Render service), and
the gov-admin signing key — `GOVERNANCE_ADMIN_SECRET_KEY` in the
environment or the local `sentinel-governor` stellar identity. All
commands run **from `dapp/`**.

### Step 1 — Discover (AeroAPI → catalog)

```sh
npx tsx ../scripts/discover_routes.ts            # ~160 paced API calls, ~15 min
```

Sweeps the 80-directed-pair matrix and merges every eligible flight into
the deduped, uncapped catalog `config/routes.discovered.json`. Hard
filters (nothing else gets through): attestable idents (airline-code +
number), operating mainline flights only, and the nine tracked carriers —
American, Delta, United, Alaska, Southwest, JetBlue, Frontier, Spirit,
Hawaiian. Real scheduled departure times are captured per flight. Re-runs
merge and never discard.

### Step 2 — Price (catalog → staged whitelist)

```sh
npx tsx ../scripts/price_routes.ts               # live ML call per route
```

Prices every catalog candidate with the deployed prediction service
(`/predict` with the flight's local departure time and great-circle
distance) and stages `config/route_whitelist.json`:
`premium = clamp(p_covered × $100 × 1.3, $10–$30)`, payoff $100, delay
threshold 3h, model version stamped. Prints the premium distribution.
Aborts (writes nothing) if the ML service is unreachable.

### Step 3 — REVIEW (the human gate)

```sh
git diff dapp/config/route_whitelist.json        # what changed since last time
npx tsx ../scripts/seed_routes.ts --dry-run      # table view, zero transactions
```

Look at the routes, the probabilities, the premiums. **Nothing has
touched the chain yet.** If anything looks wrong, fix and re-run steps
1–2 — the staged file is fully regenerable.

### Step 4 — Seed (only on your go)

```sh
npx tsx ../scripts/seed_routes.ts                # gov-admin signed, idempotent
```

Whitelists each staged route on-chain with its EXACT staged terms
(`Set premium / Set payoff / Set delay` — what you reviewed is what the
chain gets) through the audited GovSubmitter, then mirrors seeded routes
into `config/routes.testnet.json` (the operational fleet file the sale
authorizer reads). The DB picks them up on `gov_onboard`'s next status
sync. Idempotent semantics:

| On-chain state | Action |
|---|---|
| Unknown | `whitelist_route` with staged terms |
| Active | no-op — terms drift is REPORTED, never auto-fixed (repricing a live route is a separate governance decision) |
| Disabled | skipped — governance disabled it for a reason |

Commit the updated JSON files afterwards; the file history is the audit
trail of every intake batch.

### Starting over (full wipe)

```sh
npx tsx ../scripts/wipe_routes.ts --yes          # DESTRUCTIVE
```

Removes every fleet-file route from the chain (`remove_route`), clears
the route-scoped DB tables (signals, premium_adjustments, pause_events,
routes), empties the catalog, resets the fleet file's `routes` to `[]`
(defaults/rails preserved), and deletes the staged whitelist — then
re-intake from Step 1.

## End-to-End Testing

Three test layers, from fast to real:

| Suite | Chain | AeroAPI | ML API | DB | Run |
|---|---|---|---|---|---|
| Agent unit tests | — | — | local model | — | `cd agent && make test` |
| Hermetic E2E (64 checks) | in-memory fake | mock | — | **none (enforced)** | `cd dapp && npm run test:e2e` |
| **Real-chain E2E** | **real contracts, testnet** | mock (runtime-scripted) | **live Render service** | **none (enforced)** | `cd dapp && npm run test:e2e:testnet` |

### The real-chain suite (`dapp/scripts/test_testnet_e2e.ts`)

Runs the REAL job code (authorizer, fetcher, classifier, settler, queue,
ttl) and REAL `GovSubmitter` against a **dedicated throwaway contract
deployment on testnet** (bootstrap: `npm run test:e2e:testnet:bootstrap`;
the live deployment is never touched), with `tools/mock-aeroapi` scripting
the flight world and the **deployed
`flight-delay-predictions.onrender.com`** service supplying real
predictions. **Deliberately DB-less**: `GOVERNANCE_DB_URL` is deleted at
startup, so every run also proves the DB-optional invariant — governance
here is exercised the way manual-mode governance actually works (admin
calls through the same audited `GovSubmitter` choke point the reconciler
uses). Two phases, because the real oracle enforces `date ≤ ETA` /
`date ≤ actual_arrival`: **buy day** (sales, purchases, governance,
cancellations) and **flight day** (landings, remaining claims, final
ledger), resumed automatically from cached state.

**Scenarios covered (terms: $15 base premium, $100 payoff, 3h threshold):**

- **A. Flight outcomes** — A1 lands 5 min early → `SettledOnTime`, claim
  rejected · A2 lands 3h30 late (>3h) → `SettledDelayed`, claim pays $100 ·
  A3 lands 2h00 late (<3h, the boundary) → `SettledOnTime`, claim
  rejected · A4 corroborated cancellation → `SettledCancelled` same day,
  claim pays · A5 diverted → pays as cancellation, never attested as
  landed · A6 tracking-lost (bare `cancelled` flag) → **no tombstone
  written**, then tracking recovers and the flight settles normally.
- **B. Sales coupling** — real authorizer opens every window before
  purchase; each purchase pays **exactly** the current on-chain premium
  and locks exactly the payoff; purchase on a disabled route is rejected
  by the contract gate.
- **C. Governance (manual mode, no DB)** — storm: `disable_route` → buy
  fails → recovery: `enable_route` → the same buy succeeds · elevated:
  premium ×1.25 on-chain → a purchase opening a **fresh** flight bucket
  pays $18.75 while a buyer joining an **already-open** bucket pays its
  snapshotted $15 → revert → terms read back at base.
- **E. ML pricing** — the live `/predict` API prices a route; the anchor
  is computed with the real protocol functions
  (`expectedLossPremiumUnits` + `clampPremium`), pushed on-chain, and a
  purchase pays exactly the model-derived premium · a dead ML endpoint
  degrades to `null` (never a broken run).
- **G. Keepers + accounting** — batch classifier/settler/queue/ttl all
  succeed on the real chain; the settler's pre-flight skip sends no
  transaction when nothing is pending; `has_pending_outcomes` is false at
  the end; **money conservation**: the buyer's net balance change equals
  payoffs minus premiums exactly, and vault `locked` returns to its
  pre-run level.

**What real-chain testing caught that fakes could not** (the suite's
justification, all found on its first runs): the oracle's timestamp
plausibility bounds (`date ≤ ETA ≤ date+3d` — forced the two-phase
design), and the pool's **term-snapshot rule** — a governance repricing
applies to newly opened flight-date buckets, while buyers joining an
already-open bucket pay its original premium (every buyer of one
flight-date pays the same price).

**Deferred to a with-DB suite:** the signals lifecycle (collectors
writing, expiry, source-owned clearing), reconciler decisions,
`gov_frozen` freeze brake, mass-disable circuit breaker, and
hysteresis/step-clamp behavior — i.e., everything whose substrate IS the
database. Those run against an isolated Postgres, never the live
Supabase.
