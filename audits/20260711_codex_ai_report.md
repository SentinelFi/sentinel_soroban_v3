# Sentinel Protocol — Smart Contract Security Assessment

**Assessment date:** 11 July 2026  
**Report version:** v1.0  
**Assessment status:** Final  
**Assessment type:** AI-Assisted Internal Security Review
**Auditor:** Codex AI  

---

## Executive Summary

This assessment identified one high-severity vulnerability and one medium-severity vulnerability in the reviewed Sentinel Protocol smart contracts.

The protocol sells insurance whenever the on-chain oracle row is `NotInitiated` or `Active`. This blocks purchases only after the oracle has already written an outcome. It does not require a fresh non-cancelled attestation at purchase time, and it does not distinguish a still-valid flight from an off-chain cancellation that has not yet reached the oracle contract.

An attacker who observes a public cancellation before the oracle update can buy policies while the row is missing or stale, then claim the full payoff after the oracle records the cancellation and the keeper settles the flight. The attacker pays only the premium up front and receives the configured payoff for every buyer address. With a premium below the payoff, each accepted policy extracts `payoff - premium` from vault capital.

The assessment also identified a capital-locking path for flights that have moved from `NotInitiated` to `Active` but never receive a terminal oracle outcome. The protocol has a stale-flight timeout for `NotInitiated` rows, but no equivalent timeout for `Active` rows. Such flights remain active indefinitely, keeping vault collateral locked and consuming pool/oracle active-list capacity.

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| CAI-H01 | High | Stale oracle state permits deterministic cancellation-claim purchases | Direct vault drain through guaranteed claims |
| CAI-M01 | Medium | Active flights without terminal oracle data can lock collateral indefinitely | Underwriter capital lock and active-list capacity consumption |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 1 | 0 | 0 |

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol |
| Network | Stellar |
| Smart contract platform | Soroban |
| Programming language | Rust |
| Repository | https://github.com/SentinelFi/sentinel_soroban_v3/tree/main |
| Branch | `main` |
| Commit | `cdac8a8bf33e80dc4a1308642dc65978becbddfb` |
| Snapshot date | 2026-07-11 |

## Scope

### In Scope

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

### Out of Scope

- Unit-test files and test-only modules
- Mocks, including `contracts/mock_usdc`
- `contracts/integration_tests`
- Fuzz targets
- Frontend and off-chain services
- Deployment infrastructure and private operational systems
- Compromise of owner, administrator, keeper, controller, or oracle credentials

---

# Detailed Findings

## CAI-H01 — Stale oracle state permits deterministic cancellation-claim purchases

**Severity:** High  
**Impact:** Direct vault drain through guaranteed claims  
**Likelihood:** Medium  
**Confidence:** High

### Affected Components

- `contracts/controller/src/purchase.rs:94-109`
- `contracts/controller/src/purchase.rs:143-189`
- `contracts/oracle_aggregator/src/lifecycle.rs:25-61`
- `contracts/oracle_aggregator/src/lifecycle.rs:112-165`
- `contracts/oracle_aggregator/src/lifecycle.rs:173-210`
- `contracts/flight_pool_manager/src/lifecycle.rs:117-143`
- `contracts/controller/src/settle.rs:251-285`
- `contracts/flight_pool_manager/src/claim.rs:30-69`

### Description

`Controller::buy_insurance` admits a purchase when the oracle reports either `NotInitiated` or `Active`:

```rust
let oracle_status = oracle.get_flight_data(&flight_id, &date).status;
if !matches!(
    oracle_status,
    FlightStatus::NotInitiated | FlightStatus::Active
) {
    panic_with_error!(e, Error::FlightNotOpenForPurchase);
}
```

This gate only proves that the on-chain oracle contract has not yet recorded a terminal outcome. It does not prove that the real flight is still operating or that the oracle data is fresh at the time of purchase.

The oracle can now write a cancellation tombstone before the first policy exists, and that tombstone correctly blocks later purchases. However, the purchase path remains fail-open until that write lands on-chain. A flight whose cancellation is already public but not yet submitted by the oracle is indistinguishable from a valid unreported flight: `get_flight_data` returns `NotInitiated` for a missing row, and a stale `Active` row is also accepted.

After the purchase gate passes, the controller registers or refreshes the flight, charges the premium, locks the full payoff, and records the buyer:

```rust
pool.register_flight(...);
oracle.register_flight(&controller_addr, &flight_id, &date);
asset.transfer(&traveler, &pool_addr, &terms.premium);
vault.increase_locked(&controller_addr, &terms.payoff);
pool.add_buyer(&controller_addr, &flight_id, &date, &traveler);
```

`add_buyer` prevents only the same address from buying the same `(flight_id, date)` twice. It does not limit one economic actor from buying through multiple addresses. Once the oracle later records `Cancelled`, settlement funds the pool with `(payoff - premium) * buyer_count`, opens the cancellation claim window, and each buyer can claim the full payoff.

### Root Cause

The contract treats absence of an on-chain outcome as an affirmative purchase signal. The accepted states are broad operational states (`NotInitiated` and `Active`), not a fresh sale authorization.

The cancellation tombstone path protects only cancellations already written on-chain. It does not protect the interval between public cancellation discovery and the oracle transaction that records that cancellation.

### Exploit Scenario

1. A whitelisted flight is publicly cancelled before the purchase cutoff.
2. The oracle row is still absent or remains `Active`.
3. The attacker buys insurance from one address.
4. The attacker repeats the purchase from additional addresses while the stale state remains accepted.
5. Each purchase pays `premium` and locks `payoff`.
6. The oracle records `Cancelled`.
7. The keeper classifies and executes settlement.
8. The vault transfers `(payoff - premium) * buyer_count` to FlightPoolManager.
9. Every attacker-controlled buyer claims `payoff`.

The attacker's net gain and the vault's net loss are:

```text
buyer_count * (payoff - premium)
```

The solvency check limits the maximum accepted exposure but does not make accepted stale-state policies safe. It ensures that the vault can pay the loss; it does not prevent selling guaranteed claims.

### Example Loss Calculation

| Metric | Amount |
| --- | ---: |
| Attacker-controlled buyer addresses | 10 |
| Premium per policy | 10 |
| Payoff per policy | 50 |
| Total premiums paid by attacker | 100 |
| Total claims received by attacker | 500 |
| Net vault loss | 400 |

### Impact

This is a permissionless vault-drain path whenever public cancellation information reaches attackers before the oracle update reaches the contract:

- every accepted policy has deterministic positive value equal to `payoff - premium`;
- multiple buyer addresses scale the drain until solvency capacity is exhausted;
- the attacker does not need owner, administrator, keeper, controller, or oracle credentials;
- passive underwriters absorb the loss after settlement.

The buyer whitelist can reduce Sybil scale when enabled and tightly operated, but it does not repair the stale-state admission rule for approved buyers.

### Recommendation

Replace stale-state admission with explicit, fresh sale authorization.

The strongest design is an oracle-attested sale state:

1. The oracle registers each flight instance before sales open.
2. The record includes a canonical carrier/flight/date identity, origin, destination, scheduled times, and provider identifier where available.
3. The record has an explicit `OpenForPurchase` state separate from `NotInitiated` and `Active`.
4. `buy_insurance` accepts only `OpenForPurchase`.
5. The oracle can close sales independently of settlement by writing `Closed`, `Cancelled`, or another non-purchasable state.
6. The sale state includes a freshness deadline; purchases after that deadline require a newer oracle update.

If lazy registration remains, require a short-lived oracle authorization consumed atomically by `buy_insurance`. The authorization should bind:

- the exact `(flight_id, origin, dest, date)` instance;
- the current non-cancelled sale state;
- an expiration timestamp;
- the premium, payoff, and delay threshold or a route-term version;
- a nonce or replay-resistant domain.

Do not treat `NotInitiated` or `Active` as sufficient evidence that a flight is still insurable.

---

## CAI-M01 — Active flights without terminal oracle data can lock collateral indefinitely

**Severity:** Medium  
**Impact:** Underwriter capital lock and active-list capacity consumption  
**Likelihood:** Medium  
**Confidence:** High

### Affected Components

- `contracts/controller/src/settle.rs:60-130`
- `contracts/oracle_aggregator/src/storage.rs:83-103`
- `contracts/oracle_aggregator/src/lifecycle.rs:214-269`
- `contracts/risk_vault/src/capital.rs:20-53`
- `contracts/flight_pool_manager/src/settle.rs:27-65`

### Description

The protocol has a stale-flight recovery path for flights that never receive any oracle data. In `classify_flights`, a `NotInitiated` row that remains stale past `date + STALE_FLIGHT_TIMEOUT_SECS` is classified as `ToBeSettledOnTime`, allowing the settlement pass to forward premiums to the vault, release the locked payoff, and close the pool bucket:

```rust
FlightStatus::NotInitiated => {
    let stale_at = date
        .checked_add(sentinel_types::timeouts::STALE_FLIGHT_TIMEOUT_SECS)
        .expect("addition overflow");
    if oracle.has_flight_data(&flight_id, &date)
        && e.ledger().timestamp() >= stale_at
    {
        Some(FlightStatus::ToBeSettledOnTime)
    } else {
        None
    }
}
```

No equivalent timeout exists once the row becomes `Active`. `classify_flights` handles only `Cancelled`, `Landed`, and stale `NotInitiated`. An `Active` row that never receives `set_landed` or `set_cancelled` falls through to `_ => None` forever.

The oracle state machine also has no transition from `Active` to a void or timeout settlement state. It allows:

```rust
(FlightStatus::Active, FlightStatus::Landed)
| (FlightStatus::Active, FlightStatus::Cancelled)
```

but not `Active -> ToBeSettledOnTime` after a timeout.

This leaves a one-way liveness gap:

1. `buy_insurance` registers the flight and locks `payoff` in RiskVault.
2. The oracle writes `set_estimated_arrival`, moving the row to `Active`.
3. The oracle never writes `set_landed` or `set_cancelled`.
4. The row remains in the oracle active list and the pool active list.
5. The vault's locked capital is never decreased.
6. The pool bucket never settles and never releases its active-list slot.

### Root Cause

The stale-flight timeout applies only to rows that remain `NotInitiated`. The moment an estimated arrival is written, the protocol assumes a terminal oracle outcome will eventually arrive. There is no bounded fallback for an `Active` row whose terminal data never appears.

### Attack Scenario

1. An attacker buys policies for valid whitelisted route/date pairs.
2. The oracle writes scheduled arrival data, moving each row to `Active`.
3. Terminal data never arrives due to provider gaps, executor failure, flight-record ambiguity, or an oracle pipeline outage after the initial `Active` write.
4. The attacker has paid premiums, but each policy keeps a full `payoff` locked in the vault indefinitely.
5. Repeating across flights and buyer addresses consumes vault capacity until the solvency check rejects new purchases.

The attacker does not receive the locked capital, so this is not a direct theft path. The practical impact is a paid griefing attack against underwriter liquidity and protocol capacity. The attacker's cost is the premium; the capital pinned per policy is the full payoff.

### Impact

Active rows without terminal outcomes can:

- keep `LockedCapital` elevated indefinitely;
- reduce free capital available for underwriter exits;
- reduce capacity for new policy sales;
- consume FlightPoolManager and OracleAggregator active-list slots;
- force owner/operator intervention or a contract upgrade for recovery.

This is materially worse than a bounded delayed settlement because neither normal keeper entrypoint can progress the row after it is stuck `Active`.

### Recommendation

Add a bounded `Active` timeout path.

One conservative design:

1. Store or derive a latest expected terminal-report deadline for each flight.
2. Permit `Active -> ToBeSettledOnTime` only after that deadline plus a safety buffer.
3. Require the same timing check in `OracleAggregator::set_to_be_settled`, not only in Controller.
4. Emit a distinct event such as `FlightTimedOutActive` so operators and users can distinguish this from an ordinary on-time settlement.
5. Route premiums to the vault and release locked collateral, matching the existing void semantics.

For routes where a missing terminal outcome should not be treated as on-time, add an explicit owner-gated recovery path that can close an `Active` bucket after off-chain finality is established. The key requirement is that every state that locks vault collateral must have a bounded terminal path.

---

# Conclusion

The reviewed contracts preserve the main accounting invariants once a policy reaches a terminal settlement state: premiums are collected, collateral is locked, settlement funds claims, and double claims are blocked.

The high-severity issue is admission itself. The controller sells policies based on stale oracle state instead of a fresh non-cancelled sale authorization. That allows informed buyers to purchase deterministic cancellation claims and extract vault capital up to the protocol's accepted exposure.

The medium-severity issue is terminal liveness for `Active` flights. Every state that locks vault collateral needs a bounded path to settlement or explicit recovery.

The purchase path should require explicit, fresh oracle authorization for each sale before deployment with material vault liquidity, and active-flight timeout handling should be added before production volume can pin meaningful underwriter capital.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, economic risks, or integration failures. The runtime behavior of archived persistent entries (CF5-M01) was assessed from protocol documentation and SDK behavior, not from a live-network experiment; the recommended testnet confirmation should be performed before acting on dependent findings.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of these assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

This assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial or investment advice;
- compliance certification;
- a substitute for professional security auditing services.
