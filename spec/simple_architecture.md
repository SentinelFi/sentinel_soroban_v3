# Sentinel — Simple Architecture (Chain-Agnostic)

> Decentralised flight-delay insurance protocol. This document describes the
> system in chain-neutral terms so it can be ported to any smart-contract
> platform (EVM, Sui, Solana, Aptos, etc.). It deliberately omits
> implementation details (storage layout, gas/rent model, language idioms).

---

## Table of Contents

- [System Overview](#system-overview)
- [Actors](#actors)
- [Asset](#asset)
- [Contracts](#contracts)
  - [1. GovernanceModule](#1-governancemodule)
  - [2. RiskVault](#2-riskvault)
  - [3. FlightPoolManager](#3-flightpoolmanager)
  - [4. OracleAggregator](#4-oracleaggregator)
  - [5. Controller](#5-controller)
  - [6. StablecoinMock (testnet only)](#6-stablecoinmock-testnet-only)
- [Contract Relationships](#contract-relationships)
- [Off-Chain Layer](#off-chain-layer)
- [Core Flows](#core-flows)
- [Invariants](#invariants)
- [Access Control Model](#access-control-model)
- [Trust Model](#trust-model)
- [Porting Notes](#porting-notes)

---

## System Overview

Travelers buy insurance for a specific flight on a specific date. If the
flight is delayed beyond a threshold or cancelled, they claim a fixed payout.
If the flight arrives on time, the premium is added to a capital pool as
yield.

The capital pool is funded by **underwriters**, who deposit a stablecoin and
receive transferable share tokens (similar to ERC-4626). They earn from
on-time premiums; they lose from delay / cancel payouts.

A trusted off-chain **oracle** pushes flight status data on-chain. A trusted
off-chain **keeper** triggers classification and settlement at scheduled
intervals.

---

## Actors

| Actor | Role |
|---|---|
| **Owner** | Protocol admin. Configures defaults, sets oracle/keeper addresses, can recover funds in edge cases. |
| **Admin** | Delegated route manager. Can add/remove/update routes but cannot change defaults or rotate oracle/keeper. |
| **Underwriter** | Deposits stablecoin to back insurance, receives shares, earns or loses based on aggregate flight outcomes. |
| **Traveler** | Buys insurance for a flight, claims payout if delayed/cancelled. |
| **Oracle (off-chain)** | Pushes flight status updates. One authorized address. |
| **Keeper (off-chain)** | Triggers periodic classification and settlement. One authorized address. |
| **Anyone** | Permissionless callers for housekeeping (sweep expired claims, prune settled list). |

---

## Asset

A single stablecoin (USDC in production, a mock token on testnet) is used for:

- Underwriter deposits and withdrawals
- Premium payments from travelers
- Payouts to travelers

All amounts in this document are denominated in this stablecoin.

---

## Contracts

The system has 5 production contracts plus a test stablecoin.

### 1. GovernanceModule

**Purpose:** Whitelist insurable routes and define default policy terms.

**State:**
- Default premium, default payoff, default delay-hours threshold (global).
- Route entries keyed by `(flight_id, origin, destination)`. Each entry has
  optional per-route overrides for premium / payoff / delay-hours, plus an
  `approved` boolean.
- Admin set (delegated route managers).

**Key operations:**
- Owner: set global defaults, add/remove admins.
- Owner or Admin: whitelist route, disable route, enable route, remove route
  (only if disabled), update route terms (partial — keep / override / revert
  to default per field).
- Anyone: read route status — returns one of:
  - `Active(resolvedTerms)` — buyable, terms folded with defaults
  - `Disabled` — exists but soft-disabled
  - `Unknown` — never whitelisted, removed, or storage-expired

**Why a typed status enum:** lets the controller distinguish "never approved"
from "explicitly disabled" in one call, and ensures defaults are always
folded server-side (caller doesn't need to know about defaults).

### 2. RiskVault

**Purpose:** Capital pool backing insurance. Tracks underwriter deposits as
shares, locked collateral, claimable balances, and a withdrawal queue.

**State:**
- Total Managed Assets (TMA): the pool's accounting balance (deposits +
  premiums – payouts).
- Locked Capital: amount reserved for outstanding insurance policies.
- Free Capital = TMA − Locked.
- Share token (vault shares) issued to underwriters; ERC-4626-style mechanics
  with a small inflation-attack defense.
- Withdrawal queue: ordered list of pending share-redemption requests.
- Claimable balance: per-underwriter pending stablecoin awaiting collection
  (pull-based).
- Daily share-price snapshots (short-lived, for off-chain analytics).

**Key operations:**
- Underwriter: deposit, redeem (immediate, only if free capital allows),
  request_withdrawal (queue), cancel_withdrawal, collect (pull credited
  funds).
- Controller-only: increase_locked, decrease_locked, record_premium_income,
  send_payout, process_withdrawal_queue, snapshot.
- Owner-only: recover_uncollected (manual fallback for archived claimable
  balances) — has two modes: re-credit storage or transfer directly.

**Why a withdrawal queue:** redemptions can exceed free capital when policies
are heavily locked. The queue lets underwriters request now and collect
later when capital frees up via on-time premiums or expired claim sweeps.

### 3. FlightPoolManager

**Purpose:** Per-flight policy state: buyer registry, locked terms, claim
window, payout escrow, recovered (unclaimed) funds.

**State:**
- Flight config keyed by `(flight_id, date)`: locked premium, payoff,
  delay-hours, buyer count, claimed count, settlement status, claim expiry.
- Buyer key: per-traveler boolean indicating policy ownership for a given
  flight.
- Claimed key: per-traveler boolean indicating payout collected.
- Active flight list: list of currently-tracked flights.
- Recovered balance: total stablecoin from expired-claim sweeps owed to the
  protocol owner.

**Settlement statuses:**
- `Active` — accepting buyers
- `SettledOnTime` — premiums forwarded to vault as yield, terminal
- `SettledDelayed` — claim window open, travelers may collect payoff
- `SettledCancelled` — claim window open, travelers may collect payoff

**Key operations:**
- Controller-only: register_flight (first buy locks terms), add_buyer,
  settle_on_time (forwards premiums to vault), settle_delayed (opens claim
  window), settle_cancelled (opens claim window).
- Traveler: claim (collects payoff if eligible).
- Anyone: sweep_expired (after claim window closes, credits unclaimed funds
  to recovered balance).
- Owner: withdraw_recovered (claims swept funds).

**Why one singleton (not per-flight contracts):** simpler deployment, no
factory, all per-flight state lives in keyed storage.

### 4. OracleAggregator

**Purpose:** Authoritative source of flight status. Enforces a forward-only
state machine.

**State:**
- Flight data keyed by `(flight_id, date)`: status, estimated arrival,
  actual arrival, settled-at timestamp.
- Active flight list: currently-tracked flights, with a retention window for
  recently-settled flights.

**Status state machine:**

```
NotInitiated
    -> Active                   (oracle: estimated arrival pushed)

Active
    -> Landed                   (oracle: actual arrival pushed)
    -> Cancelled                (oracle: cancellation pushed)

Landed
    -> ToBeSettledOnTime        (controller: classify)
    -> ToBeSettledDelayed       (controller: classify)

Cancelled
    -> ToBeSettledCancelled     (controller: classify)

ToBeSettled*
    -> Settled                  (controller: execute settlement)
```

**Key operations:**
- Oracle-only: set_estimated_arrival, set_landed, set_cancelled.
- Controller-only: register_flight, set_to_be_settled (classification),
  set_settled (terminal).
- Anyone: prune_settled (removes flights past a retention window from the
  active list).
- Anyone: read flight data, list active flights, list flights by status.

**Why a forward-only state machine:** prevents an oracle bug or replay from
reverting a flight to an earlier status and double-spending payouts.

### 5. Controller

**Purpose:** Orchestrator. The only contract that holds policy logic. Every
multi-contract operation is mediated here. Stateless except for aggregate
counters and a per-traveler purchase index.

**State:**
- Addresses of governance, vault, oracle, pool manager, stablecoin.
- Authorized keeper address.
- Tunables: solvency ratio (% of payoff that must be free in vault),
  minimum lead time (how far ahead a flight must be to insure), claim
  expiry window (how long after settlement a delayed/cancelled claim can be
  collected).
- Aggregate counters: total policies sold, total premiums, total payouts.
- Per-traveler index: list of `(flight_id, date)` ever purchased — feeds
  the "my policies" frontend without scanning all flights.

**Key operations:**
- Traveler: buy_insurance — validates route, checks lead time, registers
  flight if new, checks solvency, transfers premium, locks collateral,
  records buyer, updates index.
- Keeper: classify_flights — iterates oracle's active list, classifies
  Landed/Cancelled flights into ToBeSettled* by comparing actual vs.
  estimated arrival times against the route's delay threshold.
- Keeper: execute_settlements — iterates oracle's active list, processes
  every ToBeSettled* flight (moves money between pool and vault, marks
  oracle as Settled), then drains the underwriter withdrawal queue and
  takes a share-price snapshot.
- Owner: rotate keeper address, set tunables.
- Anyone: read flights for a traveler, read aggregate stats.

**Why split classify and execute:** classification only reads
external state; execution moves money. Splitting them lets the oracle data
stabilize between cron runs and bounds the gas/budget per call.

### 6. StablecoinMock (testnet only)

**Purpose:** Test fungible token mimicking USDC. Permissionless mint and
faucet for testnet experimentation.

**Not for mainnet** — production uses the real USDC on the target chain.

---

## Contract Relationships

```
                          +----------------+
                          |     Owner      |
                          +----------------+
                                  |
              +-------------------+--------------------+
              |                   |                    |
              v                   v                    v
       +-------------+    +-------------+    +-----------------+
       | Governance  |    |   Vault     |    |     Oracle      |
       +-------------+    +-------------+    +-----------------+
              ^                   ^                    ^
              |                   |                    |
              |  reads route      |  locks/unlocks     |  reads flight
              |  terms            |  collateral,       |  data, sets
              |                   |  moves money       |  ToBeSettled*
              |                   |                    |  / Settled
              |                   |                    |
              +-------------------+--------------------+
                                  |
                                  v
                         +-----------------+
                         |   Controller    |
                         +-----------------+
                            |          ^
                  registers |          | buys / claims
                  flights,  |          |
                  settles   |          |
                  buyers    |          |
                            v          |
                    +-------------------+
                    |  FlightPool       |
                    |  Manager          |
                    +-------------------+
                            ^
                            | claim payout / sweep
                            |
                       +---------+
                       | Traveler|
                       +---------+
```

The **Controller** is the only contract that calls every other contract.
All other inter-contract calls are minimal (Pool ↔ Vault on settle_on_time
to forward premiums).

---

## Off-Chain Layer

Three off-chain cron jobs, each operating from a single trusted account
address, drive the protocol forward. A fourth cron is chain-specific and
only required on chains with storage-rent / archival semantics (see
[Porting Notes](#porting-notes)).

### Cron 1 — FlightDataFetcher (Oracle, every ~2 hours)

- Reads the oracle's active flight list.
- For each flight, queries an external aviation API (e.g., AviationStack).
- Pushes status updates: `set_estimated_arrival`, `set_landed`, or
  `set_cancelled`.
- Authorized as the oracle role.

### Cron 2 — FlightClassifier (Keeper, every ~1 hour)

- Calls `Controller.classify_flights()`.
- The controller iterates the oracle's active list, classifies any
  `Landed` / `Cancelled` flights into `ToBeSettled*` based on delay
  threshold, and emits a diagnostic event if any active flight has missing
  oracle data.
- Authorized as the keeper role.

### Cron 3 — SettlementExecutor (Keeper, every ~5 minutes)

- Calls `Controller.execute_settlements()`.
- The controller iterates the oracle's active list, processes every
  `ToBeSettled*` flight (moves money, marks Settled), then drains the
  withdrawal queue and snapshots share price.
- Higher cadence than classifier so payouts and underwriter exits are
  prompt.
- Authorized as the keeper role.

### Cron 4 — Storage Maintenance (chain-dependent)

Only required on chains with archival or rent semantics (e.g., Solana
account rent, Soroban TTL). Iterates an off-chain index of active storage
keys and extends their lifetime. **Not needed on EVM** (no rent),
**not needed on Sui** (object model has different semantics — see porting
notes).

---

## Core Flows

### Whitelist a Route

```
Owner / Admin
   -> Governance.whitelist_route(flight_id, origin, dest, [optional terms])
```

### Underwriter Deposits Capital

```
Underwriter
   -> Vault.deposit(amount, receiver)
   -> Vault mints shares to receiver
   -> Vault TMA increases by amount
```

### Buy Insurance

```
Traveler
   -> Controller.buy_insurance(traveler, flight_id, origin, dest, date)

Controller:
   1. Read Governance.route_status(flight_id, origin, dest) — must be Active.
   2. Check lead time (date > now + min_lead_time).
   3. If flight not yet registered:
        - Pool.register_flight(flight_id, date, premium, payoff, delay_hours)
        - Oracle.register_flight(flight_id, date)
   4. Check Vault.get_free_capital() >= payoff * (solvency_ratio / 100).
   5. Stablecoin.transfer(traveler -> Pool, premium).
   6. Vault.increase_locked(payoff).
   7. Pool.add_buyer(flight_id, date, traveler).
   8. Append (flight_id, date) to per-traveler index.
   9. Update aggregate counters.
```

### Oracle Pushes Data (off-chain cron #1)

```
Oracle account
   -> Oracle.set_estimated_arrival(flight_id, date, eta)
   -> Oracle.set_landed(flight_id, date, actual_arrival)
   -> Oracle.set_cancelled(flight_id, date)
```

### Classify Flights (off-chain cron #2)

```
Keeper account
   -> Controller.classify_flights()

Controller iterates oracle's active list:
   - Cancelled            -> Oracle.set_to_be_settled(.., ToBeSettledCancelled)
   - Landed (on time)     -> Oracle.set_to_be_settled(.., ToBeSettledOnTime)
   - Landed (delayed >=N) -> Oracle.set_to_be_settled(.., ToBeSettledDelayed)
   - NotInitiated         -> emit warning event (oracle hasn't fetched)
```

### Execute Settlements (off-chain cron #3)

```
Keeper account
   -> Controller.execute_settlements()

For each ToBeSettled* flight:

   ToBeSettledOnTime:
      Pool.settle_on_time(flight_id, date)
         + Stablecoin.transfer(Pool -> Vault, premium * buyer_count)
         + Vault.record_premium_income(premium * buyer_count)
      Vault.decrease_locked(payoff * buyer_count)
      Oracle.set_settled(flight_id, date)

   ToBeSettledDelayed | ToBeSettledCancelled:
      Vault.send_payout(Pool, (payoff - premium) * buyer_count)
      Vault.decrease_locked(payoff * buyer_count)
      Pool.settle_delayed_or_cancelled(flight_id, date, claim_expiry)
      Oracle.set_settled(flight_id, date)

After loop:
   Vault.process_withdrawal_queue()
   Vault.snapshot()
```

### Traveler Claims Payout

```
Traveler
   -> Pool.claim(traveler, flight_id, date)

Pool:
   - Verify status is SettledDelayed or SettledCancelled.
   - Verify now < claim_expiry.
   - Verify traveler is a buyer and hasn't claimed.
   - Mark claimed, increment claimed_count.
   - Stablecoin.transfer(Pool -> traveler, payoff).
```

### Sweep Expired Claims (anyone)

```
Anyone
   -> Pool.sweep_expired(flight_id, date)

Pool:
   - Verify now > claim_expiry.
   - unclaimed = (buyer_count - claimed_count) * payoff.
   - RecoveredBalance += unclaimed.
   - Mark claimed_count = buyer_count (idempotent guard).
```

### Underwriter Withdraws (queued)

```
Underwriter
   -> Vault.request_withdrawal(shares)
      - Vault transfers shares from underwriter to itself (escrow).
      - Vault appends request to withdrawal queue.

Later, during execute_settlements:
   - Controller.execute_settlements()
      -> Vault.process_withdrawal_queue()
         For each request from head, while free capital allows:
           - Burn escrowed shares.
           - ClaimableBalance(underwriter) += equivalent assets.
           - TMA -= equivalent assets.

Underwriter
   -> Vault.collect()
      - Stablecoin.transfer(Vault -> underwriter, ClaimableBalance).
      - Clear ClaimableBalance.
```

---

## Invariants

1. **Solvency:** `Locked Capital <= Total Managed Assets` at all times.
2. **Solvency on new policy:** `Free Capital >= payoff * solvency_ratio` at
   buy time.
3. **No double claim:** a traveler can claim at most once per (flight, date).
4. **No double sweep:** sweep is idempotent (claimed_count == buyer_count
   after sweep).
5. **Forward-only flight status:** status transitions are one-way (oracle's
   state machine).
6. **First-buy registration:** a flight exists in pool ⇔ exists in oracle.
7. **Locked-collateral conservation:** every buy increases locked by
   `payoff`; every settlement decreases locked by `payoff * buyer_count`.

---

## Access Control Model

| Function group | Caller |
|---|---|
| Governance: defaults, admin set | Owner |
| Governance: route lifecycle | Owner or Admin |
| Vault: deposit / redeem / withdrawal queue | Underwriter (self) |
| Vault: lock / unlock / payout / queue / snapshot | Controller only |
| Vault: recover_uncollected | Owner |
| Pool: register / add_buyer / settle | Controller only |
| Pool: claim | Traveler (self) |
| Pool: sweep_expired | Anyone |
| Pool: withdraw_recovered | Owner |
| Oracle: set_estimated / set_landed / set_cancelled | Authorized oracle |
| Oracle: register_flight / set_to_be_settled / set_settled | Controller only |
| Oracle: prune_settled | Anyone |
| Controller: buy_insurance | Traveler (self) |
| Controller: classify / execute | Authorized keeper |
| Controller: rotate keeper, set tunables | Owner |

The two off-chain roles (oracle, keeper) are addresses owned by the executor
infrastructure. Owner can rotate them at any time without redeploying any
contract.

---

## Trust Model

- **Oracle is trusted.** A malicious oracle could push false delays, draining
  the vault. Mitigations: forward-only state machine prevents replay; owner
  can rotate the oracle key at any time; off-chain monitoring should alert
  on suspicious patterns.
- **Keeper is trusted to call the right functions.** Keeper cannot move
  funds — it can only invoke `classify_flights` and `execute_settlements`.
  All money movement is gated by the controller's logic.
- **Owner is trusted.** Owner can recover stuck funds, rotate roles, and
  change tunables. Production deployments should make Owner a multisig.
- **Travelers and underwriters are trustless.** They sign their own
  transactions; no third party can act on their behalf.

---

## Porting Notes

This architecture targets any chain with:

- A native fungible-token standard or interface (USDC equivalent).
- Synchronous cross-contract calls.
- Per-account / per-key signing (so the controller can be authorized by the
  caller without a relayer).

### EVM (Ethereum, Arbitrum, Base, etc.)

- 5 contracts deploy as 5 separate EVM contracts.
- Use ERC-4626 for the vault (matches the share-token mechanics directly).
- Use ERC-20 for stablecoin reference; `IERC20.transferFrom` for premium
  pulls instead of the Soroban-style "auth propagation" pattern.
- No storage rent — drop Cron #4 entirely. All storage is permanent.
- `(flight_id, date)` keys map to `mapping(bytes32 => Struct)` with
  `keccak256(abi.encode(flight_id, date))`.
- Use OpenZeppelin Ownable / AccessControl for roles.
- Events translate directly (Solidity `event`).

### Sui (Move)

- Each contract becomes a Move module; per-flight state could be modeled as
  shared objects keyed by `(flight_id, date)`.
- ERC-4626 mechanics need to be implemented manually — Sui has no standard
  vault.
- Object model means `ClaimableBalance` could be a transferable object owned
  by the underwriter, eliminating the pull-based collect step.
- No storage rent at the Sui-object level (objects are paid for at creation
  by the writer); Cron #4 not needed in the same form.
- Capabilities (admin cap, controller cap) replace address-based role
  checks.

### Solana (Anchor / Rust)

- Each "contract" becomes a program; per-flight state becomes a PDA seeded
  by `(flight_id, date)`.
- SPL Token for the stablecoin; vault shares could be a separate SPL Token
  mint owned by the program.
- Solana's account rent is closer to Soroban's archival model — Cron #4
  becomes "keep accounts rent-exempt" and may be implementable as a
  one-time rent-exempt deposit at account creation rather than ongoing
  extension.
- Cross-program invocation is synchronous like Soroban.

### Common gotchas across ecosystems

- **First-buy registration is a 2-write:** flight is created in both pool
  and oracle inside a single transaction. If either side panics, both
  rollback. Atomicity assumed.
- **Withdrawal-queue ordering must be FIFO** for fairness — preserve insert
  order regardless of underlying storage primitive.
- **Per-traveler index can grow unbounded** for heavy users. Frontends should
  paginate; the on-chain index is append-only by design.
- **Active flight lists** (in oracle and pool) need bounded size in practice.
  At the protocol layer this is governed by the keeper's classification
  cadence — don't whitelist more flights than the cron budget can iterate.

---

## What's NOT in this document

- Storage tiers, rent, archival, TTL extension — implementation concerns.
- Specific event topic structures, encoding choices.
- Library / framework choices (OpenZeppelin Stellar, etc.).
- Test fixture details.
- Frontend / wallet integration.
- Deployment runbook, network passphrase.

For the full Soroban-specific architecture see `architecture.md`.
