# cosminmarian53 Soroban Auditor AI Skills: Sentinel Soroban Findings Report

**Date:** 4 July 2026

---

## Assessment Information

| | |
|---|---|
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-07-04 |
| **Report Version** | v1.0 |
| **Assessment Status** | Final |
| **Assessment Type** | AI-Assisted Internal Security Review |
| **Auditor(s)** | cosminmarian53 Soroban Auditor AI Skills |
| **Assessment Platform** | [cosminmarian53 Soroban Auditor](https://github.com/cosminmarian53/skills/tree/main/soroban-auditor) |

---

## Repository Information

| | |
|---|---|
| **Repository URL** | [SentinelFi/sentinel_soroban_v3](https://github.com/SentinelFi/sentinel_soroban_v3/tree/main) |
| **Repository Visibility** | Public |
| **Branch Name** | `main` |
| **Git Commit Hash** | `6b0db9ea9d6b1a349e16490942a75d4ae936a7f7` |
| **Assessment Snapshot** | Source code state corresponding to the commit hash above |

---

## Scope

### In Scope

Production Rust sources in the following contract packages were included:

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

The review covered 65 production `.rs` files.

### Out of Scope

The following were explicitly excluded from vulnerability assessment:

- Tests and test-only source files
- Mocks, including `contracts/mock_usdc`
- Fuzz targets
- `contracts/integration_tests`
- Generated build artifacts, examples, and Cargo lockfiles

The integration harness was used only to dynamically reproduce the surviving High-severity finding. It was not assessed as production smart-contract code.

---

## Executive Summary

The assessment identified three validated findings: one High-severity vulnerability and two Low-severity correctness issues.

The High-severity issue arises because flight outcomes become public before their financial effect is incorporated into RiskVault's `TotalManagedAssets`. During this interval, an informed liquidity provider can redeem at the stale pre-loss price, transferring essentially the entire pending loss to passive LPs. The inverse strategy allows an LP to deposit before known premium income is booked.

The two Low-severity findings affect snapshot price accuracy and the correctness of maximum-withdrawal views while the withdrawal queue is active.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 |
| Medium | 0 |
| Low | 2 |
| Leads | 0 |

### Overall Risk Rating

**High**

The dynamically reproduced, permissionless loss-transfer path warrants a High overall risk rating. H-01 should be remediated and regression-tested before deployment or further capital acceptance.

---

## Findings

### [H-01] Public outcomes let informed LPs transfer pending losses to passive LPs

| Field | Value |
|---|---|
| Severity | High |
| Location | `risk_vault::deposit`, `withdraw`, `mint`, and `redeem` |
| Root Cause | Vault entry and exit remain enabled after a flight outcome becomes public but before its gain or loss is incorporated into `TotalManagedAssets`. |

**Summary**

RiskVault prices deposits and redemptions using the last recorded `TotalManagedAssets`. Oracle outcome publication, flight classification, and financial settlement occur in separate transactions.

An informed LP can therefore exit after an adverse outcome is public but before settlement reduces vault value, shifting the pending loss to passive LPs. The inverse strategy permits a new LP to enter immediately before already-known premium income is booked.

**Root Cause**

The entry and exit paths use current TMA and free capital but have no settlement epoch, pending-PnL reserve, or guard for economically resolved yet financially unsettled flights:

```rust
// contracts/risk_vault/src/vault_ops.rs
#[when_not_paused]
fn redeem(
    e: &Env,
    shares: i128,
    receiver: Address,
    owner: Address,
    operator: Address,
) -> i128 {
    Self::extend_ttl(e);
    operator.require_auth();

    if !Self::get_withdrawal_queue(e).is_empty() {
        panic_with_error!(e, Error::WithdrawalQueueActive);
    }

    let assets = managed_convert_to_assets(e, shares, Rounding::Floor);
    if assets > Self::get_free_capital(e) {
        panic_with_error!(e, Error::ExceedsFreeCapital);
    }

    Vault::withdraw_internal(e, &receiver, &owner, assets, shares, &operator);
```

The loss is recognized only during the later keeper settlement:

```rust
// contracts/controller/src/settle.rs
if payout_from_vault > 0 {
    vault.send_payout(&controller_addr, &pool_addr, &payout_from_vault);
}
```

The oracle outcome is already publicly observable before this call:

```rust
// contracts/oracle_aggregator/src/lifecycle.rs
data.status = FlightStatus::Cancelled;
e.storage().persistent().set(&key, &data);
emit_status_event(e, &flight_id, date, &FlightStatus::Cancelled);
```

**Impact**

The loss transfer is permissionless and repeatable for each publicly resolved but unsettled flight.

A Soroban PoC used two LP deposits of 1,000 assets and one policy with a 50-asset payoff and 10-asset premium. After cancellation and classification, the informed LP redeemed essentially its entire 1,000-asset position at the stale price. Settlement then charged essentially the full 40-asset net loss to the passive LP instead of distributing that loss across both LPs.

**Exploit Scenario**

1. Informed LP A and passive LP B each deposit 1,000 assets.
2. A policy locks a 50-asset payoff and holds a 10-asset premium.
3. The oracle publishes cancellation and the keeper classifies the flight.
4. The 40-asset net vault loss is now deterministic and public, but TMA is unchanged.
5. Before `execute_settlements`, LP A redeems all shares against stale TMA.
6. The free-capital check permits the exit because unlocked capital exceeds LP A's redemption.
7. Settlement reduces TMA by 40 assets.
8. LP B absorbs essentially the entire pending loss while LP A exits at the pre-loss price.

**PoC Verification**

```text
cargo test -p integration_tests informed_lp_externalizes_publicly_known_pending_loss

running 1 test
test tests::x_ray_poc::informed_lp_externalizes_publicly_known_pending_loss ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 88 filtered out
```

The temporary PoC was removed after verification.

**Recommended Fix**

Recognize pending PnL atomically when an outcome first becomes public, or introduce settlement epochs that block and correctly price both entry and exit until every published outcome is financially settled.

```diff
 #[when_not_paused]
 fn redeem(...) -> i128 {
+    require_no_economically_resolved_unsettled_outcomes(e);
     operator.require_auth();
```

Apply the same settlement-aware protection to:

- `deposit`
- `mint`
- `withdraw`
- `redeem`
- Queued-withdrawal pricing
- All preview and conversion methods

Add a regression test proving that LP ownership of pending gains and losses cannot change after an outcome becomes public.

---

### [L-01] Snapshot pricing counts liabilities excluded by executable pricing

| Field | Value |
|---|---|
| Severity | Low |
| Location | `risk_vault::snapshot` |
| Root Cause | `snapshot()` uses the dependency's raw-balance `Vault::total_assets()` instead of RiskVault's liability-adjusted `TotalManagedAssets`. |

**Summary**

Executable share conversions correctly exclude processed-but-uncollected withdrawal claims from backing. Daily snapshots use the physical vault token balance, so they count those liabilities and direct token donations as share backing and publish an inflated price.

**Root Cause**

The snapshot path uses a different asset basis from executable share conversions:

```rust
// contracts/risk_vault/src/snapshot.rs
let total_supply = Base::total_supply(e);
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

By contrast, executable conversions use `RiskVault::get_total_managed_assets`:

```rust
// contracts/risk_vault/src/vault_ops.rs
let managed_plus = RiskVault::get_total_managed_assets(e)
    .checked_add(1)
    .expect("managed assets overflow");
```

**Impact**

No current on-chain financial operation consumes snapshots, limiting the immediate impact to analytics and indexers.

If 500 of a 1,000-asset physical balance has already been credited as claimable, TMA is 500 while the snapshot numerator remains 1,000. The emitted snapshot therefore overstates executable share value by approximately 100%.

**Failure Scenario**

1. LPs provide 1,000 assets.
2. Queue processing burns shares, credits 500 assets as claimable, and reduces TMA to 500.
3. The 500 claimable assets remain physically in the vault until collection.
4. Anyone calls `snapshot()`.
5. The emitted price uses 1,000 rather than 500 as its numerator.
6. Off-chain consumers record an inflated share price.

**Recommended Fix**

Use the same liability-adjusted accounting basis as executable share conversions:

```diff
-    Vault::total_assets(e)
+    Self::get_total_managed_assets(e)
         .checked_mul(scale)
```

Add an invariant test requiring snapshot price to match the vault's executable conversion rate, subject only to the documented rounding direction.

---

### [L-02] Maximum-withdrawal views report amounts that active queues make unexecutable

| Field | Value |
|---|---|
| Severity | Low |
| Location | `risk_vault::max_withdraw` and `max_redeem` |
| Root Cause | `max_withdraw()` and `max_redeem()` omit the active-queue restriction enforced by `withdraw()` and `redeem()`. |

**Summary**

When any withdrawal request is queued, direct `withdraw` and `redeem` calls revert with `WithdrawalQueueActive`. Their corresponding maximum views can still return positive values, causing standards-based integrations to construct transactions guaranteed to fail.

**Root Cause**

The executable paths reject every direct exit while the queue is active:

```rust
// contracts/risk_vault/src/vault_ops.rs
if !Self::get_withdrawal_queue(e).is_empty() {
    panic_with_error!(e, Error::WithdrawalQueueActive);
}
```

The maximum views account for pause state, balances, and free capital but omit the same queue condition:

```rust
// contracts/risk_vault/src/vault_ops.rs
fn max_withdraw(e: &Env, owner: Address) -> i128 {
    if paused(e) {
        return 0;
    }
    let owner_assets =
        managed_convert_to_assets(e, Base::balance(e, &owner), Rounding::Floor);
    let free = Self::get_free_capital(e);
    owner_assets.min(free)
}

fn max_redeem(e: &Env, owner: Address) -> i128 {
    if paused(e) {
        return 0;
    }
    let owner_shares = Base::balance(e, &owner);
    let free_shares =
        managed_convert_to_shares(e, Self::get_free_capital(e), Rounding::Floor);
    owner_shares.min(free_shares)
}
```

**Impact**

The mismatch does not move funds incorrectly, but it breaks the vault integration contract for every LP while the queue is nonempty.

For example, an LP with shares worth 100 assets and at least 100 assets of free capital can receive `max_withdraw() == 100`, yet withdrawing any positive amount reverts with `WithdrawalQueueActive`.

**Failure Scenario**

1. An LP owns shares and the vault has positive free capital.
2. Any LP submits a valid queued-withdrawal request.
3. An integration reads `max_withdraw` or `max_redeem` and receives a positive value.
4. It submits the corresponding direct exit.
5. The active-queue guard rejects the transaction.

**Recommended Fix**

Return zero while the queue is active:

```diff
 fn max_withdraw(e: &Env, owner: Address) -> i128 {
-    if paused(e) {
+    if paused(e) || !Self::get_withdrawal_queue(e).is_empty() {
         return 0;
     }
```

Apply the same condition to `max_redeem`, and add conformance tests asserting that every maximum view reports zero whenever the corresponding operation is globally disabled.

---

## Findings Summary

| ID | Severity | Title |
|---|---|---|
| H-01 | High | Public outcomes let informed LPs transfer pending losses to passive LPs |
| L-01 | Low | Snapshot pricing counts liabilities excluded by executable pricing |
| L-02 | Low | Maximum-withdrawal views report amounts that active queues make unexecutable |

## Methodology

The review used six specialist lenses:

1. Access Control and Execution Flow
2. Deep Business Logic
3. Economic Security and Invariants
4. Math and Precision
5. Periphery and False-Positive Analysis
6. State Machine and Integration Boundaries

The specialists ran through the maximum available parallel agent capacity. A second contract-group pass independently covered Controller and FlightPoolManager, OracleAggregator and RiskVault, and GovernanceModule and SentinelTypes.

Candidates then passed through:

1. Source-line and guard-map verification
2. Documentation-intent review
3. State-transition and integration cross-checking
4. Severity classification
5. Exploit chaining
6. Final adversarial refutation
7. Dynamic Soroban reproduction for the surviving High finding

No composite exploit exceeded the severity of H-01. The workspace also passed:

```text
cargo check --workspace --lib

Finished `dev` profile [unoptimized + debuginfo] target(s)
```

---

## Limitations

This assessment represents a point-in-time review of the repository state identified in this report. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, or economic risks.

The review was limited to the defined production-contract scope and relied on available source code, documentation, tests, and observable contract behavior. Changes made after commit `6b0db9ea9d6b1a349e16490942a75d4ae936a7f7` were not assessed.

External infrastructure, deployment configuration, private operational systems, key management, frontend applications, off-chain services, and third-party dependencies were not comprehensively audited unless directly relevant to validating a reported finding.

AI-assisted analysis can produce incomplete or incorrect conclusions. Findings were subjected to independent verification and adversarial refutation within the assessment workflow, but this process is not a substitute for manual expert review, formal verification, comprehensive testing, or continuous production monitoring.

---

## Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of the assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

The assessment does not constitute:

- A formal security certification
- A guarantee of security
- Legal advice
- Financial advice
- Investment advice
