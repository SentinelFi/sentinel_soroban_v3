# Nemesis AI Auditor: Sentinel Protocol Security Assessment

**Date:** 4 July 2026

This report presents the verified Nemesis AI Auditor findings for the Sentinel
Protocol. Severity reflects protocol impact, exploitability, affected assets,
and operational risk in the assessed repository snapshot.

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
| **Auditor(s)** | Nemesis AI Auditor |
| **Assessment Platform** | [0xiehnnkta/nemesis-auditor](https://github.com/0xiehnnkta/nemesis-auditor) |

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

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

The assessment covered 65 production Rust files, approximately 5,012 lines,
124 public or trait entrypoints, and 182 functions including internal helpers
and cross-contract interface declarations.

### Out of Scope

- `contracts/mock_usdc`
- Mock contracts and mock infrastructure
- Unit-test files and `#[cfg(test)]` modules
- `contracts/integration_tests`
- Fuzz targets
- Frontend and off-chain executor code
- Deployment infrastructure and private operational systems
- Key custody and compromise of trusted owner, administrator, keeper,
  controller, or oracle credentials
- Third-party contracts and dependencies except where their implementation
  directly determined the behavior of an in-scope call

Tests were used only as verification harnesses; their implementation was not
audited.

---

## Executive Summary

The assessment identified three verified findings: one High-severity, one
Medium-severity, and one Low-severity issue.

The High-severity finding allows informed liquidity providers to exit after an
adverse flight outcome is publicly known but before its financial loss is
recorded in RiskVault. The exiting LP avoids a deterministically pending loss
and transfers it to passive LPs. The inverse strategy allows a depositor to enter
after a favorable outcome is known and capture premium income for risk they did
not underwrite.

The Medium-severity finding affects protocol availability. OracleAggregator and
FlightPoolManager each store all active flights in one capped vector. Once
either vector contains 1,000 entries, new flight registration fails and all new
policy purchases are rejected. OracleAggregator retains settled flights for 30
days, so ordinary settled-flight volume can consume the entire capacity.

The Low-severity finding affects RiskVault analytics. Executable share
conversions correctly use Total Managed Assets, but daily snapshots use the
vault's physical token balance. Pending claimable withdrawals therefore inflate
the published snapshot price.

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| NM-001 | High | Public flight outcomes give LPs a free option before settlement | Loss evasion and LP value transfer |
| NM-002 | Medium | Global active-list caps can halt all new policy admission | Protocol-wide purchase denial |
| NM-003 | Low | Snapshot pricing includes liabilities excluded from executable pricing | Incorrect analytics and indexer data |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 1 | 1 | 0 |

### Overall Risk Rating

**High**

The High-severity issue permits deterministic transfer of flight losses or
income between LPs without privileged access. It should be resolved before the
vault accepts material production capital. The active-list capacity issue
should be addressed before protocol flight volume approaches the configured
limit.

---

## Methodology

Nemesis used an alternating, feedback-driven audit process:

1. A complete Feynman business-logic pass questioned purpose, ordering,
   assumptions, boundaries, error paths, and multi-transaction behavior across
   every in-scope entrypoint.
2. A complete state-inconsistency pass mapped coupled state, mutation paths,
   parallel operations, and missing counterpart updates.
3. State gaps were fed back into targeted Feynman interrogation to identify
   their underlying assumptions and adversarial transaction sequences.
4. New root causes were fed into a targeted state re-analysis.
5. The process converged after four passes with no new findings in the final
   pass.

The assessment specifically examined:

- authorization and cross-contract invocation boundaries;
- route authorization, policy registration, and buyer accounting;
- collateral locking and release across all settlement outcomes;
- oracle and pool lifecycle synchronization;
- vault deposits, redemptions, queued withdrawals, claimable liabilities, and
  share pricing;
- public outcome timing and multi-transaction ordering;
- collection capacity and contract-data entry limits;
- persistent and instance storage lifecycle;
- defensive code that could mask broken invariants.

Every Critical, High, and Medium hypothesis was verified by a concrete code
trace, an executable reproduction, or both. Hypotheses that relied on test-only
state mutation or contradicted Soroban runtime semantics were excluded.

---

# Detailed Findings

## [NM-001] Public flight outcomes give LPs a free option before settlement

| Field | Value |
| --- | --- |
| **Severity** | High |
| **Affected Components** | OracleAggregator outcome writes, Controller classification and settlement, RiskVault entry and exit |
| **Impact** | LP loss evasion, income capture, and value transfer between liquidity providers |
| **Status** | Open |
| **Discovery Path** | Feynman ordering analysis enriched by state-coupling analysis |
| **Verification** | Current-commit code trace and executable PoC |

### Description

Flight outcome recognition and its financial effect occur in separate,
publicly observable transactions:

1. OracleAggregator records `Landed` or `Cancelled`.
2. Controller classifies the flight into a `ToBeSettled*` status.
3. A later Controller settlement records premium income or charges the payout
   loss to RiskVault.

After the first step, the outcome is public and economically deterministic, but
RiskVault's Total Managed Assets and share price still reflect the pre-outcome
state. The vault continues to allow `deposit`, `mint`, `withdraw`, and `redeem`.

An informed LP can redeem after a cancellation or qualifying delay becomes
public but before the vault pays the claim. The exiting LP receives the
pre-loss share value, leaving passive LPs to absorb the full loss. Conversely, a
new LP can deposit after an on-time outcome is public but before premium income
is booked, capturing income from risk it never underwrote.

### Affected Code

- `contracts/oracle_aggregator/src/lifecycle.rs:54-108`
- `contracts/controller/src/settle.rs:19-278`
- `contracts/risk_vault/src/vault_ops.rs:67-155`

### Broken Invariant

Share entry and exit pricing must include all economically determined gains and
losses attributable to the current shareholders.

The public oracle state and the vault's recognized PnL are coupled, but no
pending-PnL state, settlement epoch, or entry/exit lock connects them.

### Exploit Scenario

1. LP A and LP B deposit equal amounts into RiskVault.
2. A traveler buys a policy, locking collateral.
3. OracleAggregator publicly records that the flight is cancelled.
4. LP A observes the cancellation and redeems before classification and
   settlement.
5. Controller classifies and settles the flight.
6. The net claim loss is charged after LP A has exited, so LP B absorbs the
   loss.

No privileged role is required. The attacker only needs to monitor public
ledger state and submit a vault transaction before the keeper completes
settlement.

### Verification

A temporary current-commit unit PoC used:

- two LP deposits of 1,000 assets each;
- one policy with a premium of 10 and payoff of 50;
- a publicly recorded cancellation;
- one LP redemption before classification and settlement.

After settlement, the exiting LP's proceeds exceeded the passive LP's remaining
share value by at least 39 assets, approximately the full 40-asset net loss paid
by the vault. The PoC passed and was removed after execution.

Transaction atomicity does not mitigate the issue because the exploitable
window exists between separate successful transactions.

### Recommendation

Use one of the following designs:

1. Introduce settlement epochs. Queue vault entry and exit, then price them only
   after all outcomes disclosed during the epoch are financially settled.
2. Record pending PnL when `Landed` or `Cancelled` becomes public, before vault
   entry or exit can use the old price.
3. Temporarily disable both deposits and withdrawals whenever any public
   outcome remains financially unsettled.

The fix must cover both directions: pre-loss exits and pre-income deposits.
A withdrawal-only cooldown is insufficient.

---

## [NM-002] Global active-list caps can halt all new policy admission

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | OracleAggregator and FlightPoolManager active-flight storage and registration |
| **Impact** | Protocol-wide denial of new policy purchases |
| **Status** | Open / architectural remediation required |
| **Discovery Path** | Feynman boundary analysis enriched by coupled-state mapping |
| **Verification** | Boundary tests and complete registration call trace |

### Description

OracleAggregator and FlightPoolManager each store all active flights in a
single instance-storage `Vec<(Symbol, u64)>`. Both vectors are capped at 1,000
entries to avoid exceeding Soroban's 65,536-byte contract-data entry limit.

When either list reaches the cap, `register_flight` rejects the next flight.
Controller's purchase flow requires successful registration in both contracts,
so either rejection atomically aborts `buy_insurance`. Vault capital, route
authorization, and per-flight validity do not affect this failure.

FlightPoolManager removes a flight from its list on settlement.
OracleAggregator intentionally retains settled flights for 30 days before
permissionless pruning. Consequently, the oracle list counts both active and
recently settled flights. Approximately 34 settled flight-days per day are
enough to consume the 1,000-entry capacity over the retention window.

The caps prevent storage corruption but convert the underlying monolithic
storage limitation into a deterministic protocol-wide admission outage.

### Affected Code

- `contracts/oracle_aggregator/src/constants.rs:15-24`
- `contracts/oracle_aggregator/src/lifecycle.rs:135-150`
- `contracts/flight_pool_manager/src/constants.rs:25-35`
- `contracts/flight_pool_manager/src/lifecycle.rs:80-94`
- `contracts/controller/src/purchase.rs:111-124`

### Broken Invariant

A valid, solvent policy purchase should not depend on unrelated historical
flights fitting inside one global ledger entry.

### Trigger Scenario

1. The oracle active list accumulates 1,000 active or recently settled flights.
2. A traveler submits a valid policy purchase for a new flight.
3. Controller calls `FlightPoolManager::register_flight` and
   `OracleAggregator::register_flight`.
4. OracleAggregator rejects the registration with `ActiveFlightListFull`.
5. The entire purchase reverts.
6. Every subsequent new flight purchase fails until entries become eligible for
   pruning and someone successfully prunes them.

An attacker may accelerate exhaustion only where enough authorized routes and
capital exist, but ordinary protocol growth can reach the same state without an
attacker.

### Verification

The repository's boundary tests were executed against the assessed commit:

| Test | Result |
| --- | --- |
| `oracle_aggregator::test_register_flight_rejects_when_active_list_full` | Passed; contract error 606 |
| `flight_pool_manager::test_register_flight_rejects_when_active_list_full` | Passed; contract error 417 |

The Controller call trace confirms that registration in both contracts is a
mandatory part of every first purchase for a flight.

### Recommendation

Replace each monolithic vector with scalable keyed or paginated storage:

- individually keyed active-flight records;
- count and head/tail metadata;
- a reverse index for constant-time removal;
- paginated read methods;
- a migration path for existing active-list state.

As an interim mitigation:

- shorten settled-flight retention;
- prune explicitly settled flights early when capacity approaches the cap;
- expose capacity metrics and alerts;
- reject new route activation before remaining capacity becomes operationally
  unsafe.

---

## [NM-003] Snapshot pricing includes liabilities excluded from executable pricing

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Affected Components** | RiskVault share-price snapshots |
| **Impact** | Inflated analytics and incorrect off-chain share-price history |
| **Status** | Open |
| **Discovery Path** | State-only parallel-path comparison |
| **Verification** | Contract and dependency source trace |

### Description

RiskVault's executable share conversions correctly use internal Total Managed
Assets rather than the vault's physical token balance. This excludes processed
but uncollected withdrawal liabilities from the backing attributed to
outstanding shares.

The daily `snapshot()` path uses a different asset basis:

```rust
let price = if total_supply > 0 {
    Vault::total_assets(e)
        .checked_mul(scale)
        .expect("multiplication overflow")
        .checked_div(total_supply)
        .expect("division by zero")
} else {
    scale
};
```

`Vault::total_assets(e)` is the inherent dependency method from
`stellar-tokens 0.7.1`; it reads the physical asset-token balance of the vault.
After withdrawal-queue processing:

```text
physical balance = Total Managed Assets + uncollected claimable balances
```

The snapshot therefore treats assets already owed to withdrawing LPs as backing
for outstanding shares. Direct token donations can also inflate the snapshot.
Executable deposits and redemptions are not affected because they use the
managed-asset conversion helpers.

### Affected Code

- `contracts/risk_vault/src/snapshot.rs:46-60`
- `contracts/risk_vault/src/vault_ops.rs:28-63`
- `stellar-tokens 0.7.1`, `vault/storage.rs`, inherent `Vault::total_assets`

### Broken Invariant

All share-price representations must use the same asset basis as executable
share conversion.

### Consequence

Off-chain indexers and analytics consuming `SharePriceSnapshot` events can
publish an inflated vault share price while claimable withdrawals remain
uncollected. No current on-chain financial operation consumes these snapshots,
which limits the finding to Low severity.

### Verification

Source tracing confirmed:

- `managed_convert_to_shares` and `managed_convert_to_assets` use
  `RiskVault::get_total_managed_assets`;
- `snapshot` calls the dependency's inherent `Vault::total_assets`;
- the dependency implementation returns the vault's physical asset-token
  balance.

### Recommendation

Use the managed-asset basis in `snapshot()`:

```rust
let price = if total_supply > 0 {
    RiskVault::get_total_managed_assets(e)
        .checked_mul(scale)
        .expect("multiplication overflow")
        .checked_div(total_supply)
        .expect("division by zero")
} else {
    scale
};
```

Add a regression test that:

1. creates and processes a withdrawal request;
2. leaves the resulting claimable balance uncollected;
3. records a snapshot;
4. verifies the snapshot matches `TMA / total_supply`, not physical balance
   divided by total supply.

---

## Positive Security Properties

The review confirmed the following material protections:

- Policy dates are day-aligned, closing the prior duplicate-timestamp claim
  path.
- Purchase admission enforces aggregate collateralization at the configured
  solvency ratio.
- Pool and oracle registration are transaction-atomic with premium transfer,
  collateral locking, and buyer accounting.
- Flight status transitions are forward-only.
- Purchases are rejected after the oracle records a terminal outcome.
- Every normal settlement branch releases `payoff * buyer_count` of locked
  collateral.
- Executable vault pricing consistently excludes pending claimable
  liabilities by using TMA.
- Withdrawal requests escrow shares, and cancellation or processing returns or
  burns the matching amount.
- Route and flight-ID uniqueness-index TTLs are renewed together.
- Keeper loops are bounded and use rotating cursors.
- Claiming remains open during a pause so a pause cannot consume the claim
  window.

---

## Conclusion

The assessed snapshot materially improves on the 25 June 2026 audit baseline:
the duplicate policy identity, executable claimable-liability pricing,
aggregate solvency, oversized keeper batch, route-index TTL, and long-dated
storage issues are remediated.

One previously documented High-severity architectural risk remains open:
public flight outcomes are financially recognized after a transaction window
in which LPs can still enter or exit. The active-list architecture also imposes
a practical protocol-wide capacity ceiling. These should be resolved before
the protocol operates with material vault capital or sustained production
flight volume.

The snapshot-price inconsistency is isolated from on-chain financial behavior
and can be corrected with a small, targeted change.

---
