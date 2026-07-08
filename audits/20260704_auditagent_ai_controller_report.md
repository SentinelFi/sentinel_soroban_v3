# Nethermind AuditAgent AI: Sentinel Controller Findings Report

**Date:** 4 July 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol Controller. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

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

- `contracts/controller/src/constants.rs`
- `contracts/controller/src/events.rs`
- `contracts/controller/src/interfaces.rs`
- `contracts/controller/src/lib.rs`
- `contracts/controller/src/purchase.rs`
- `contracts/controller/src/settle.rs`
- `contracts/controller/src/storage.rs`
- `contracts/controller/src/traits.rs`
- `contracts/controller/src/upgrade.rs`
- `contracts/controller/src/whitelist.rs`

FlightPoolManager, GovernanceModule, and OracleAggregator were reviewed where necessary to assess policy lifetime, route-term, and active-list assumptions.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner, governance administrator, keeper, or oracle credentials
- Contracts outside the Controller integration boundary, except for impact analysis
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified four findings: one High-severity issue, two Low-severity issues, and one Informational issue.

The High finding concerns the purchase path accepting whitelisted route/date combinations that have no confirmed flight instance. A purchase can register a future day in the Pool and Oracle while the Oracle row remains `NotInitiated`; if no off-chain data ever transitions that row to a terminal outcome, the policy remains active indefinitely and the associated vault collateral is never released.

The Low findings concern policy lifetime and route-term consistency. First, the fixed lifetime of FlightPoolManager buyer-ownership keys does not account for delayed settlement. The Controller allows a policy to be purchased 90 days before departure and opens a claim window of up to 60 days from the eventual settlement time. The compile-time invariant accounts for departure plus claim-window duration, but not for a delayed settlement. A post-departure processing outage longer than the remaining 30-day margin can therefore leave a valid claim window open after the buyer key archives. Second, Governance route/default term changes made after the first purchase for a `(flight_id, date)` can cause later purchases for that same bucket to revert because FlightPoolManager pins the initial terms and rejects mismatched re-registration.

The Informational finding concerns whitelist authorization stored in expiring persistent entries. Dormant approved buyers lose authorization after approximately 180 days unless an administrator refreshes the entry. Active buyers refresh their own entry during purchases, but a buyer whose entry has archived cannot self-refresh because the purchase gate rejects the transaction first.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-CT-01 | Low | Buyer-key lifetime does not account for delayed settlement |
| AA-CT-02 | Informational | Dormant whitelist approvals expire without explicit revocation |
| AA-CT-03 | High | Unconfirmed flight dates can lock vault capital indefinitely |
| AA-CT-04 | Low | Route term changes can block later purchases for active flight buckets |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 0 | 2 | 1 |

### Overall Risk Rating

**High**

The principal security impact is an availability and capital-efficiency failure. The Controller can sell policies for future dates that are not confirmed to correspond to an actual scheduled flight, and the settlement pipeline has no on-chain timeout for rows that remain `NotInitiated`. A buyer can therefore consume vault capacity at the premium cost and keep it locked until off-chain intervention or contract migration restores progress.

---

# Detailed Findings

## [AA-CT-01] Buyer-key lifetime does not account for delayed settlement

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | Controller claim-window bounds, `execute_settlements`, and FlightPoolManager buyer keys |
| **Impact** | Valid policyholder can lose the ability to claim after a prolonged settlement outage |

### Description

The Controller enforces this compile-time lifetime invariant:

```rust
const _: () = assert!(
    MAX_BOOK_AHEAD_SECS + MAX_CLAIM_EXPIRY_WINDOW_SECS <= BUYER_KEY_TTL_SECS,
    "book-ahead + claim window must not exceed the buyer key TTL",
);
```

The relevant limits are:

```rust
MAX_BOOK_AHEAD_SECS = 90 days
MAX_CLAIM_EXPIRY_WINDOW_SECS = 60 days
BUYER_KEY_TTL_SECS = 180 days
```

However, the claim deadline is not necessarily `flight_date + claim_window`. `execute_settlements` derives it from the time settlement is executed:

```rust
let claim_expiry = e
    .ledger()
    .timestamp()
    .checked_add(claim_window)
    .expect("addition overflow");
```

FlightPoolManager writes each `Buyer(flight_id, date, address)` key when the policy is purchased with a fixed 180-day TTL. It cannot iterate all buyers to renew those keys when settlement later establishes the claim deadline.

The actual worst-case lifetime is therefore:

```text
purchase time → scheduled departure → settlement delay → claim window
```

The current arithmetic leaves at most 30 days for settlement delay when a policy is purchased at the 90-day horizon and uses the maximum 60-day claim window.

### Failure Scenario

1. A traveler purchases a policy 90 days before departure.
2. The buyer key receives its fixed 180-day TTL.
3. Classification or settlement is unavailable for more than 30 days after departure.
4. Settlement resumes and establishes a claim deadline 60 days in the future.
5. The buyer key archives before that deadline.
6. The traveler cannot satisfy FlightPoolManager's ownership check, even though the claim window remains open.
7. After expiry, unclaimed funds can be swept through the normal expiry path.

### Impact

The condition can permanently deny a valid delayed or cancelled-flight claim. It requires a prolonged operational outage, and archived persistent state may be externally restored, which limits exploitability and supports a Low severity classification.

### Recommendation

Do not create a claim deadline that extends beyond the guaranteed buyer-key lifetime.

Preferred options:

1. Store each buyer key's absolute expiry or purchase timestamp and cap `claim_expiry` to a safely earlier deadline.
2. Redesign buyer ownership storage so it can be renewed at settlement, for example through paginated buyer records.
3. Reduce the booking horizon or maximum claim window enough to reserve an explicit maximum settlement-delay allowance.
4. Add monitored restoration procedures for buyer keys and test the maximum-horizon, delayed-settlement boundary.

---

## [AA-CT-02] Dormant whitelist approvals expire without explicit revocation

| Field | Value |
| --- | --- |
| **Severity** | Informational |
| **Affected Components** | `BuyerWhitelisted`, whitelist reads, and the purchase gate |
| **Impact** | Silent loss of purchasing authorization for dormant approved buyers |

### Description

Whitelist membership is stored in a persistent key and extended to approximately 180 days when written:

```rust
pub(crate) fn write_buyer_whitelisted(e: &Env, addr: &Address, allowed: bool) {
    let key = CtrlKey::BuyerWhitelisted(addr.clone());
    e.storage().persistent().set(&key, &allowed);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}
```

An approved buyer refreshes the entry while purchasing. A bare status read does not renew it:

```rust
pub(crate) fn read_buyer_whitelisted(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&CtrlKey::BuyerWhitelisted(addr.clone()))
        .unwrap_or(false)
}
```

If an approved buyer remains inactive until the entry archives, the next whitelist check returns `false`. The purchase is rejected before `touch_buyer_whitelisted` can refresh the entry, leaving privileged re-approval as the normal recovery path.

### Impact

Authorization changes as a consequence of storage lifetime rather than an explicit governance action. This does not expose funds or bypass authorization, but it can unexpectedly deny purchases to dormant approved users.

### Recommendation

Choose and document one explicit authorization model:

- If approvals are intended to expire, store and expose an explicit approval expiry and require periodic renewal.
- If approvals are intended to remain until revoked, include whitelist keys in a monitored TTL-extension process or move the bounded whitelist to non-divergent storage.
- Emit operational alerts before approval entries approach archival.

---

## [AA-CT-03] Unconfirmed flight dates can lock vault capital indefinitely

| Field | Value |
| --- | --- |
| **Severity** | High |
| **Affected Components** | `buy_insurance`, OracleAggregator registration, `classify_flights`, and `execute_settlements` |
| **Impact** | Attacker can lock vault collateral and consume sellable capacity for flight dates that never become settleable |

### Description

`buy_insurance` validates route approval, minimum lead time, maximum booking horizon, day alignment, and current oracle status. It permits purchase while the Oracle status is `NotInitiated`:

```rust
let oracle_status = oracle.get_flight_data(&flight_id, &date).status;
if !matches!(
    oracle_status,
    FlightStatus::NotInitiated | FlightStatus::Active
) {
    panic_with_error!(e, Error::FlightNotOpenForPurchase);
}
```

The function then registers the `(flight_id, date)` in FlightPoolManager and OracleAggregator, transfers the premium, locks the full payoff in the RiskVault, and records the buyer:

```rust
pool.register_flight(
    &controller_addr,
    &flight_id,
    &date,
    &terms.premium,
    &terms.payoff,
    &terms.delay_hours,
);
oracle.register_flight(&controller_addr, &flight_id, &date);
asset.transfer(&traveler, &pool_addr, &terms.premium);
vault.increase_locked(&controller_addr, &terms.payoff);
pool.add_buyer(&controller_addr, &flight_id, &date, &traveler);
```

OracleAggregator registration creates a `FlightData` row with `FlightStatus::NotInitiated`. The Controller's classification loop treats `NotInitiated` as a diagnostic condition only:

```rust
FlightStatus::NotInitiated => {
    TtlMiss {
        flight_id: flight_id.clone(),
        date,
    }
    .publish(e);
    None
}
```

`execute_settlements` only processes `ToBeSettledOnTime`, `ToBeSettledDelayed`, and `ToBeSettledCancelled`. A row that remains `NotInitiated` is therefore not settled, does not unlock vault collateral, and does not remove the active policy state from the Pool. The only route to ordinary settlement is for the authorized oracle to later move the row into `Active`, `Landed`, or `Cancelled`.

Because the purchase path accepts any future day-aligned date for a whitelisted route, it does not prove that the specific date corresponds to an actual scheduled flight instance. If no off-chain flight data exists for that date, the on-chain state can remain active with no automatic timeout or refund path.

### Failure Scenario

1. A route is whitelisted for `flight_id`, `origin`, and `dest`.
2. A buyer selects a future day-aligned `date` within the 90-day booking horizon that has no actual scheduled flight instance.
3. `buy_insurance` observes `NotInitiated`, registers the flight, transfers the premium to FlightPoolManager, and locks `terms.payoff` in the RiskVault.
4. The authorized oracle never publishes estimated arrival, landed, or cancelled data for that nonexistent date.
5. `classify_flights` repeatedly emits `TtlMiss` and leaves the status unchanged.
6. `execute_settlements` ignores the row because it is not in a `ToBeSettled*` status.
7. Vault locked capital remains elevated and the policy bucket remains active indefinitely.

### Impact

An attacker can consume sellable vault capacity and reduce underwriter withdrawal headroom by repeatedly buying policies for invalid future dates. The direct attacker cost is the premium, but the amount of collateral locked is the full payoff. Multiple traveler addresses can bypass the per-traveler single-policy guard for the same `(flight_id, date)`, increasing the locked amount until solvency checks or available capital stop additional sales.

The issue does not require compromise of the keeper or oracle. It relies on the absence of an on-chain existence check and the absence of an expiry path for purchased rows that never leave `NotInitiated`.

### Recommendation

Bind purchase eligibility to a concrete flight instance before collateral is locked. Viable designs include:

1. Require the authorized oracle to pre-register or pre-confirm scheduled flight instances before Controller purchase is allowed.
2. Reject `NotInitiated` purchases and only allow purchase once the oracle has set a pre-departure status that confirms the flight exists.
3. Add an on-chain timeout for purchased rows that remain `NotInitiated` beyond a bounded period after scheduled departure, releasing locked collateral and defining premium/refund treatment explicitly.
4. Store a purchase deadline and cancellation deadline per policy bucket so stale pre-outcome buckets can be closed without relying on off-chain manual intervention.

---

## [AA-CT-04] Route term changes can block later purchases for active flight buckets

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `buy_insurance`, GovernanceModule route/default terms, and FlightPoolManager `register_flight` |
| **Impact** | Subsequent buyers can be prevented from purchasing coverage for a flight date that already has an active pool bucket |

### Description

The Controller fetches current Governance terms on every purchase:

```rust
let terms = match gov.route_status(&flight_id, &origin, &dest) {
    RouteStatus::Active(t) => t,
    RouteStatus::Disabled => panic_with_error!(e, Error::RouteDisabled),
    RouteStatus::Unknown => panic_with_error!(e, Error::RouteNotWhitelisted),
};
```

It then passes those current terms to FlightPoolManager:

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

FlightPoolManager stores the first terms for a `(flight_id, date)` bucket and requires every later registration of the same bucket to provide exactly the same `premium`, `payoff`, and `delay_hours`:

```rust
if let Some(existing) = e.storage().persistent().get::<_, FlightConfig>(&key) {
    if !(existing.premium == premium
        && existing.payoff == payoff
        && existing.delay_hours == delay_hours)
    {
        panic_with_error!(e, Error::FlightTermsMismatch);
    }
    extend_flight_ttl_to(e, &flight_id, date, date);
    return;
}
```

This protects already-created pools from silent term swaps, but it also means that an administrative route/default term update can close an already-open `(flight_id, date)` bucket to additional buyers. A later buyer sees the updated terms from Governance, while the Pool still enforces the original bucket terms.

GovernanceModule's `FlightRoute(flight_id)` uniqueness index prevents two active `(origin, dest)` routes from sharing the same `flight_id` under normal conditions. The issue therefore arises from route/default term changes for a bucket that already has at least one buyer.

### Failure Scenario

1. Buyer A purchases insurance for `(flight_id, date)` while Governance terms are `premium = P1`, `payoff = X1`, and `delay_hours = D1`.
2. FlightPoolManager creates the bucket and stores `P1/X1/D1`.
3. Governance updates the route terms or mutable defaults so the route now resolves to `P2/X2/D2`.
4. Buyer B attempts to purchase coverage for the same `(flight_id, date)`.
5. Controller reads `P2/X2/D2` from Governance and calls `pool.register_flight`.
6. FlightPoolManager detects a mismatch against `P1/X1/D1` and reverts with `FlightTermsMismatch`.

### Impact

The active bucket becomes unavailable for later buyers until the route terms are restored to match the bucket's original terms or the flight settles. This can surprise operators during routine repricing and can deny coverage to buyers for a date that is otherwise still open for purchase. The impact is limited because it requires an authorized route/default term change and protects existing buyers from silent economics changes.

### Recommendation

Make the term model explicit for already-open buckets:

1. Before accepting a purchase for an existing `(flight_id, date)`, read the Pool's stored config and charge/lock against those pinned terms rather than current Governance terms.
2. Alternatively, reject administrative term changes while matching active flight buckets exist, or require new terms to apply only to future buckets created after the change.
3. Expose a read path for bucket-level terms so frontends and operators can distinguish current route terms from pinned policy-bucket terms.
4. Add tests for route/default term changes after the first buyer and before settlement.

---

## Methodology

The assessment included:

- direct review of all in-scope Controller source files;
- Controller purchase, settlement, and whitelist code review;
- policy-lifetime and route-term tracing into FlightPoolManager;
- route/default term review in GovernanceModule;
- active-list boundary tracing into OracleAggregator;
- execution of the Controller, GovernanceModule, and OracleAggregator unit suites.

The relevant contract suites completed successfully with 137 passing tests and no failures.

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
