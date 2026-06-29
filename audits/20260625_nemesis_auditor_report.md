# Nemesis AI Auditor: Sentinel Protocol Security Assessment

**Date:** 25 June 2026

This report presents the Nemesis AI Auditor findings for the Sentinel Protocol. Severity reflects likely protocol impact, exploitability, affected assets, and operational risk in the assessed repository snapshot.

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
| **Auditor(s)** | Nemesis AI Auditor |
| **Assessment Platform** | [0xiehnnkta/nemesis-auditor](https://github.com/0xiehnnkta/nemesis-auditor) |

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

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/mock_usdc`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

The production flight-data and TTL executors were reviewed where required to evaluate contract lifecycle and oracle-integration assumptions:

- `executor/centralized_cron/src/flight_data_fetcher.ts`
- `executor/centralized_cron/src/aeroapi_client.ts`
- `executor/centralized_cron/src/ttl_extender.ts`

### Out of Scope

- `contracts/integration_tests`, except as a test harness
- Frontend applications
- Deployment infrastructure and private operational systems
- Key custody and compromise of trusted owner, administrator, keeper, controller, or oracle credentials
- Third-party API availability and correctness beyond the integration behavior represented in the repository
- Contracts and dependencies outside the identified integration boundaries

---

## Executive Summary

The assessment identified ten findings: three High-severity, five Medium-severity, and two Low-severity issues.

The most severe risks affect vault assets:

1. Arbitrary timestamps allow one physical flight to be represented by multiple on-chain policy instances. The production executor reduces those timestamps to one calendar day and can resolve them to the same flight record, allowing one delayed or cancelled flight to generate many independent claims.
2. Processed withdrawal liabilities remain physically inside RiskVault and continue to influence the dependency's share-conversion formulas. Existing shareholders can exploit the inflated asset basis to extract assets from later depositors.
3. Flight outcomes become public before their profit or loss is reflected in vault value. Informed liquidity providers can redeem before an adverse settlement or deposit before known premium income is booked.

The remaining findings affect aggregate solvency enforcement, keeper transaction executability, storage capacity, route uniqueness, oracle-record longevity, and governance parameter consistency.

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| NM-001 | High | Arbitrary timestamps create duplicate claims for one physical flight | Direct vault drain |
| NM-002 | High | Claimable withdrawal liabilities continue backing outstanding shares | Theft from later depositors |
| NM-003 | High | Public flight outcomes give LPs a free option before settlement | Loss evasion and LP value extraction |
| NM-004 | Medium | Solvency ratio is not enforced on aggregate liabilities | Reserve-margin bypass |
| NM-005 | Medium | Configured batches exceed transaction footprint limits | Classification, settlement, and pruning failure |
| NM-006 | Medium | Monolithic vectors impose hard protocol and user capacity limits | Registration and purchase denial |
| NM-007 | Medium | FlightRoute uniqueness ownership expires independently from live routes | Route and policy-state collision |
| NM-008 | Medium | FlightData can archive before a permitted long-dated flight | Blocked oracle lifecycle and settlement |
| NM-009 | Low | Maximum minimum-lead setting creates an empty booking interval | Owner-triggered purchase denial |
| NM-010 | Low | Mutable defaults can leave an invalid route reported as active | Route-level purchase denial |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 3 | 5 | 2 | 0 |

### Overall Risk Rating

**High**

The protocol contains permissionless paths that can materially deplete vault assets or transfer losses between liquidity providers. The High-severity findings should be remediated before production deployment or additional capital is accepted.

---

## Methodology

The assessment examined:

- authorization and cross-contract invocation boundaries;
- policy identity from purchase through oracle resolution, settlement, and claim;
- vault deposits, redemptions, queued withdrawals, liabilities, and share pricing;
- aggregate collateral and solvency invariants;
- coupled state stored across Controller, GovernanceModule, OracleAggregator, FlightPoolManager, and RiskVault;
- persistent and instance storage TTL behavior;
- collection growth, ledger-entry sizing, and transaction-footprint limits;
- adversarial transaction ordering around public outcomes;
- production executor normalization and lifecycle behavior;
- multi-transaction sequences capable of draining, misallocating, or indefinitely locking assets.

Severity was reduced where trusted access, transaction atomicity, downstream checks, or operational recovery constrained practical impact.

---

# Detailed Findings

## [NM-001] Arbitrary timestamps create duplicate claims for one physical flight

| Field | Value |
| --- | --- |
| **Severity** | High |
| **Affected Components** | Controller purchase flow, FlightPoolManager policy identity, OracleAggregator flight identity, production flight-data executor |
| **Impact** | Direct vault drain and indefinite collateral locking |
| **Status** | Open |

### Description

`Controller::buy_insurance` accepts a caller-selected `date` and verifies only that it falls inside the configured booking interval. The exact timestamp then becomes part of the flight, buyer, and claim identity:

```text
FlightConfig(flight_id, date)
FlightData(flight_id, date)
Buyer(flight_id, date, traveler)
```

Timestamps separated by one second therefore create independent policies and claims for the same traveler.

The production executor does not preserve this distinction. It converts each timestamp to `YYYY-MM-DD`, queries AeroAPI for the full day, and returns the final flight record without matching exact scheduled departure, origin, or destination. Multiple attacker-selected timestamps from one day can consequently be resolved to the same physical event.

### Exploit Scenario

1. An attacker purchases many policies for one flight ID using different timestamps from the same UTC day.
2. Each purchase charges a premium and locks another payoff.
3. The executor resolves every timestamp using the same delayed or cancelled physical-flight record.
4. Every on-chain instance becomes independently payable.
5. The attacker claims each policy.

A 20-policy reproduction with premium 10 and payoff 50 produced:

| Metric | Amount |
| --- | ---: |
| Premiums paid | 200 |
| Claims received | 1,000 |
| Vault assets before | 1,000 |
| Vault assets after | 200 |
| Net vault loss | 800 |

Nonexistent or ambiguous timestamps can also remain unresolved and keep collateral locked because the protocol has no policy timeout or refund path for flights that never receive valid oracle data.

### Recommendation

Create policies only for pre-registered canonical flight instances containing an immutable provider flight identifier, exact scheduled departure, origin, and destination. Use that canonical identifier across all contract storage and claims. The executor must select the exact provider record and reject ambiguous day-level matches. Add an expiry and refund process for flight instances that never receive valid oracle data.

---

## [NM-002] Claimable withdrawal liabilities continue backing outstanding shares

| Field | Value |
| --- | --- |
| **Severity** | High |
| **Affected Components** | RiskVault withdrawal queue, ClaimableBalance accounting, vault share conversions |
| **Impact** | Existing shareholders can extract assets from later depositors |
| **Status** | Open |

### Description

When `process_withdrawal_queue` services a request, it:

- burns the escrowed shares;
- decreases `TotalManagedAssets`;
- records a `ClaimableBalance`;
- leaves the corresponding tokens physically inside RiskVault.

The underlying `stellar-tokens` vault implementation calculates `total_assets()` from the vault's physical token balance. Deposit and redemption conversions use that physical balance rather than Sentinel's `TotalManagedAssets`.

Assets already owed to processed withdrawers therefore continue to increase the apparent value of outstanding shares until collection.

### Exploit Scenario

1. LP A and LP B each deposit 500.
2. LP A queues and processes a 500 withdrawal.
3. LP A's shares are burned and 500 becomes claimable, but the vault still physically holds 1,000.
4. A victim deposits 500 and receives shares priced against the liability-inflated balance.
5. LP B redeems its shares for almost 1,000.
6. LP A collects the owed 500.
7. The victim is left with approximately one base unit.

The attack transfers nearly all of a later depositor's assets to the pre-existing shareholders.

### Recommendation

Track aggregate claimable liabilities and use one net-asset basis for every conversion:

```text
net_assets = physical_token_balance - total_claimable_liabilities
```

Apply net assets to deposits, mints, withdrawals, redemptions, previews, conversions, and snapshots. An alternative is to transfer processed withdrawals into a separate escrow whose balance is excluded from vault pricing.

---

## [NM-003] Public flight outcomes give LPs a free option before settlement

| Field | Value |
| --- | --- |
| **Severity** | High |
| **Affected Components** | OracleAggregator outcome writes, Controller settlement, RiskVault deposit and redemption |
| **Impact** | Adverse-loss evasion, gain capture, and value transfer between LPs |
| **Status** | Open |

### Description

Flight outcomes and their financial effects occur in separate transactions:

1. OracleAggregator records `Landed` or `Cancelled`.
2. Controller classifies the flight.
3. A later settlement transaction transfers premium income or charges payout loss to RiskVault.

RiskVault remains open for deposits, mints, withdrawals, and redemptions during this interval. Share pricing does not include the publicly known but unsettled outcome.

### Exploit Scenario

1. Two LPs deposit 1,000 each.
2. A policy with premium 100 and payoff 1,000 locks 1,000.
3. The oracle publicly records cancellation.
4. Before settlement, one LP redeems at the pre-loss share value using available free capital.
5. Settlement charges the 900 net loss to the remaining vault assets.

In the reproduced sequence, the informed LP exited for approximately 1,000. Settlement then reduced the remaining vault balance from 1,000 to 100, assigning the full 900 loss to the passive LP.

The inverse strategy is also possible: deposit after an on-time outcome is public but before premium income is transferred into the vault.

### Recommendation

Introduce settlement epochs that bind deposits and withdrawals to post-settlement values, or reserve and book outcome value when the outcome first becomes public. Queue LP entry and exit while any published flight result remains financially unsettled. Any cooldown must cover the complete oracle-to-settlement interval and prevent both pre-loss exits and pre-income deposits.

---

## [NM-004] Solvency ratio is not enforced on aggregate liabilities

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | Controller solvency gate and RiskVault locked-capital accounting |
| **Impact** | Configured reserve margin can collapse toward 100% |
| **Status** | Open |

### Description

Controller checks each new purchase using:

```text
free_capital >= new_payoff × solvency_ratio
```

Free capital already subtracts all previously locked liabilities. Applying the ratio only to the newest payoff does not preserve the ratio across aggregate liabilities.

For example, with total managed assets of 1,000, payoff of 50, and a configured ratio of 200%, nineteen purchases pass:

```text
locked liabilities = 950
aggregate collateralization = 1,000 / 950 = 105.3%
configured target = 200%
```

The vault remains nominally able to cover policy payoffs, but the configured safety margin is almost entirely bypassed.

### Recommendation

Validate post-purchase aggregate liabilities:

```text
required_assets = ceil((locked_capital + new_payoff) × ratio / 100)
require(total_managed_assets >= required_assets)
```

Use checked arithmetic and add sequence tests proving that aggregate collateralization never falls below the configured ratio.

---

## [NM-005] Configured batches exceed transaction footprint limits

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | `classify_flights`, `execute_settlements`, and `prune_settled` |
| **Impact** | Keeper calls revert and lifecycle progress is lost |
| **Status** | Open |

### Description

Controller and OracleAggregator use batch constants of 100. The loops bound the number of records inspected but do not account for fixed contract entries and the distinct persistent entries touched by each item.

Resource-enforced reproductions produced:

| Operation | Batch | Required Footprint | Result |
| --- | ---: | ---: | --- |
| Controller `classify_flights` | 100 | 107 entries | Exceeded 100-entry limit |
| OracleAggregator `prune_settled` | 100 | 103 entries | Exceeded 100-entry limit |
| OracleAggregator `prune_settled` | 97 | Within limit | Succeeded |

`execute_settlements` may touch OracleAggregator, FlightPoolManager, and RiskVault state for each payable flight, giving it a larger per-flight footprint than classification.

Because Soroban transactions are atomic, an oversized keeper invocation reverts without advancing its cursor.

### Recommendation

Derive conservative batch limits from each operation's complete cross-contract call graph and fixed footprint. Use smaller constants, add tests that enforce production resource limits, and prefer keyed ready-work queues that avoid scanning unrelated records.

---

## [NM-006] Monolithic vectors impose hard protocol and user capacity limits

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | OracleAggregator ActiveFlightList, FlightPoolManager ActiveFlightList, Controller TravelerFlights |
| **Impact** | Protocol-wide registration denial and permanent per-address purchase denial |
| **Status** | Open |

### Description

The protocol stores several growing collections as single Soroban values:

- OracleAggregator's global `ActiveFlightList`;
- FlightPoolManager's global `ActiveFlightList`;
- each Controller `TravelerFlights(address)` history.

Each append reads and rewrites the full vector. These values eventually exceed the maximum contract-data entry size.

Resource testing found:

- OracleAggregator exceeded 65,536 bytes on the 1,629th registration;
- Controller remained writable at 1,630 short-symbol entries but exceeded 65,536 bytes before completing 1,640 entries;
- FlightPoolManager uses the same global instance-vector pattern and can accumulate unresolved flights.

The exact threshold varies with serialized symbol length and entry contents.

### Impact

- OracleAggregator capacity failure blocks protocol-wide flight registration.
- Controller capacity failure permanently prevents the affected address from purchasing another policy.
- FlightPoolManager capacity failure blocks new flight configurations while unresolved entries remain.
- Read and write costs increase with the complete collection size before the hard limit is reached.

### Recommendation

Replace monolithic vectors with bounded pages or individually keyed entries. Expose paginated reads and maintain explicit counts or cursor indexes. Keep only active operational state in contract storage and derive historical views from bounded pages or indexed events.

---

## [NM-007] FlightRoute uniqueness ownership expires independently from live routes

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | GovernanceModule route lifecycle and downstream policy identity |
| **Impact** | Conflicting routes can share policy and oracle state |
| **Status** | Open |

### Description

GovernanceModule stores:

```text
Route(flight_id, origin, destination)
FlightRoute(flight_id) -> (origin, destination)
```

The second entry enforces the single-route-per-flight-ID invariant required because downstream contracts omit origin and destination from their keys.

Both entries initially receive a 60-day TTL. Normal route reads and mutations renew only `Route(...)`; they do not renew `FlightRoute(...)`. The current executor extends contract instances but does not implement persistent key-level renewal.

An active route can therefore remain live after its uniqueness index archives. A later administrative whitelist operation sees no ownership index and accepts a different route with the same flight ID.

If the routes have different terms, purchases collide and revert. If the terms match, buyers for different physical flights can be combined under one `(flight_id, date)` pool and oracle result. `remove_route` can further remove the newer route's index because it deletes `FlightRoute(flight_id)` without confirming which route it references.

### Recommendation

Renew and verify `FlightRoute(flight_id)` whenever the associated route is read or mutated. Remove the index only when it points to the exact route being deleted. Implement key-level TTL maintenance and a safe recovery path for missing indexes. Prefer a canonical flight-instance identifier that eliminates the parallel-key invariant.

---

## [NM-008] FlightData can archive before a permitted long-dated flight

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | OracleAggregator FlightData lifecycle and production TTL executor |
| **Impact** | Outcome reporting, settlement, and collateral release can fail |
| **Status** | Open |

### Description

Controller permits policies up to 90 days before departure. OracleAggregator extends each persistent `FlightData` entry to approximately 31 days.

The flight-data executor may move a long-dated record from `NotInitiated` to `Active`, but it performs no further write while the estimated arrival remains in the future. The TTL executor explicitly does not renew individual `FlightData` keys.

The record can therefore archive before departure. Subsequent lifecycle functions load it with `.expect("flight not registered")` and revert. The read API returns a default `NotInitiated` value for missing data, which does not restore the persistent record or permit normal oracle progression.

### Impact

An affected policy can lose its oracle state before its flight occurs. This can block outcome publication, classification, settlement, claims, and collateral release until an external ledger-entry restoration process succeeds.

### Recommendation

At registration and every lifecycle mutation, derive the TTL from the scheduled departure and required settlement buffer rather than applying a flat 31-day period. Implement monitored key-level renewal for every unresolved record and provide a safe on-chain recovery and reindexing path.

---

## [NM-009] Maximum minimum-lead setting creates an empty booking interval

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | Controller constructor, `set_min_lead_time`, and `buy_insurance` |
| **Impact** | Owner-triggered denial of all new policy purchases |
| **Status** | Open |

### Description

Controller allows `min_lead_time` to equal 90 days, while the maximum booking horizon is also 90 days. Purchases require:

```text
date > now + min_lead_time
date <= now + maximum_booking_horizon
```

When both values are 90 days, no timestamp satisfies the two conditions. The configuration passes validation but rejects every purchase.

### Recommendation

Require `min_lead_time < MAX_BOOK_AHEAD_SECS` in both the constructor and setter. Use a dedicated error indicating that the update would create an empty booking interval, and add boundary tests for the maximum accepted value.

---

## [NM-010] Mutable defaults can leave an invalid route reported as active

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | GovernanceModule defaults, route resolution, and route status |
| **Impact** | Route-level purchase denial and misleading governance state |
| **Status** | Open |

### Description

Routes can override selected fields while inheriting other values from mutable global defaults. A route that is valid when written can become invalid after a later defaults update.

For example:

1. Defaults are premium 10 and payoff 100.
2. A route stores custom premium 90 and inherits the default payoff.
3. The owner changes the default payoff to 50.
4. The route now resolves to premium 90 and payoff 50.
5. `route_status` still reports the route as active.

FlightPoolManager rejects `payoff <= premium` before premium transfer or collateral locking, preventing financial corruption. The remaining impact is denial of purchases for a route that GovernanceModule continues to advertise as active.

### Recommendation

Ensure every active route resolves to valid terms after defaults change. Store fully resolved immutable terms, maintain an enumerable dependency index for revalidation, or return a distinct invalid status from `route_status`. Revalidate terms when enabling a route and retain FlightPoolManager's guard as defense in depth.

---

## Remediation Priority

1. **NM-001:** Replace arbitrary timestamp identity with canonical oracle-attested flight instances.
2. **NM-002:** Exclude claimable liabilities from the vault share-pricing asset basis.
3. **NM-003:** Prevent LP entry and exit against values that omit public unsettled outcomes.
4. **NM-004:** Enforce solvency ratios against aggregate liabilities.
5. **NM-005:** Reduce and resource-test every keeper batch.
6. **NM-006:** Migrate growing vectors to bounded or keyed storage.
7. **NM-008:** Extend FlightData through the complete permitted lifecycle.
8. **NM-007:** Synchronize route and uniqueness-index storage.
9. **NM-009:** Reject lead-time settings that eliminate the booking interval.
10. **NM-010:** Revalidate routes affected by mutable defaults.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. The assessment does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, operational failures, or economic risks.

The review relied on available source code, tests, dependency behavior, and represented executor integrations. Changes made after commit `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7` were not assessed. Production deployment configuration, private infrastructure, key management, frontend applications, and third-party systems were not comprehensively audited unless directly relevant to a reported finding.

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
