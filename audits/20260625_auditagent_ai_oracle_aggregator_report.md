# Nethermind AuditAgent AI: Sentinel OracleAggregator Findings Report

**Date:** 25 June 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol OracleAggregator. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

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

- `contracts/oracle_aggregator/src/admin.rs`
- `contracts/oracle_aggregator/src/auth.rs`
- `contracts/oracle_aggregator/src/constants.rs`
- `contracts/oracle_aggregator/src/lib.rs`
- `contracts/oracle_aggregator/src/lifecycle.rs`
- `contracts/oracle_aggregator/src/queries.rs`
- `contracts/oracle_aggregator/src/storage.rs`
- `contracts/oracle_aggregator/src/upgrade.rs`

The following related files were reviewed to assess lifecycle assumptions and system integrations:

- `contracts/controller/src/constants.rs`
- `contracts/controller/src/settle.rs`
- `executor/centralized_cron/src/ttl_extender.ts`

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Third-party API correctness
- Compromise of owner, controller, oracle, or executor credentials
- Smart contracts outside the OracleAggregator integration boundary

---

## Executive Summary

The assessment identified three Medium-severity findings affecting OracleAggregator availability and flight-lifecycle continuity.

The most concrete availability risks are caused by the monolithic `ActiveFlightList` stored inside the contract instance:

- the contract instance reaches the 65,536-byte entry-size limit at approximately 1,629 flight entries in the assessed configuration;
- `prune_settled` is configured to inspect 100 persistent records, but that invocation requires 103 footprint entries and exceeds the current 100-entry transaction limit;
- the pruning implementation still iterates over and reconstructs the complete active-flight vector despite its nominal batch size.

The FlightData lifecycle also depends on storage longevity that is not guaranteed by the current implementation. A policy may be purchased up to 90 days before departure, while its oracle record receives only approximately 31 days of TTL. The current executor renews contract instance TTL but does not renew individual `FlightData` keys. An unchanged long-dated record can therefore archive before its flight lifecycle begins.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-OA-01 | Medium | FlightData TTL is shorter than the permitted pre-departure lifecycle |
| AA-OA-02 | Medium | ActiveFlightList reaches the contract-instance entry-size limit |
| AA-OA-03 | Medium | `prune_settled` exceeds transaction limits and remains O(n) |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 3 | 0 | 0 |

### Overall Risk Rating

**Medium**

The identified issues can block new policy registration, prevent oracle lifecycle progression, and make pruning unavailable. No direct unauthorized asset-transfer path was identified within the assessed OracleAggregator scope.

---

# Detailed Findings

## [AA-OA-01] FlightData TTL is shorter than the permitted pre-departure lifecycle

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `oracle_aggregator::register_flight`, lifecycle mutation functions, and persistent `FlightData` storage |
| **Impact** | Flight processing failure, blocked settlement, and locked collateral |

### Description

Each `FlightData(flight_id, date)` record is stored in persistent storage and extended to approximately 31 days:

```rust
pub(crate) const PERSISTENT_TTL_EXTEND: u32 = 535_680; // ~31 days

pub(crate) fn extend_flight_ttl(e: &Env, flight_id: &Symbol, date: u64) {
    let key = OracleKey::FlightData(flight_id.clone(), date);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}
```

The Controller permits insurance purchases up to 90 days before departure. A newly registered long-dated flight can therefore remain unchanged for longer than the oracle record's TTL.

The production TTL executor does not currently renew these individual records. Its own documentation explicitly states that deeper key-level extension of `FlightData` is not implemented:

```typescript
// Deeper key-level Persistent TTL extension (FlightConfig, FlightData,
// Route, TravelerFlights, ClaimableBalance, BuyerWhitelisted via
// ExtendFootprintTTLOp) is a separate executor concern — not in this cron.
```

After archival, lifecycle functions such as `set_estimated_arrival`, `set_landed`, `set_cancelled`, `set_to_be_settled`, and `set_settled` attempt to load the missing record with:

```rust
.get(&key)
.expect("flight not registered");
```

They consequently revert until an external restore operation is performed.

### Failure Scenario

1. A traveler purchases coverage for a flight more than 31 days in the future.
2. `register_flight` creates a `NotInitiated` FlightData record and gives it approximately 31 days of TTL.
3. No lifecycle mutation occurs before the TTL expires.
4. The current TTL executor renews the contract instance but not the individual FlightData key.
5. The record archives.
6. The oracle later attempts to publish the estimated arrival or cancellation and receives `"flight not registered"`.
7. Classification and settlement cannot complete, leaving the associated collateral locked.

### Impact

The affected policy cannot proceed through the normal oracle state machine. This can:

- prevent outcome reporting;
- block settlement and traveler payouts;
- leave vault collateral locked;
- require an off-chain ledger-entry restoration procedure;
- cause the missing tuple to be removed from `ActiveFlightList` during pruning.

The issue is a known deferred dependency in existing project documentation, but it remains present in the assessed code and executor.

### Recommendation

Make the policy lifecycle self-sufficient without relying on a future executor feature:

1. Extend FlightData TTL at registration to cover the exact flight date plus a settlement buffer.
2. Use a deadline-derived helper similar to `flight_pool_manager::extend_flight_ttl_to`.
3. Implement and monitor key-level `ExtendFootprintTTLOp` renewal for every unresolved FlightData entry.
4. Add a recovery operation that restores an archived record and safely re-adds it to `ActiveFlightList` if necessary.
5. Add regression tests for a policy purchased at the maximum 90-day horizon.

---

## [AA-OA-02] ActiveFlightList reaches the contract-instance entry-size limit

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `oracle_aggregator::register_flight`, `OracleKey::ActiveFlightList` |
| **Impact** | Protocol-wide rejection of new flight registrations |

### Description

`ActiveFlightList` is a single `Vec<(Symbol, u64)>` stored inside contract instance storage. Every newly registered `(flight_id, date)` appends another tuple:

```rust
let mut flights: Vec<(Symbol, u64)> = e
    .storage()
    .instance()
    .get(&OracleKey::ActiveFlightList)
    .unwrap_or(Vec::new(e));
flights.push_back((flight_id.clone(), date));
e.storage()
    .instance()
    .set(&OracleKey::ActiveFlightList, &flights);
```

Soroban limits a contract-data entry to 65,536 bytes. Because all instance fields, including the full vector, are serialized into one contract-instance entry, sustained registrations eventually make that entry unwritable.

### Technical Evidence

Resource testing with a short flight symbol and unique dates reached the SDK's mainnet limit at the 1,629th registration:

```text
contract data entry ... LedgerKeyContractInstance ...
size: 65576 > 65536
HostError: Error(Budget, ExceededLimit)
```

The exact threshold varies with serialized symbol lengths and other instance data. Approximately 1,600 entries is therefore a practical capacity boundary for this storage design.

### Impact

Once the instance entry reaches the size limit:

- `register_flight` cannot append another flight;
- purchases for previously unseen `(flight_id, date)` combinations revert atomically;
- instance mutations that rewrite the oversized entry may also become unavailable;
- the protocol depends on successful pruning before it can accept new flight instances.

The list retains settled entries for 30 days, so the capacity must cover all unresolved flights and all flights settled during that retention period.

### Recommendation

Replace the monolithic vector with bounded or sharded storage:

- store entries under individual persistent keys indexed by monotonic IDs;
- maintain separate active and historical indexes;
- remove settled flights from the hot active index immediately and retain observability data in events or a separate history structure;
- enforce an explicit maximum list length as an interim safeguard;
- monitor serialized contract-instance size and reject registrations before reaching the network limit.

---

## [AA-OA-03] prune_settled exceeds transaction limits at its configured batch size and remains O(n)

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `oracle_aggregator::prune_settled`, `MAX_PRUNE_BATCH` |
| **Impact** | Pruning failure, active-list accumulation, and eventual registration denial |

### Description

`prune_settled` is not fully bounded by `MAX_PRUNE_BATCH`.

Although persistent FlightData lookups are limited to a window, the function:

1. loads the entire ActiveFlightList;
2. iterates over every list element;
3. copies every retained entry into a new vector;
4. rewrites the complete list when any entry is removed.

```rust
let mut kept: Vec<(Symbol, u64)> = Vec::new(e);
for i in 0..len {
    let entry = list.get(i).unwrap();
    if i < cursor || i >= stop {
        kept.push_back(entry);
        continue;
    }
    // FlightData lookup...
}
```

The configured lookup batch also independently exceeds current transaction footprint limits:

```rust
pub(crate) const MAX_PRUNE_BATCH: u32 = 100;
```

### Technical Evidence

Resource-enforced execution produced the following results:

| Inspected FlightData Entries | Result |
| ---: | --- |
| 97 | Passed |
| 100 | Failed |

The 100-entry invocation failed with:

```text
total footprint ledger entries: 103 > 100
HostError: Error(Budget, ExceededLimit)
```

The additional entries are required for the contract instance and invocation environment. Therefore, once at least 100 records are inspected, the intended maximum batch is not executable under the SDK's current mainnet resource-limit model.

### Impact

The daily executor calls `prune_settled` once. When the selected window reaches the configured 100 entries, pruning can fail consistently before any state change is committed.

Failed pruning causes:

- settled and missing entries to remain in ActiveFlightList;
- continued growth toward the 65,536-byte instance-entry limit;
- increased costs for all full-list readers;
- eventual rejection of new flight registrations.

Even after reducing the lookup batch, full-vector iteration and reconstruction remain linear in total list length.

### Recommendation

1. Reduce the persistent lookup batch below the footprint limit, accounting for all fixed invocation entries. A value materially below 97 should be used rather than relying on the exact observed boundary.
2. Stop rebuilding the complete vector for every batch.
3. Store active entries as individually keyed records with a bounded queue or linked index.
4. If a vector is retained temporarily, use swap-removal for selected entries and process from the tail or a compact bounded segment.
5. Add resource-enforced tests at and above the configured batch size.
6. Test pruning with the largest permitted active-list state, not only small functional fixtures.

---

## Methodology

The assessment included:

- direct review of all in-scope source files;
- review of Controller booking-horizon constraints;
- review of the production TTL executor;
- SDK mainnet resource-limit enforcement;
- contract-instance size boundary analysis;
- pruning footprint and resource-limit analysis.

The review focused on authorization, storage lifetime, state transitions, bounded execution, resource exhaustion, and integration-dependent liveness.

---

## Remediation Priority

1. **AA-OA-03:** Make pruning executable under network limits and remove full-vector reconstruction.
2. **AA-OA-02:** Replace or strictly bound the monolithic ActiveFlightList before production volume approaches the entry-size limit.
3. **AA-OA-01:** Ensure FlightData survives the maximum booking horizon without relying on an unimplemented key-level TTL executor.

AA-OA-02 and AA-OA-03 should be remediated together. Fixing only the batch constant leaves the instance-size failure intact, while changing only storage capacity leaves pruning vulnerable to transaction limits.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. The assessment does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, operational failures, or economic risks.

Dynamic thresholds were measured using the Soroban SDK's current mainnet resource-limit model. Exact production thresholds may change with network configuration, SDK versions, serialized symbol lengths, and contract-instance contents. The underlying bounded-resource failure remains valid regardless of small threshold variation.

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
