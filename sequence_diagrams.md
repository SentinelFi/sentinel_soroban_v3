# Sequence Diagrams

Visual walkthroughs of the main cross-contract flows, for new contributors and
reviewers. They complement the prose in [architecture.md](architecture.md).

All diagrams are written in [Mermaid](https://mermaid.js.org/), which renders
automatically on GitHub and in most Markdown viewers. They are **plain text and
meant to be edited** — when a flow changes, update the relevant fenced
` ```mermaid ` block here in the same PR. To preview edits live, paste a block
into the [Mermaid Live Editor](https://mermaid.live).

## Table of Contents

- [Actors & Contracts](#actors--contracts)
- [1. Contract Deployment & Wiring](#1-contract-deployment--wiring)
- [2. Route Whitelisting (Governance Setup)](#2-route-whitelisting-governance-setup)
- [3. Insurance Purchase](#3-insurance-purchase)
- [4. Risk-Taker (Underwriter) Flow](#4-risk-taker-underwriter-flow)
- [5. Flight Data → Classification → Settlement](#5-flight-data--classification--settlement)
- [6. Claim Processing](#6-claim-processing)

---

## Actors & Contracts

| Name in diagrams | What it is |
| --- | --- |
| **Deployer** | Address that installs and instantiates the contracts (also the initial owner). |
| **Owner / Admin** | Governs parameters and routes; can pause and upgrade. |
| **Traveler** | Insurance buyer / policy holder. |
| **Underwriter** | Liquidity provider (risk taker) who deposits capital into the vault for yield. |
| **Oracle backend** | Off-chain cron that pushes flight outcomes on-chain (the authorized oracle). |
| **Keeper** | Off-chain cron that drives classification, settlement, and queue maintenance. |
| **Controller** | Orchestrator wiring governance, vault, oracle, and pool together. |
| **Governance** | `GovernanceModule` — route whitelist and premium/payoff/delay terms. |
| **Vault** | `RiskVault` — ERC-4626-style vault holding collateral; pays claims. |
| **Pool** | `FlightPoolManager` — per-flight buyers, premiums, and claim payouts. |
| **Oracle** | `OracleAggregator` — flight-status state machine and active-flight list. |
| **Asset** | The settlement token (USDC SAC / `mock_usdc`) premiums and payouts move in. |

---

## 1. Contract Deployment & Wiring

Deployment order is dictated by constructor dependencies: each contract that
references another needs that address at construction time. The oracle must
exist before the vault (the vault constructor takes the oracle address for its
settlement barrier), the vault must exist before the pool (the pool constructor
takes the vault address), and all four modules must exist before the controller. Finally, the three module contracts are
told the controller's address via one-time `set_controller` calls — this closes
the trust loop so they only accept privileged calls from the controller.

```mermaid
sequenceDiagram
    autonumber
    actor Deployer
    participant Asset as Asset (USDC SAC)
    participant Gov as Governance
    participant Oracle as Oracle
    participant Vault as Vault
    participant Pool as Pool
    participant Ctrl as Controller

    Note over Deployer,Ctrl: Step A — deploy leaf contracts (Gov and Oracle have no inter-deps)
    Deployer->>Asset: deploy / use existing SAC
    Deployer->>Gov: __constructor(owner, default_premium, default_payoff, default_delay_hours)
    Deployer->>Oracle: __constructor(owner, authorized_oracle)

    Note over Deployer,Ctrl: Step B — Vault needs Oracle (settlement barrier), Pool needs Vault
    Deployer->>Vault: __constructor(owner, asset_token, oracle)
    Deployer->>Pool: __constructor(owner, asset_token, risk_vault)

    Note over Deployer,Ctrl: Step C — Controller needs every module address
    Deployer->>Ctrl: __constructor(owner, governance, risk_vault, oracle,<br/>flight_pool_manager, asset_token, keeper,<br/>min_lead_time, claim_expiry_window)

    Note over Deployer,Ctrl: Step D — wire the controller back into each module (one-time)
    Deployer->>Vault: set_controller(controller)
    Deployer->>Pool: set_controller(controller)
    Deployer->>Oracle: set_controller(controller)
    Note over Vault,Oracle: set_controller is idempotent-guarded —<br/>a second call reverts (ControllerAlreadySet)
```

---

## 2. Route Whitelisting (Governance Setup)

Before any flight can be insured, the route must be known to governance. The
owner sets global default terms and grants admin rights; an admin then
whitelists the specific route (optionally overriding the defaults). A purchase
later reads these terms via `route_status`.

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Owner / Admin
    participant Gov as Governance

    Owner->>Gov: set_defaults(premium, payoff, delay_hours)
    Note right of Gov: validates payoff exceeds premium, bounds delay
    Owner->>Gov: add_admin(admin_addr)
    Owner->>Gov: whitelist_route(flight_id, origin, dest, terms?)
    Note right of Gov: stores RouteStatus::Active(terms)
    Note over Owner,Gov: enable_route / disable_route / update_route_terms<br/>adjust an existing route later
```

---

## 3. Insurance Purchase

The traveler calls the controller once; the controller fans out to every module
atomically. If any step reverts (route disabled, too close to departure,
insufficient vault capital, duplicate policy), the whole transaction rolls back —
no premium is charged and no collateral is locked. Premium flows directly from
the traveler to the pool; collateral is locked in the vault to back the payoff.

```mermaid
sequenceDiagram
    autonumber
    actor Traveler
    participant Ctrl as Controller
    participant Gov as Governance
    participant Oracle as Oracle
    participant Pool as Pool
    participant Vault as Vault
    participant Asset as Asset

    Traveler->>Ctrl: buy_insurance(traveler, flight_id, origin, dest, date)
    Note over Ctrl: traveler.require_auth()<br/>date must be midnight-UTC aligned
    opt buyer whitelist enabled
        Ctrl->>Ctrl: approval valid (unexpired 180-day deadline) — else revert<br/>successful purchase slides the deadline forward
    end

    Ctrl->>Gov: route_status(flight_id, origin, dest)
    Gov-->>Ctrl: RouteStatus::Active(terms) | Disabled | Unknown
    Note over Ctrl: revert if not Active

    Note over Ctrl: enforce min lead time and max booking horizon
    Ctrl->>Oracle: get_flight_data(flight_id, date)
    Oracle-->>Ctrl: status (must be NotInitiated | Active)
    Ctrl->>Oracle: is_sale_open(flight_id, date)
    Oracle-->>Ctrl: must be true — live oracle sale attestation
    Note over Ctrl: revert SaleNotOpen if missing, lapsed or closed

    Ctrl->>Pool: get_flight_config(flight_id, date)
    Note over Ctrl: existing config binds later buyers to the first buyer's terms<br/>if it exists, oracle must have flight data — else revert OracleDataUnavailable
    opt existing config (snapshotted terms)
        Ctrl->>Gov: terms_valid(snapshot terms)
        Gov-->>Ctrl: must be true — snapshot re-checked against current term limits
        Note over Ctrl: revert SnapshotTermsExceedLimits if governance lowered the caps
    end

    Ctrl->>Pool: register_flight(flight_id, date, premium, payoff, delay_hours)
    Ctrl->>Oracle: register_flight(flight_id, date)
    Note over Pool,Oracle: both idempotent (parallel buyers safe)

    Ctrl->>Vault: get_total_managed_assets() + get_locked_capital()
    Vault-->>Ctrl: total_managed_assets, locked_capital
    Note over Ctrl: revert if total_managed_assets below<br/>ceil((locked_capital + payoff) * solvency_ratio / 100)

    Ctrl->>Asset: transfer(traveler → pool, premium)
    Ctrl->>Vault: increase_locked(payoff)
    Ctrl->>Pool: add_buyer(flight_id, date, traveler)
    Note over Pool: reverts AlreadyBuyer on duplicate policy<br/>(rolls back premium + lock)

    Ctrl->>Ctrl: append traveler index, bump counters
    Ctrl-->>Traveler: emit InsuranceBought
```

---

## 4. Risk-Taker (Underwriter) Flow

Underwriters supply the capital that backs payouts and earn the premiums of
on-time flights. **All entry and exit is two-phase**: a request escrows value
(USDC on entry, shares on exit) and the keeper's maintenance pass prices it
only once it is older than the LP pricing delay (6 h) — so the price a
request receives always reflects every flight outcome that was publicly
knowable when it was committed. FIFO ordering additionally means a latecomer
can't drain withdrawable capital (the assets above the vault's solvency
reserve on locked collateral) ahead of LPs already waiting.

```mermaid
sequenceDiagram
    autonumber
    actor U as Underwriter
    participant Vault as Vault
    participant Asset as Asset
    actor Keeper
    participant Ctrl as Controller

    rect rgba(96, 148, 255, 0.14)
    Note over U,Asset: Enter — request a deposit (escrows USDC)
    U->>Vault: request_deposit(assets)
    Vault->>Asset: transfer(underwriter → vault, assets)
    Vault->>Vault: push DepositRequest (assets escrowed, NOT in TMA)
    Vault-->>U: request_id
    Note over U,Vault: U may cancel_deposit(request_id) while queued
    end

    rect rgba(255, 160, 64, 0.14)
    Note over U,Vault: Exit — request a withdrawal (escrows shares)
    U->>Vault: request_withdrawal(shares)
    Vault->>Vault: escrow shares, push WithdrawalRequest
    Vault-->>U: request_id
    Note over U,Vault: U may cancel_withdrawal(request_id) while queued
    end

    rect rgba(64, 200, 112, 0.14)
    Note over Keeper,Vault: Keeper prices both queues (run_queue_maintenance)
    Keeper->>Ctrl: run_queue_maintenance(keeper)
    Ctrl->>Vault: process_deposit_queue()
    Note over Vault: FIFO, batched — no-op while a settlement is pending.<br/>Prices only requests older than the LP pricing delay.<br/>Mints shares at the CURRENT price, TMA += assets.<br/>Requests the price outgrew are returned (DepositDropped)
    Ctrl->>Vault: process_withdrawal_queue()
    Note over Vault: FIFO, batched — no-op while a settlement is pending.<br/>Prices only requests older than the LP pricing delay.<br/>Burns escrowed shares, credits ClaimableBalance (Credited).<br/>Pays only capital above the solvency reserve on locked collateral.<br/>Partially fills the head request when that capital runs short<br/>(RequestPartiallyFilled), then stops. Zero-value requests are<br/>dropped and their shares returned (RequestDropped)
    Ctrl->>Vault: snapshot() — refresh share-price snapshot
    end

    rect rgba(168, 112, 255, 0.14)
    Note over U,Asset: Collect — pull funds out
    U->>Vault: collect()
    Vault->>Asset: transfer(vault → underwriter, claimable)
    Vault-->>U: emit Collected
    end
```

---

## 5. Flight Data → Classification → Settlement

Settlement runs in three decoupled, keeper/oracle-driven phases. Decoupling
keeps each call's resource cost bounded and means a stuck settlement loop can't
block underwriter withdrawals. Each phase scans the oracle's active-flight list
with a rotating, batched cursor.

```mermaid
sequenceDiagram
    autonumber
    actor OB as Oracle backend
    actor Keeper
    participant Oracle as Oracle
    participant Ctrl as Controller
    participant Pool as Pool
    participant Vault as Vault
    participant Asset as Asset

    rect rgba(168, 112, 255, 0.14)
    Note over OB,Oracle: Phase 0 — attest sales (SaleAuthorizer cron)
    OB->>Oracle: open_sale(flight_id, date, expires_at)
    Note right of Oracle: verified scheduled + not cancelled — max 24h validity
    OB->>Oracle: close_sale() | set_cancelled()
    Note right of Oracle: unverifiable → close, cancelled → tombstone
    end

    rect rgba(96, 148, 255, 0.14)
    Note over OB,Oracle: Phase 1 — push outcomes (FlightDataFetcher cron)
    OB->>Oracle: set_estimated_arrival(...)
    Note right of Oracle: NotInitiated → Active
    OB->>Oracle: set_landed(actual_arrival) | set_cancelled()
    Note right of Oracle: Active → Landed / Cancelled
    end

    rect rgba(255, 160, 64, 0.14)
    Note over Keeper,Pool: Phase 2 — classify (FlightClassifier cron)
    Keeper->>Ctrl: classify_flights(keeper)
    Ctrl->>Oracle: get_active_flights_page(cursor, batch)
    loop each flight in batch
        Ctrl->>Oracle: get_flight_data(flight_id, date)
        opt Landed (needs delay threshold)
            Ctrl->>Pool: get_flight_config(flight_id, date)
        end
        Ctrl->>Oracle: set_to_be_settled(status: OnTime | Delayed | Cancelled)
    end
    end

    rect rgba(64, 200, 112, 0.14)
    Note over Keeper,Asset: Phase 3 — execute (SettlementExecutor cron)
    Keeper->>Ctrl: execute_settlements(keeper)
    Ctrl->>Oracle: get_active_flights_page(cursor, batch)
    loop each ToBeSettled* flight in batch
        Ctrl->>Pool: get_flight_config(flight_id, date)
        alt ToBeSettledOnTime
            Ctrl->>Pool: settle_on_time()
            Pool->>Asset: transfer(pool → vault, premium * buyers)
            Ctrl->>Vault: record_premium_income(premium_income)
            Ctrl->>Vault: decrease_locked(total_payoff)
        else ToBeSettledDelayed / Cancelled
            Ctrl->>Vault: send_payout(vault → pool, (payoff - premium) * buyers)
            Ctrl->>Vault: decrease_locked(total_payoff)
            Ctrl->>Pool: settle_delayed | settle_cancelled (opens claim window)
        end
        Ctrl->>Oracle: set_settled(flight_id, date)
    end
    end
```

> **Targeted fast path:** the sweeps above are the repair backstop, not the
> primary latency path. Right after Phase 1 writes an outcome, the executor
> calls `classify_flight(keeper, flight_id, date)` and then
> `settle_flight(keeper, flight_id, date)` for that exact tuple — the same
> Phase 2/3 logic without the active-list scan — so a fresh outcome normally
> settles (and the vault settlement barrier releases) within seconds,
> independent of active-set size.
>
> **Housekeeping:** `prune_settled()` (permissionless) later evicts flights
> that have been settled beyond the retention window from the active list.

---

## 6. Claim Processing

After a delayed/cancelled flight settles, the payout funds sit in the pool and
the claim window is open. Each insured traveler pulls their own payoff. After the
window closes, anyone can sweep the unclaimed remainder back to the owner's
recoverable balance.

```mermaid
sequenceDiagram
    autonumber
    actor Traveler
    actor Anyone
    actor Owner
    participant Pool as Pool
    participant Asset as Asset

    rect rgba(64, 200, 112, 0.14)
    Note over Traveler,Asset: Claim within the window
    Traveler->>Pool: claim(flight_id, date)
    Note over Pool: traveler.require_auth()<br/>checks: SettledDelayed/Cancelled,<br/>window open, has policy, not already claimed
    Pool->>Pool: mark claimed, claimed_count++
    Pool->>Asset: transfer(pool → traveler, payoff)
    Pool-->>Traveler: emit PayoutClaimed
    end

    rect rgba(255, 160, 64, 0.14)
    Note over Anyone,Owner: After the window closes
    Anyone->>Pool: sweep_expired(flight_id, date)
    Note over Pool: credits unclaimed payoffs to RecoveredBalance<br/>(idempotent), emits ExpiredSwept
    Owner->>Pool: withdraw_recovered(amount)
    Pool->>Asset: transfer(pool → owner, amount)
    Pool-->>Owner: emit RecoveredWithdrawn
    end
```
