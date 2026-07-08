# Nethermind AuditAgent AI: Sentinel OracleAggregator Findings Report

**Date:** 4 July 2026

This report presents the Nethermind AuditAgent AI Auditor findings for the Sentinel Protocol OracleAggregator. Severity reflects likely protocol impact, exploitability, and operational risk in the assessed repository snapshot.

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

- `contracts/oracle_aggregator/src/admin.rs`
- `contracts/oracle_aggregator/src/auth.rs`
- `contracts/oracle_aggregator/src/constants.rs`
- `contracts/oracle_aggregator/src/error.rs`
- `contracts/oracle_aggregator/src/events.rs`
- `contracts/oracle_aggregator/src/lib.rs`
- `contracts/oracle_aggregator/src/lifecycle.rs`
- `contracts/oracle_aggregator/src/queries.rs`
- `contracts/oracle_aggregator/src/storage.rs`
- `contracts/oracle_aggregator/src/traits.rs`
- `contracts/oracle_aggregator/src/upgrade.rs`

Controller and the production executor were reviewed where necessary to assess settlement and discovery behavior.

### Out of Scope

- Production infrastructure and operator configuration
- Frontend applications
- Third-party API correctness
- Compromise of owner, controller, oracle, or executor credentials
- Smart contracts outside the OracleAggregator integration boundary

---

## Executive Summary

The assessment identified four Low-severity findings.

OracleAggregator deliberately limits its monolithic active-flight vector to 1,000 entries to avoid exceeding the contract-instance entry-size limit. This converts an uncontrolled serialization failure into a defined capacity ceiling, but the ceiling still blocks all new unique flight registrations when reached. A user must pay real premiums to consume slots, so deliberate saturation is economically constrained; organic demand can produce the same availability failure.

Three findings concern data quality and lifecycle continuity. `set_landed` accepts a zero arrival timestamp, which the Controller's saturating delay calculation classifies as on time. Classified records receive only the approximately 31-day post-departure TTL floor and can archive during an extended settlement outage. Finally, permissionless pruning treats every missing `FlightData` entry as removable, even when the entry is only archived and the flight remains unresolved, deleting its normal discovery reference.

### Findings Summary

| ID | Severity | Title |
| --- | --- | --- |
| AA-OA-01 | Low | Global active-flight capacity can block new registrations |
| AA-OA-02 | Low | Missing-data pruning can orphan unresolved flights |
| AA-OA-03 | Low | Zero actual-arrival timestamps can settle as on time |
| AA-OA-04 | Low | Classified flights can archive before terminal settlement |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 4 | 0 |

### Overall Risk Rating

**Low**

The findings affect availability or trusted-input handling. No unauthorized state transition or direct asset-transfer vulnerability was identified.

---

# Detailed Findings

## [AA-OA-01] Global active-flight capacity can block new registrations

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `register_flight`, `ActiveFlightList`, and `MAX_ACTIVE_FLIGHTS` |
| **Impact** | Protocol-wide rejection of previously unseen flight registrations |

### Description

All registered flights are held in one instance-stored vector with a hard cap:

```rust
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 1_000;
```

Registration rejects a new unique flight when the cap is reached:

```rust
if flights.len() >= MAX_ACTIVE_FLIGHTS {
    panic_with_error!(e, Error::ActiveFlightListFull);
}
```

Settled flights remain in the vector for 30 days and require a separate `prune_settled` call to release capacity. Future flights can enter the list up to the Controller's 90-day booking horizon.

The cap is a deliberate safeguard against the 65,536-byte contract-instance entry limit. It is therefore preferable to uncontrolled vector growth, but it remains a global capacity limit.

### Failure Scenario

1. Organic demand or purchases across many distinct `(flight_id, date)` pairs consume all 1,000 slots.
2. No retained settled entries are yet old enough to prune, or pruning has not run.
3. A buyer purchases a previously unseen flight.
4. Controller calls `register_flight`.
5. OracleAggregator raises `ActiveFlightListFull`, reverting the purchase atomically.

### Impact

New unique flights cannot be insured until capacity is released. Existing registered flights remain processable. Deliberate saturation requires valid whitelisted flights and payment of a premium for each unique entry, materially limiting griefing economics.

### Recommendation

Replace the monolithic vector with sharded or individually keyed active records and paginated enumeration. Until migration:

1. monitor occupancy and prune promptly;
2. alert at conservative capacity thresholds;
3. consider removing settled flights from the hot list immediately while retaining history in events;
4. document supported flight throughput over the booking and retention horizons.

---

## [AA-OA-02] Missing-data pruning can orphan unresolved flights

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `prune_settled`, `FlightData`, and `ActiveFlightList` |
| **Impact** | Recoverable archived flight becomes undiscoverable to the normal settlement pipeline |

### Description

`prune_settled` removes an active-list entry whenever the corresponding persistent data is missing:

```rust
None => {
    MissingFlightDataPruned {
        flight_id: flight_id.clone(),
        date,
    }
    .publish(e);
    true
}
```

For persistent Soroban state, a missing read can mean the entry is archived rather than semantically deleted. The entry may still represent an unresolved flight and may be restorable through ledger restoration.

Before pruning, keepers can discover the tuple from `ActiveFlightList` and initiate recovery. After pruning, normal Controller and executor enumeration no longer includes it. The diagnostic event improves observability but does not preserve on-chain discoverability or provide reinsertion.

### Impact

A permissionless caller can turn a temporary TTL lapse into an orphaned workflow item. Settlement, claims, and locked collateral can remain unresolved until operators reconstruct the tuple from events or external records and perform manual recovery.

### Recommendation

Do not remove a missing `FlightData` entry through the settled-flight pruning path.

Options include:

1. retain missing entries and emit a recovery-required event;
2. move them to a separate bounded quarantine index;
3. authorize removal only after an operator confirms finality;
4. provide a safe recovery function that restores or re-registers the tuple without resetting lifecycle state.

---

## [AA-OA-03] Zero actual-arrival timestamps can settle as on time

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `set_landed` and Controller delay classification |
| **Impact** | Malformed trusted-oracle payload can deny delayed-flight payouts |

### Description

`set_landed` validates the state transition but accepts any `u64` arrival timestamp, including zero:

```rust
data.status = FlightStatus::Landed;
data.actual_arrival_time = actual_arrival_time;
```

Zero is otherwise used as the unset sentinel in newly registered and missing flight data.

Controller calculates delay with saturating subtraction:

```rust
let delay_seconds = data
    .actual_arrival_time
    .saturating_sub(data.estimated_arrival_time);
```

If the estimate is positive and the actual timestamp is zero, the computed delay is zero. The flight can then progress through the on-time settlement path, after which the forward-only state machine prevents correction.

### Impact

An accidental malformed payload from the authorized oracle can cause policyholders to lose delayed-flight payouts. The issue does not let an untrusted caller submit data and therefore supports a Low severity classification.

### Recommendation

Reject `actual_arrival_time == 0`. Also reject zero estimated-arrival timestamps and add domain-appropriate bounds around reported times. Validate the off-chain payload before signing and add an explicit correction or dispute procedure before financial settlement.

---

## [AA-OA-04] Classified flights can archive before terminal settlement

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | `set_to_be_settled`, `extend_flight_ttl_to`, and `set_settled` |
| **Impact** | Settlement and collateral release can remain blocked after an extended outage |

### Description

Lifecycle writes extend `FlightData` to the flight date plus a buffer. Once the flight date is in the past, the deadline-derived term becomes zero and the helper uses its approximately 31-day floor:

```rust
let secs_remaining = deadline_secs.saturating_sub(now);
// ...
.clamp(PERSISTENT_TTL_EXTEND, MAX_PERSISTENT_TTL_LEDGERS);
```

`set_to_be_settled` uses the past flight date as its deadline. `set_settled` requires the record to exist but intentionally does not renew its TTL.

If a classified flight remains in a `ToBeSettled*` state for longer than the floor because the keeper, protocol, or external TTL process is unavailable, its record archives. `set_settled` then fails with `"flight not registered"`, while the query fallback presents the missing record as `NotInitiated`.

### Impact

Premium finalization, payout funding, and locked-collateral release can remain blocked until operators restore the archived record. AA-OA-02 can further remove the tuple from normal discovery.

### Recommendation

Extend classified records to an explicit settlement deadline substantially beyond the maximum supported operational outage. Distinguish archived/missing data from genuine `NotInitiated` state, and implement monitored key-level TTL extension for every unresolved flight.

---

## Methodology

The assessment included:

- direct review of all in-scope OracleAggregator source files;
- state-machine and timestamp validation analysis;
- persistent-storage lifetime and restoration analysis;
- active-list capacity and retention analysis;
- Controller classification and settlement integration tracing;
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
