# Sentinel Protocol — Independent Smart Contract Security Assessment

**Assessment date:** 4 July 2026  
**Report version:** v1.1  
**Assessment status:** Final  
**Assessment type:** Manual, adversarial source-code review  
**Auditor:** Codex AI  

---

## Executive Summary

This assessment identified one high-severity vulnerability in the reviewed Sentinel Protocol snapshot.

The protocol cannot record or attest a flight before its first insurance purchase. `OracleAggregator::set_cancelled` requires an existing flight record, but only `Controller::buy_insurance` can create that record. Consequently, a flight that is already publicly known to be cancelled remains purchasable on-chain. The first attacker purchase creates the oracle record as `NotInitiated`, and further attacker-controlled accounts can continue buying while the record is `NotInitiated` or `Active`.

When the oracle catches up and records the cancellation, every attacker account receives the fixed payoff. With a premium below the payoff, the attacker extracts `payoff - premium` from the vault per policy and can repeat the purchase across Sybil addresses until the solvency check exhausts available capacity.

With ten attacker-controlled buyers, a premium of 10, and a payoff of 50, the attack removes 400 units from a 1,000-unit vault net of premiums.

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| CAI-H01 | High | Flights already cancelled off-chain remain insurable until the oracle catches up | Direct vault drain through guaranteed cancellation claims |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 0 | 0 | 0 |

---

## Assessment Information

| Field | Value |
| --- | --- |
| Project | Sentinel Protocol |
| Network | Stellar |
| Smart contract platform | Soroban |
| Programming language | Rust |
| Repository | https://github.com/SentinelFi/sentinel_soroban_v3/tree/main |
| Branch | `main` |
| Commit | `6b0db9ea9d6b1a349e16490942a75d4ae936a7f7` |
| Snapshot date | 2026-07-04 |

## Scope

### In Scope

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

The production flight-data executor is included in the timing analysis:

- `executor/centralized_cron/src/flight_data_fetcher.ts`
- `executor/centralized_cron/src/aeroapi_client.ts`

### Out of Scope

- Unit-test files and test-only modules
- Mocks, including `contracts/mock_usdc`
- `contracts/integration_tests`, except as a test harness
- Fuzz targets
- Frontend and unrelated off-chain services
- Deployment infrastructure and private operational systems
- Compromise of owner, administrator, keeper, controller, or oracle credentials

## Methodology

The assessment traced:

- every public production-contract entrypoint and authorization boundary;
- policy admission before and after each oracle state;
- whether an oracle can publish an outcome before policy registration;
- premium collection, collateral locking, settlement funding, and claims;
- multi-account and multi-transaction attack sequences;
- vault share and withdrawal-queue accounting;
- persistent-state archival and restoration behavior.

---

# Detailed Findings

## CAI-H01 — Flights already cancelled off-chain remain insurable until the oracle catches up

**Severity:** High  
**Impact:** Direct vault drain through guaranteed cancellation claims  
**Likelihood:** Medium to High  
**Confidence:** High

### Affected Components

- `contracts/controller/src/purchase.rs:19-27`
- `contracts/controller/src/purchase.rs:73-109`
- `contracts/controller/src/purchase.rs:111-167`
- `contracts/oracle_aggregator/src/queries.rs:12-20`
- `contracts/oracle_aggregator/src/lifecycle.rs:88-109`
- `contracts/oracle_aggregator/src/lifecycle.rs:113-153`
- `contracts/flight_pool_manager/src/lifecycle.rs:106-145`
- `contracts/controller/src/settle.rs:223-267`
- `contracts/flight_pool_manager/src/claim.rs:23-73`
- `executor/centralized_cron/src/flight_data_fetcher.ts:72-136`

### Description

`Controller::buy_insurance` attempts to prevent purchases after an outcome by accepting only two oracle states:

```rust
let oracle_status = oracle.get_flight_data(&flight_id, &date).status;
if !matches!(
    oracle_status,
    FlightStatus::NotInitiated | FlightStatus::Active
) {
    panic_with_error!(e, Error::FlightNotOpenForPurchase);
}
```

This protects flights whose outcome is already recorded on-chain. It does not protect flights whose cancellation is publicly known but not yet represented in OracleAggregator.

The oracle cannot preemptively close such a flight. Every outcome write requires an existing `FlightData` entry:

```rust
let mut data: FlightData = e
    .storage()
    .persistent()
    .get(&key)
    .expect("flight not registered");
```

Only the Controller can call `register_flight`, and it does so during `buy_insurance`, after the purchase gate has already accepted the missing record as `NotInitiated`:

```rust
pool.register_flight(...);
oracle.register_flight(&controller_addr, &flight_id, &date);
```

This creates a circular admission dependency:

```text
oracle cannot mark cancellation until a policy registers the flight
policy purchase is accepted because the oracle has no cancellation record
```

The first attacker therefore always succeeds for a pre-cancelled, previously unregistered flight, provided the normal route, date, and solvency checks pass.

The window remains open for additional accounts. `add_buyer` enforces uniqueness only per `(flight_id, date, buyer)`, so new addresses can each buy one policy. The whitelist is disabled by default. Each purchase transfers a premium and locks one full payoff, but a cancellation later funds and authorizes every policy claim.

### Production Timing Amplifier

The production executor makes the stale-state window materially longer.

For a `NotInitiated` flight it fetches AeroAPI data but uses only `scheduled_in`; it does not act on the returned `cancelled` flag:

```typescript
if (status === FlightStatus.NotInitiated) {
  const apiData = await aeroApi.getFlightData(flight.flight_id, dateStr);
  const eta = aeroApi.parseTimestamp(apiData.scheduled_in);
  await client.invokeContract(oracleId, "set_estimated_arrival", ...);
}
```

The flight becomes `Active`, which Controller still considers purchasable. The executor checks `apiData.cancelled` only in its `Active` branch and only after `estimatedArrival + 1 hour`:

```typescript
if (estimatedArrival + ONE_HOUR_SECS > nowSecs) {
  continue;
}

if (apiData.cancelled) {
  await client.invokeContract(oracleId, "set_cancelled", ...);
}
```

Thus, a cancellation announced days before departure can remain on-chain as `Active` until after the flight's scheduled arrival. Controller's calendar-day purchase cutoff reduces the window but does not close it when the cancellation is known before that cutoff.

### Root Cause

The protocol creates and attests a flight lazily, as a side effect of the first insurance purchase. It has no canonical pre-registered flight instance or signed, fresh oracle attestation on the purchase path.

As a result:

- absence of oracle data is interpreted as a safe, purchasable state;
- the oracle cannot publish a cancellation for an absent record;
- `Active` means only that an estimated arrival was stored, not that the flight is still operating;
- policy uniqueness is per address and does not prevent Sybil amplification.

### Exploit Scenario

1. An airline publicly cancels a whitelisted flight one or more days before departure.
2. The flight has no OracleAggregator record because nobody has purchased a policy yet.
3. The attacker creates or controls multiple addresses.
4. The first address calls `buy_insurance`.
5. `get_flight_data` returns the missing-record fallback `NotInitiated`, so the purchase succeeds and creates the oracle record.
6. Additional attacker addresses buy while the record remains `NotInitiated` or after the executor changes it to `Active`.
7. Each purchase pays premium `P`, increments `buyer_count`, and locks payoff `O`.
8. The oracle eventually records the already-known cancellation.
9. The keeper classifies and settles the flight.
10. RiskVault sends `(O - P) * buyer_count` to FlightPoolManager.
11. Every attacker address claims `O`.

The attacker's net gain and vault loss are:

```text
buyer_count * (payoff - premium)
```

The attacker can continue until the aggregate solvency check stops additional policies. The solvency check limits the drain to available backing but does not make any accepted guaranteed policy economically safe.

### Example Loss Calculation

For ten attacker-controlled traveler addresses buying the same pre-cancelled flight, the resulting asset flow is:

| Metric | Amount |
| --- | ---: |
| Initial vault managed assets | 1,000 |
| Policies | 10 |
| Premium per policy | 10 |
| Payoff per policy | 50 |
| Total premiums paid | 100 |
| Total claims received | 500 |
| Net vault loss | 400 |
| Final vault managed assets | 600 |

### Impact

This is a direct, permissionless vault-loss path:

- attackers buy only after the insured event is already certain;
- every accepted policy has deterministic positive expected value equal to `payoff - premium`;
- multiple accounts multiply claims against one cancelled flight;
- no oracle, keeper, owner, or administrator compromise is required;
- vault capital can be depleted up to the protocol's solvency/admission limit;
- passive underwriters absorb the loss.

The default-open buyer whitelist makes Sybil scaling practical. Enabling the whitelist can reduce the number of attacker-controlled buyers, but it does not repair the first-purchase flaw or protect approved accounts that act on public cancellation data.

### Recommendation

Insurance must not create its own oracle subject after the insured outcome is already observable.

Implement a canonical, oracle-attested flight registry before purchase:

1. The authorized oracle registers the exact flight instance before insurance sales open.
2. The instance includes immutable carrier/flight identity, origin, destination, scheduled departure, and a provider-specific identifier where available.
3. The oracle can change the sale state to `Closed` or `Cancelled` independently of whether any policy exists.
4. `buy_insurance` accepts only a pre-registered instance in an explicit `OpenForPurchase` state.
5. Cancellation publication and sale closure occur atomically.
6. A conservative sale cutoff closes admission before cancellation information is likely to become public.

If lazy registration must remain, require a fresh oracle-signed purchase attestation binding:

- the exact canonical flight instance;
- route;
- scheduled departure;
- current non-cancelled status;
- a short expiration time;
- a nonce or replay-resistant domain.

The attestation must be consumed atomically with purchase. A periodic `Active` status is insufficient, and merely checking the existing oracle enum cannot protect a flight that the oracle was structurally unable to record.

Add regression tests covering:

- a cancellation known before the first policy;
- cancellation while the record is `NotInitiated`;
- cancellation while the record is `Active` but before the executor's ETA gate;
- multiple attacker-controlled buyer addresses;
- transaction ordering around an oracle cancellation update;
- whitelist-enabled and whitelist-disabled modes.

---

# Conclusion

The current outcome-state check closes purchases only after an oracle state transition. It does not solve the more fundamental problem that OracleAggregator cannot represent a flight or its cancellation before the first policy purchase.

This lets informed attackers purchase deterministic cancellation claims and scale them across addresses until available vault backing is consumed. The protocol should require canonical oracle registration and an explicit sale-open state before accepting any policy.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, economic risks, or integration failures.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of these assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

This assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial or investment advice;
- compliance certification;
- a substitute for professional security auditing services.
