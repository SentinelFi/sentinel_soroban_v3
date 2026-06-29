# Nethermind AuditAgent AI: Sentinel Controller Findings Report

**Date:** 25 June 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol Controller. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

---

## Assessment Information

| | |
| --- | --- |
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-06-25 |
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
| **Git Commit Hash** | `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7` |
| **Assessment Snapshot** | Source code state corresponding to the commit hash above |

---

## Scope

### In Scope

- `contracts/controller/src/purchase.rs`
- `contracts/controller/src/constants.rs`
- `contracts/controller/src/storage.rs`
- `contracts/controller/src/lib.rs`
- `contracts/controller/src/interfaces.rs`
- `contracts/controller/src/whitelist.rs`

GovernanceModule, FlightPoolManager, OracleAggregator, and RiskVault were reviewed where necessary to trace cross-contract behavior and determine impact.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner, governance administrator, keeper, or oracle credentials
- Contracts outside the Controller integration boundary, except for impact analysis
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified three findings: two Medium-severity issues and one Low-severity issue.

The first Medium finding is an identity mismatch between route authorization and downstream policy state. Controller validates the full `(flight_id, origin, destination)` tuple but records the resulting policy only under `(flight_id, date)`. Governance intends to prevent conflicting routes through a separate uniqueness index, but that index can expire independently. If conflicting routes become active, Controller cannot preserve which approved route a policy represents, allowing route outcomes and buyers to collide.

The second Medium finding affects the append-only `TravelerFlights` index. Every purchase reads and rewrites one unbounded vector for the traveler. The persistent entry reaches the 65,536-byte contract-data limit at approximately 1,640 entries with a short flight symbol, after which the address cannot purchase additional policies.

The Low finding is an allowed parameter combination that makes the purchase interval empty. `min_lead_time` may equal the maximum 90-day booking horizon, but purchases require a departure strictly later than the minimum lead and no later than the maximum horizon.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-CT-01 | Medium | Route dimensions are dropped from policy identity after authorization |
| AA-CT-02 | Medium | TravelerFlights grows into a per-address permanent purchase denial |
| AA-CT-03 | Low | Maximum allowed minimum lead time disables all policy purchases |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 1 | 0 |

### Overall Risk Rating

**Medium**

The route-identity issue can associate policies with the wrong physical flight lifecycle, while the traveler index imposes a deterministic long-term purchase ceiling. Neither issue directly bypasses authorization, but both can break core policy functionality under reachable states.

---

# Detailed Findings

## [AA-CT-01] Route dimensions are dropped from policy identity after authorization

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `buy_insurance`, Controller cross-contract interfaces, traveler indexing, FlightPoolManager and OracleAggregator integration |
| **Impact** | Policy-state collision, incorrect outcome attribution, and purchase denial |

### Description

Controller authorizes a policy using the complete governance route:

```rust
let terms = match gov.route_status(&flight_id, &origin, &dest) {
    RouteStatus::Active(t) => t,
    RouteStatus::Disabled => panic_with_error!(e, Error::RouteDisabled),
    RouteStatus::Unknown => panic_with_error!(e, Error::RouteNotWhitelisted),
};
```

After this check, `origin` and `dest` are discarded. FlightPoolManager and OracleAggregator receive only `flight_id` and `date`:

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
```

Buyer records, claims, flight configurations, oracle outcomes, and the Controller's traveler index all use the reduced identity:

```text
(flight_id, date)
```

The architecture relies on GovernanceModule ensuring that one flight ID maps to only one `(origin, destination)` pair. However, that constraint is stored in a separate persistent `FlightRoute(flight_id)` index whose TTL is not renewed alongside actively used routes. Once the index archives, governance can contain two active routes sharing one flight ID.

Controller has no downstream route binding to distinguish those routes.

### Failure Scenario

1. Governance contains two active routes for `AA100` after the uniqueness index archives:
   - `AA100 / JFK / LAX`
   - `AA100 / SFO / ORD`
2. A traveler purchases the first route for date `D`.
3. Controller registers `(AA100, D)` in FlightPoolManager and OracleAggregator.
4. A second traveler purchases the other route for the same date.
5. Controller validates the second route but targets the existing `(AA100, D)` state.

Two outcomes are possible:

- If route terms differ, FlightPoolManager rejects the second registration with `FlightTermsMismatch`, denying coverage for the second route.
- If terms match, both buyers are recorded under the same configuration and oracle record. The outcome reported for one physical flight governs both policies.

The same traveler also cannot hold both distinct route policies for that date because buyer uniqueness is keyed by `(flight_id, date, traveler)`.

### Impact

The identity collapse can:

- deny purchases for legitimately approved routes;
- combine policies for different physical flights;
- use one route's cancellation or delay result to settle another route's buyers;
- misallocate vault payouts and premiums;
- make traveler policy history ambiguous;
- prevent a traveler from buying two otherwise distinct approved policies.

The collision requires a governance state inconsistency, but Controller provides no defense once that state is reachable.

### Recommendation

Use a canonical flight-instance identifier consistently across the complete policy lifecycle.

Preferred remediation:

1. Include origin and destination, or an immutable canonical flight-instance ID, in FlightPoolManager and OracleAggregator keys.
2. Include the same identity in buyer, claim, active-list, event, and traveler-index records.
3. Ensure the oracle verifies the canonical route before publishing an outcome.

If the reduced `(flight_id, date)` identity is retained:

1. Make GovernanceModule's route uniqueness invariant non-expiring or atomically coupled to the route.
2. Add a Controller-accessible assertion that the supplied route is the canonical route for the flight ID.
3. Reject purchases if the route uniqueness index is absent or inconsistent.

---

## [AA-CT-02] TravelerFlights grows into a per-address permanent purchase denial

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `append_traveler_flight`, `buy_insurance`, `get_flights_for_traveler` |
| **Impact** | Permanent inability for an active address to purchase additional policies |

### Description

Controller stores every policy associated with a traveler in one persistent vector:

```rust
TravelerFlights(Address), // Vec<(Symbol, u64)>
```

Every successful purchase reads, appends to, and rewrites the complete vector:

```rust
let key = CtrlKey::TravelerFlights(traveler.clone());
let mut list: Vec<(Symbol, u64)> =
    e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
list.push_back((flight_id.clone(), date));
e.storage().persistent().set(&key, &list);
```

The list is append-only. Settled, expired, or otherwise historical policies are never removed or moved to another page.

Soroban limits a contract-data entry to 65,536 bytes. The vector therefore has a hard maximum size regardless of available transaction CPU or fees.

### Technical Evidence

Resource testing appended entries using the short symbol `AA100` and distinct dates:

| Number of Entries | Result |
| ---: | --- |
| 1,630 | Entry remained writable |
| Before completing 1,640 | Entry exceeded the 65,536-byte limit |

The failing write produced:

```text
contract data entry ... TravelerFlights ...
size: 65544 > 65536
HostError: Error(Budget, ExceededLimit)
```

The exact threshold depends on symbol serialization and key contents. Longer flight identifiers may reach the limit earlier.

### Failure Scenario

1. A traveler or institutional account accumulates policies over time.
2. Each purchase appends another tuple to its TravelerFlights vector.
3. The vector approaches the contract-data entry limit.
4. A subsequent `buy_insurance` call completes route, timing, oracle, and solvency checks.
5. The transaction reaches `append_traveler_flight`.
6. Rewriting the oversized entry exceeds the network limit and the transaction reverts.
7. Every future purchase from the same address fails at the same boundary.

Soroban transaction atomicity rolls back the earlier premium transfer, collateral lock, and buyer insertion. This prevents asset loss but does not restore the account's ability to purchase.

### Impact

The finding:

- permanently denies additional purchases from a sufficiently active address;
- disproportionately affects aggregators, institutional buyers, and long-lived accounts;
- makes write cost grow with complete historical activity;
- makes the unpaginated read API increasingly expensive;
- requires an upgrade, storage migration, or use of a new address after the limit is reached.

The failure is user-specific rather than protocol-wide, supporting a Medium availability classification.

### Recommendation

Replace the monolithic vector with paginated or individually keyed storage:

```text
TravelerFlightCount(address) -> u64
TravelerFlight(address, index) -> (flight_id, date, route_id)
```

Alternatively, store bounded pages:

```text
TravelerFlights(address, page) -> Vec<PolicyId>
```

Also:

1. expose paginated reads;
2. set an explicit maximum page size;
3. consider keeping only active policies on-chain and deriving history from events or an indexer;
4. add resource-enforced boundary tests;
5. provide a migration path for existing large vectors.

---

## [AA-CT-03] Maximum allowed minimum lead time disables all policy purchases

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `assert_min_lead_time`, `set_min_lead_time`, Controller constructor, `buy_insurance` |
| **Impact** | Owner-triggered denial of new policy purchases |

### Description

Controller permits `min_lead_time` values up to and including 90 days:

```rust
pub(crate) const MAX_MIN_LEAD_TIME_SECS: u64 = 7_776_000; // 90 days

fn assert_min_lead_time(e: &Env, seconds: u64) {
    if seconds > MAX_MIN_LEAD_TIME_SECS {
        panic_with_error!(e, Error::MinLeadTimeExceedsMaximum);
    }
}
```

The maximum booking horizon is also exactly 90 days:

```rust
pub(crate) const MAX_BOOK_AHEAD_SECS: u64 = 7_776_000; // 90 days
```

Purchases require:

```text
date > now + min_lead_time
date <= now + MAX_BOOK_AHEAD_SECS
```

When `min_lead_time == MAX_BOOK_AHEAD_SECS`, no timestamp can satisfy both conditions. The allowed configuration therefore disables all new purchases without activating the pause mechanism.

### Impact

An owner can accidentally initialize or update the Controller to a value that:

- rejects every `buy_insurance` call;
- presents as a valid bounded configuration;
- provides no explicit signal that the purchase interval is empty;
- remains active until the owner changes the parameter.

This is a trusted-owner configuration error and is immediately recoverable, supporting a Low severity classification.

### Recommendation

Require the minimum lead time to be strictly lower than the booking horizon:

```rust
if seconds >= MAX_BOOK_AHEAD_SECS {
    panic_with_error!(e, Error::MinLeadTimeExceedsMaximum);
}
```

Prefer a dedicated invariant and error indicating that the purchase window would be empty. Apply the check in both the constructor and setter, and add boundary tests for:

- `MAX_BOOK_AHEAD_SECS - 1` accepted;
- `MAX_BOOK_AHEAD_SECS` rejected;
- at least one timestamp remains purchasable after every accepted update.

---

## Methodology

The assessment included:

- direct review of all in-scope Controller source files;
- authorization and buyer-whitelist analysis;
- purchase-ordering and atomicity analysis;
- route and policy identity tracing across contracts;
- governance-term snapshot and mismatch analysis;
- persistent storage growth and entry-size analysis;
- parameter-boundary analysis;
- claim-lifecycle TTL analysis;
- adversarial state-sequence and resource-limit testing.

The review focused on current reachable impact. Cross-contract guards and transaction rollback behavior were accounted for when assigning severity.

---

## Remediation Priority

1. **AA-CT-01:** Bind policies to a canonical route or flight-instance identity.
2. **AA-CT-02:** Replace TravelerFlights with bounded, paginated storage.
3. **AA-CT-03:** Reject minimum lead times that eliminate the valid booking interval.

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
