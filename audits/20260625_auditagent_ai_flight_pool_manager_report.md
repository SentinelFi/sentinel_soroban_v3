# Nethermind AuditAgent AI: Sentinel FlightPoolManager Findings Report

**Date:** 25 June 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol FlightPoolManager. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

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

Controller and RiskVault were reviewed where required to trace authorization and settlement behavior across contract boundaries.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Compromise of owner, Controller, keeper, or oracle credentials
- Contracts outside the FlightPoolManager integration boundary, except for impact analysis
- Economic assumptions not represented by the assessed implementation

---

## Executive Summary

The assessment identified two Medium-severity findings affecting settlement reliability and protocol capacity.

The first finding prevents on-time flights with buyers from completing settlement under production authorization semantics. Controller invokes FlightPoolManager, which transfers premiums and then invokes RiskVault using the Controller address. RiskVault requires that address to authorize the nested call, but Controller does not authorize the deeper FlightPoolManager-to-RiskVault invocation. Broad authorization mocking in the existing tests masks this failure.

The second finding affects the global `ActiveFlightList`. FlightPoolManager stores every active flight in one vector inside the contract instance. Resource-enforced testing demonstrated that 1,625 entries remain operable, while registration of the 1,626th flight attempts to grow the instance to 65,572 bytes and exceeds Soroban's 65,536-byte contract-data limit. Settlement can reduce the list at the boundary, so the issue is a capacity and admission-denial risk rather than an irreversible contract failure.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-FPM-01 | Medium | Missing nested Controller authorization blocks on-time settlement |
| AA-FPM-02 | Medium | ActiveFlightList imposes a hard protocol-wide flight-capacity ceiling |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 0 | 0 |

### Overall Risk Rating

**Medium**

One finding blocks a core settlement branch, while the other places a deterministic ceiling on concurrent flight registration. Neither finding directly permits unauthorized asset theft.

---

# Detailed Findings

## [AA-FPM-01] Missing nested Controller authorization blocks on-time settlement

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | Controller `execute_settlements`, FlightPoolManager `settle_on_time`, and RiskVault `record_premium_income` |
| **Impact** | On-time flights with buyers cannot settle; premiums and collateral remain locked |

### Description

Controller initiates on-time settlement by invoking FlightPoolManager with its own contract address:

```rust
pool.settle_on_time(&controller_addr, &flight_id, &date);
```

FlightPoolManager requires that address to authorize the call. It then calculates total premium income, transfers the premiums to RiskVault, and performs a deeper invocation:

```rust
let args = (&controller, &total_premium).into_val(e);
e.invoke_contract::<()>(
    &vault_addr,
    &Symbol::new(e, "record_premium_income"),
    args,
);
```

RiskVault independently executes:

```rust
controller.require_auth();
```

Controller is the direct invoker of FlightPoolManager, so its authorization satisfies FlightPoolManager's immediate check. FlightPoolManager is the direct invoker of RiskVault, however, and cannot implicitly reuse the Controller contract's identity for an arbitrary deeper call. Controller does not construct an authorization entry for the exact RiskVault invocation.

### Failure Scenario

1. At least one traveler purchases a policy.
2. The flight lands on time.
3. The keeper invokes Controller settlement.
4. Controller calls `FlightPoolManager::settle_on_time`.
5. FlightPoolManager transfers the collected premiums to RiskVault.
6. FlightPoolManager invokes `record_premium_income(controller, total_premium)`.
7. RiskVault requires Controller authorization for this nested invocation.
8. Authorization fails and the entire transaction reverts atomically.

The rollback preserves the original state: premiums remain in FlightPoolManager, collateral remains locked, and the flight remains unsettled.

Flights with no buyers skip the RiskVault call and do not exercise the failing path.

### Technical Evidence

A three-contract authorization reproduction used:

- an orchestrator contract as the configured Controller and owner;
- FlightPoolManager as the intermediate caller;
- RiskVault as the nested authorization target;
- no broad `mock_all_auths` authorization.

Direct Controller-to-FlightPoolManager authorization succeeded during setup and registration. The on-time settlement call failed only when RiskVault required the Controller address from the deeper FlightPoolManager frame. The flight configuration remained `Active`, confirming transaction rollback.

### Impact

On-time settlement is a core protocol function. Failure prevents:

- premium income from being recorded for underwriters;
- collateral from being released;
- the pool and oracle states from advancing to settled;
- removal of the flight from active processing;
- normal completion of the policy lifecycle.

Repeated keeper calls encounter the same deterministic authorization failure until the contracts are upgraded.

### Recommendation

Prefer a call structure in which each contract authorizes only its direct caller:

1. Have FlightPoolManager transfer the premiums and return the transferred amount to Controller.
2. Have Controller directly invoke `RiskVault::record_premium_income`.
3. Continue settlement only after both operations succeed atomically.

Alternatively, Controller can construct an exact nested authorization tree with `authorize_as_current_contract` before invoking FlightPoolManager. This approach is more tightly coupled to the downstream invocation and arguments.

Add an integration test using contract-address authorization without `mock_all_auths` or `mock_all_auths_allowing_non_root_auth`.

---

## [AA-FPM-02] ActiveFlightList imposes a hard protocol-wide flight-capacity ceiling

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `register_flight`, all settlement functions, `prune_active_list`, `get_active_flights`, and contract instance storage |
| **Impact** | Protocol-wide denial of new flight registration and increasing settlement cost |

### Description

FlightPoolManager stores every unsettled flight in one instance-storage vector:

```rust
ActiveFlightList, // Vec<(Symbol, u64)>
```

Each new flight reads, appends to, and rewrites the complete vector:

```rust
let mut list: Vec<(Symbol, u64)> = e
    .storage()
    .instance()
    .get(&PoolKey::ActiveFlightList)
    .unwrap_or(Vec::new(e));
list.push_back((flight_id.clone(), date));
e.storage()
    .instance()
    .set(&PoolKey::ActiveFlightList, &list);
```

Settlement also loads the complete vector, performs a linear search for the target, swap-removes it, and rewrites the list.

The vector shares one contract-instance ledger entry with Controller, token, vault, and recovered-balance state. It therefore has a hard serialized-size ceiling regardless of transaction fees or available collateral.

### Technical Evidence

Resource-enforced testing with the short symbol `AA100` and distinct dates produced:

| Active Flights | Result |
| ---: | --- |
| 1,625 | Registration and full-list query succeeded |
| 1,626 | Registration reverted |
| Attempted instance size | 65,572 bytes |
| Maximum entry size | 65,536 bytes |

At 1,625 entries, settling the last entry in the vector succeeded and reduced the list to 1,624. The contract can therefore recover capacity through settlement at the demonstrated boundary.

The exact threshold varies with symbol serialization and future additions to instance state. Longer flight identifiers or additional instance fields can lower the limit.

### Failure Scenario

1. Users purchase policies for many distinct flight/date pairs.
2. Every first purchase for a new pair appends another active-flight tuple.
3. The list reaches its instance-entry capacity.
4. A later purchase attempts to register a new flight.
5. The enlarged contract instance exceeds the ledger-entry size limit.
6. The registration and complete purchase transaction revert.
7. New flight registration remains unavailable until existing flights settle and shrink the list.

A motivated user can accelerate the condition by purchasing policies for many distinct dates, subject to route, booking-horizon, premium, and vault-solvency constraints.

### Impact

The issue can:

- deny all new flight registrations protocol-wide;
- make registration and settlement costs scale with total active flights;
- cause policy purchases to revert after earlier validation steps;
- reduce available capacity when additional instance state is introduced;
- make protocol availability depend on settlement throughput keeping pace with new registrations.

Existing entries and funds are not permanently trapped at the measured size boundary because settlement can remove entries. This limits severity to Medium.

### Recommendation

Replace the monolithic vector with individually keyed active-flight records and bounded pages or linked indexes. Suitable storage shapes include:

```text
ActiveFlightCount -> u64
ActiveFlight(index) -> (flight_id, date)
ActiveFlightIndex(flight_id, date) -> index
```

Use swap-removal with the reverse index to preserve O(1) deletion without rewriting all entries.

Additionally:

1. expose paginated active-flight reads;
2. enforce an explicit supported capacity below the network limit until migration;
3. add resource-enforced boundary tests;
4. monitor active-flight count and settlement backlog;
5. avoid adding other growing collections to contract instance storage.

---

## Methodology

The assessment included:

- direct review of all in-scope FlightPoolManager source files;
- Controller and RiskVault authorization-boundary tracing;
- production-shaped nested contract-authorization testing;
- flight registration, buyer accounting, settlement, claim, and sweep lifecycle analysis;
- persistent and instance storage TTL review;
- Controller booking-horizon and claim-window bound verification;
- contract-instance entry-size and ActiveFlightList capacity testing;
- transaction rollback and recovery-path analysis;
- review of existing guards, downstream assumptions, and trusted caller boundaries.

The review focused on reachable behavior in the assessed integration. Claims that depended on a 180-day claim window or unrestricted future registration were excluded because the current Controller enforces a 60-day maximum claim period and 90-day maximum booking horizon.

---

## Remediation Priority

1. **AA-FPM-01:** Correct the cross-contract authorization structure for on-time settlement.
2. **AA-FPM-02:** Replace ActiveFlightList with bounded or individually keyed storage.

AA-FPM-01 should be remediated before policies are settled in production. AA-FPM-02 should be addressed before active-flight volume approaches the measured capacity.

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
