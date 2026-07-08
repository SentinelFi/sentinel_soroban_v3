# Nethermind AuditAgent AI: Sentinel FlightPoolManager Findings Report

**Date:** 4 July 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol FlightPoolManager. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

---

## Assessment Information

| | |
| --- | --- |
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-07-04 |
| **Report Version** | v1.0 |
| **Assessment Status** | Final |
| **Assessment Type** | AI-Assisted Internal Security Review |
| **Auditor(s)** | Nethermind AuditAgent AI Auditor |
| **Assessment Platform** | [https://app.auditagent.nethermind.io/](https://app.auditagent.nethermind.io/) |

---

## Repository Information

| | |
| --- | --- |
| **Repository URL** | [SentinelFi/sentinel_soroban_v3](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main) |
| **Repository Visibility** | Public |
| **Branch Name** | `main` |
| **Git Commit Hash** | `6b0db9ea9d6b1a349e16490942a75d4ae936a7f7` |
| **Assessment Snapshot** | Source code state corresponding to the commit hash above |

---

## Scope

### In Scope

- `contracts/flight_pool_manager/src/admin.rs`
- `contracts/flight_pool_manager/src/auth.rs`
- `contracts/flight_pool_manager/src/claim.rs`
- `contracts/flight_pool_manager/src/constants.rs`
- `contracts/flight_pool_manager/src/error.rs`
- `contracts/flight_pool_manager/src/events.rs`
- `contracts/flight_pool_manager/src/lib.rs`
- `contracts/flight_pool_manager/src/lifecycle.rs`
- `contracts/flight_pool_manager/src/queries.rs`
- `contracts/flight_pool_manager/src/settle.rs`
- `contracts/flight_pool_manager/src/storage.rs`
- `contracts/flight_pool_manager/src/traits.rs`
- `contracts/flight_pool_manager/src/upgrade.rs`

Controller, OracleAggregator, and RiskVault were reviewed where required to trace policy purchase, active-flight registration, settlement removal, and collateral-locking behavior across contract boundaries.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner, Controller, keeper, or oracle credentials
- Contracts outside the FlightPoolManager integration boundary, except for impact analysis
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified three findings: one Medium-severity protocol-capacity issue and two Low-severity lifecycle/liveness issues.

The finding concerns FlightPoolManager's global `ActiveFlightList`. The contract stores all unsettled flight buckets in one shared list and rejects new unique flight registrations once the list reaches 1,000 entries. A user who can purchase policies across many distinct whitelisted future flight/date pairs can consume this shared capacity and prevent unrelated users from opening new policy buckets until existing flights settle and are removed.

The Low findings concern persistent entitlement lifetime and instance-TTL hygiene. Buyer proof keys are written at purchase time with a fixed 180-day TTL, while claim expiry is opened at settlement time; if settlement is delayed beyond the remaining TTL margin, a valid policyholder can lose the ability to claim. Separately, some owner maintenance paths mutate instance state without extending the contract instance TTL, which can leave the contract close to archival after emergency administration.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-FPM-01 | Medium | Global active-flight cap can halt new policy-bucket registration |
| AA-FPM-02 | Low | Buyer proof TTL does not account for delayed settlement |
| AA-FPM-03 | Low | Owner maintenance paths do not refresh instance TTL |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 1 | 2 | 0 |

### Overall Risk Rating

**Medium**

The issue can deny new policy sales protocol-wide once shared active-flight capacity is saturated. It does not directly steal funds, and each occupied slot requires a valid purchase with premium payment and vault collateral availability, but the effect is global rather than isolated to the buyer.

---

# Detailed Findings

## [AA-FPM-01] Global active-flight cap can halt new policy-bucket registration

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `register_flight`, `ActiveFlightList`, Controller `buy_insurance`, and settlement removal |
| **Impact** | New policy buckets can be denied protocol-wide until active flights settle |

### Description

FlightPoolManager is a singleton that tracks all active policy buckets in one global instance-storage list:

```rust
let mut list: Vec<(Symbol, u64)> = e
    .storage()
    .instance()
    .get(&PoolKey::ActiveFlightList)
    .unwrap_or(Vec::new(e));
```

The list is explicitly capped:

```rust
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 1_000;
```

Every first registration of a new `(flight_id, date)` appends one entry. Once the list reaches the cap, registration fails with `ActiveFlightListFull`:

```rust
if list.len() >= MAX_ACTIVE_FLIGHTS {
    panic_with_error!(e, Error::ActiveFlightListFull);
}
list.push_back((flight_id.clone(), date));
e.storage()
    .instance()
    .set(&PoolKey::ActiveFlightList, &list);
```

Controller reaches this path during `buy_insurance` before premium transfer, collateral locking, and buyer recording:

```rust
pool.register_flight(
    &controller_addr,
    &flight_id,
    &date,
    &terms.premium,
    &terms.payoff,
    &terms.delay_hours,
);
```

Duplicate purchases for an existing `(flight_id, date)` do not consume additional active-list slots. However, each distinct registered flight/date bucket consumes one slot until settlement removes it:

```rust
cfg.status = SettlementStatus::SettledOnTime;
e.storage().persistent().set(&cfg_key, &cfg);
prune_active_list(e, &flight_id, date);
```

Delayed and cancelled settlements also call `prune_active_list` after opening the claim window. Capacity is therefore restored only as the keeper and oracle pipeline advance active buckets to settlement.

### Failure Scenario

1. Many whitelisted flight/date buckets are available within the Controller's booking horizon.
2. A buyer, or coordinated buyers, purchases one policy for each distinct bucket.
3. FlightPoolManager appends each new `(flight_id, date)` to `ActiveFlightList`.
4. The list reaches `MAX_ACTIVE_FLIGHTS` with 1,000 active buckets.
5. An unrelated user attempts to buy insurance for a new flight/date bucket.
6. `register_flight` reverts with `ActiveFlightListFull`, causing the purchase transaction to fail.
7. New bucket creation remains unavailable until existing active flights settle and are pruned from the list.

### Impact

Saturating the global active-flight list blocks new policy-bucket creation for the entire protocol. The effect can:

- halt new policy sales for unrelated routes and users;
- make protocol availability depend on active settlement throughput;
- reduce usable underwriting capacity while attacker-created policies remain live;
- compound liquidity pressure because every purchased policy also locks vault collateral until settlement.

The attack cost is not zero: each occupied slot requires a valid route, a future day-aligned date within the booking horizon, a premium payment, and sufficient vault solvency. These constraints limit severity to Medium. The impact remains material because the bottleneck is global and admission denial affects honest users who are not related to the saturated buckets.

### Recommendation

Avoid making one bounded global vector the scarce resource for policy-bucket admission. Suitable approaches include:

1. Replace the monolithic active list with individually keyed active-flight records and paginated indexes.
2. Allocate active-flight capacity per route, per epoch, or per market segment so one buyer cannot consume all protocol-wide capacity.
3. Require a higher economic cost for opening a new bucket than for joining an existing bucket, calibrated to the shared capacity consumed.
4. Add operational monitoring and alerts for active-flight count, settlement backlog, and cap utilization.
5. Expose paginated active-flight reads and bounded keeper work queues that do not rely on rewriting one large list.

Until storage is migrated, the explicit cap should be treated as a production capacity limit and incorporated into launch parameters, route onboarding, keeper cadence, and incident response procedures.

---

## [AA-FPM-02] Buyer proof TTL does not account for delayed settlement

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `add_buyer`, `claim`, `sweep_expired`, and Controller settlement timing |
| **Impact** | Valid policyholder can lose claim eligibility after a prolonged settlement delay |

### Description

FlightPoolManager records policy ownership in a per-buyer persistent key when the policy is purchased:

```rust
let buyer_key = PoolKey::Buyer(flight_id.clone(), date, buyer.clone());
let existing: Option<bool> = e.storage().persistent().get(&buyer_key);
if existing.is_some() {
    panic_with_error!(e, Error::AlreadyBuyer);
}

e.storage().persistent().set(&buyer_key, &true);
e.storage()
    .persistent()
    .extend_ttl(&buyer_key, BUYER_TTL_LEDGERS, BUYER_TTL_LEDGERS);
```

`BUYER_TTL_LEDGERS` is approximately 180 days:

```rust
pub(crate) const BUYER_TTL_LEDGERS: u32 = 3_110_400;
```

The claim path treats an archived buyer key the same as no policy:

```rust
let has_policy: bool = e.storage().persistent().get(&buyer_key).unwrap_or(false);
if !(has_policy) {
    panic_with_error!(e, Error::NoPolicy);
}
```

Flight-level `FlightConfig` entries are extended through settlement and claim expiry, but individual buyer keys cannot be refreshed at settlement because the contract does not store an iterable buyer list. The buyer-key lifetime is therefore fixed from purchase time.

Current Controller bounds reserve 90 days for book-ahead and 60 days for the claim window, leaving roughly 30 days of margin inside the 180-day buyer-key TTL. That margin is consumed by any delay between scheduled departure and settlement execution. If settlement opens the claim window more than 30 days after departure for a maximum-horizon policy, the claim deadline can extend past the buyer proof's guaranteed lifetime.

### Failure Scenario

1. A traveler purchases a policy near the 90-day booking horizon.
2. FlightPoolManager writes `Buyer(flight_id, date, traveler)` with a fixed 180-day TTL.
3. The flight is delayed or cancelled.
4. Oracle classification or keeper settlement is unavailable for more than 30 days after departure.
5. Settlement later opens a claim window from the current ledger timestamp.
6. The flight config remains claimable, but the buyer proof can archive before the claim window ends.
7. The traveler calls `claim` and receives `NoPolicy`.
8. After claim expiry, the funded but unclaimed payout can be swept into recovered balance.

### Impact

A valid policyholder can lose the ability to claim solely because entitlement storage expires before the settlement-derived claim deadline. The issue requires a prolonged settlement delay and does not affect normally settled flights, supporting Low severity.

The same archival behavior can also allow the same address to be added again while a bucket remains active if the original buyer key archives before settlement. Under current booking and TTL bounds this requires an extended pre-settlement delay, but it further shows that `buyer_count` can outlive the live set of buyer proof keys.

### Recommendation

Ensure buyer proof lifetime covers the settlement-derived claim deadline:

1. Store buyer records in an iterable per-flight structure so settlement can renew every buyer proof through `claim_expiry`.
2. Store purchase timestamps or absolute proof expiries and cap `claim_expiry` so it never exceeds the remaining buyer-proof lifetime.
3. Add an explicit maximum settlement-delay assumption to the Controller bounds and enforce it on-chain before opening a claim window.
4. Add tests for maximum-horizon purchases where settlement is delayed beyond the reserved margin.

---

## [AA-FPM-03] Owner maintenance paths do not refresh instance TTL

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `withdraw_recovered`, `pause`, `unpause`, and instance storage |
| **Impact** | Emergency or recovery administration can leave the contract close to archival |

### Description

FlightPoolManager stores shared configuration and accounting in instance storage, including the controller address, asset token, RiskVault address, active-flight list, recovered balance, and pause state. Hot-path lifecycle functions call `extend_instance_ttl` either directly or through controller authorization.

Some owner maintenance paths mutate instance state without refreshing the instance TTL. `withdraw_recovered` updates `RecoveredBalance` and transfers assets, but does not call `extend_instance_ttl`:

```rust
e.storage().instance().set(
    &PoolKey::RecoveredBalance,
    &recovered
        .checked_sub(amount)
        .expect("subtraction underflow"),
);
```

The Pausable trait implementation also mutates pause state without extending instance TTL:

```rust
fn pause(e: &Env, caller: Address) {
    let _ = caller;
    let owner = ownable::get_owner(e).expect("owner not set");
    owner.require_auth();
    pausable::pause(e);
}
```

```rust
fn unpause(e: &Env, caller: Address) {
    let _ = caller;
    let owner = ownable::get_owner(e).expect("owner not set");
    owner.require_auth();
    pausable::unpause(e);
}
```

If the external TTL maintenance process is degraded and the instance is already near expiry, these administrative calls can succeed while leaving the instance close to archival.

### Failure Scenario

1. The off-chain TTL extension process is delayed or unavailable.
2. FlightPoolManager instance storage approaches its archival threshold.
3. The owner pauses the contract during an incident or withdraws recovered funds.
4. The call mutates instance state but does not refresh the instance TTL.
5. The instance archives shortly afterward.
6. Claims, settlement-related calls, and additional administration require manual footprint restoration before normal operation can continue.

### Impact

The issue is an operational liveness risk rather than a direct fund-loss vulnerability. It is most relevant during incidents, when pause or recovery actions are likely and TTL automation may already be impaired. Manual restoration remains possible, supporting Low severity.

### Recommendation

Call `extend_instance_ttl(e)` in every owner or administrative path that mutates instance state, including `withdraw_recovered`, `pause`, and `unpause`. Add regression tests that exercise these paths near the instance TTL threshold and assert that the instance TTL is extended.

---

## Methodology

The assessment included:

- direct review of all in-scope FlightPoolManager source files;
- Controller purchase flow review for active-flight registration reachability;
- settlement-path review for active-list removal behavior;
- buyer proof, claimed proof, and claim-window lifetime analysis;
- owner maintenance and instance-TTL hygiene review;
- active-list capacity and singleton storage analysis;
- review of existing active-list cap tests and error handling;
- cross-contract review of collateral-locking and policy lifecycle effects.

The review focused on reachable behavior in the assessed integration under the stated trust model.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. The assessment does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, operational failures, or economic risks.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of the assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

The assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial advice;
- investment advice;
- compliance certification;
- a substitute for professional security auditing services.

Neither the assessment provider, report author, AI systems used during analysis, nor any affiliated parties shall be liable for direct, indirect, incidental, consequential, special, or punitive damages arising from use of this report or reliance on its contents.
