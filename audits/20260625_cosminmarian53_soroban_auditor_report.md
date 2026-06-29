# cosminmarian53 Soroban Auditor AI Skills: Sentinel Soroban Findings Report

**Date:** 25 June 2026

This report contains the cosminmarian53 Soroban Auditor AI Skills findings validated against the current codebase. False positives and stale findings were excluded. Severity is based on likely protocol impact, exploitability, and operational risk.

---

## Assessment Information

| | |
|---|---|
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-06-25 |
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
| **Git Commit Hash** | `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7` |
| **Assessment Snapshot** | Source code state corresponding to the commit hash above |

---

## Scope

### In Scope

The following contract packages were included in the assessment:

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/mock_usdc`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

### Out of Scope

The following package was explicitly excluded from vulnerability assessment:

- `contracts/integration_tests`

Integration tests were consulted only where necessary to understand intended behavior or identify test-environment assumptions. They were not assessed as production smart-contract code.

Standard exclusions also applied to generated build artifacts, mocks, examples, test-only source files, and Cargo lockfiles.

---

## Executive Summary

The assessment identified four validated security findings: one High-severity vulnerability and three Medium-severity vulnerabilities. The High-severity issue was reproduced using a standalone Soroban test and allows existing vault participants to extract almost the entirety of a later depositor's assets under a reachable withdrawal-queue sequence.

The Medium-severity findings affect core settlement availability, route identity integrity, and enforcement of the configured solvency margin. One additional queue-resource concern remains a lead because a concrete Soroban resource-failure threshold was not established.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 0 |
| Leads | 1 |

### Overall Risk Rating

**High**

The presence of a dynamically confirmed, permissionless asset-extraction path warrants a High overall risk rating. H-01 should be remediated and regression-tested before deployment or further capital acceptance.

---

## Findings

### [H-01] Claimable liabilities inflate remaining shares and enable theft from later depositors

| Field | Value |
|---|---|
| Severity | High |
| Location | `risk_vault::process_withdrawal_queue`, `deposit`, and `redeem` |
| Root Cause | Processed withdrawals remain in the vault's physical token balance as claimable liabilities while share conversions continue treating those tokens as assets backing outstanding shares. |

**Summary**

Withdrawal-queue processing burns the withdrawing user's shares and reduces Total Managed Assets, but does not transfer the corresponding assets out of the vault. Instead, it records a claimable balance that can be collected later.

The underlying vault implementation calculates share conversions using the contract's physical token balance. Consequently, assets already owed to queued withdrawers continue inflating the value of remaining shares. Existing holders can redeem this artificial value after a victim deposits, extracting almost the victim's entire deposit.

**Root Cause**

Queue processing burns shares, creates a claimable liability, and reduces TMA without moving the underlying assets:

```rust
// contracts/risk_vault/src/capital.rs
Base::update(e, Some(&vault_addr), None, request.shares);

let new_balance = claimable.checked_add(assets).expect("addition overflow");
e.storage().persistent().set(&key, &new_balance);

tma = tma.checked_sub(assets).expect("subtraction underflow");
e.storage()
    .instance()
    .set(&VaultKey::TotalManagedAssets, &tma);
```

Deposits and redemptions continue delegating pricing to `Vault`, whose conversions use the physical asset balance:

```rust
// contracts/risk_vault/src/vault_ops.rs
let shares = Vault::deposit(e, assets, receiver, from, operator);
let assets = Vault::preview_redeem(e, shares);
let actual_assets = Vault::redeem(e, shares, receiver, owner, operator);
```

The assets leave the vault only when the credited user subsequently calls `collect`:

```rust
// contracts/risk_vault/src/claims.rs
asset.transfer(&e.current_contract_address(), &caller, &claimable);
```

**Impact**

A permissionless sequence of normal deposits, withdrawal-queue processing, and redemption can steal almost an entire subsequent deposit.

The dynamic PoC used two attackers depositing 500 units each:

1. Attacker A queues and processes a 500-unit withdrawal.
2. A's shares are burned and 500 units become claimable, but the vault still physically holds 1,000 units.
3. A victim deposits another 500 units and receives underpriced shares.
4. Attacker B redeems inflated shares for almost 1,000 units.
5. Attacker A collects the original 500 units.
6. The victim is left with at most one base unit.

This is repeatable against later depositors whenever claimable liabilities remain inside the vault.

**PoC Verification**

```text
running 1 test
test claimable_liabilities_inflate_remaining_shares ... ok

test result: ok. 1 passed; 0 failed
```

The temporary PoC and generated snapshot were removed after execution.

**Recommended Fix**

Use net managed assets for every conversion:

```text
net_assets = physical_token_balance - total_claimable_liabilities
```

Apply the same basis consistently to deposit, mint, withdraw, redeem, preview, conversion, and snapshot calculations. Alternatively, immediately transfer processed withdrawal assets into a separate escrow contract whose balance is excluded from vault pricing.

Add an invariant test asserting that creating a claimable withdrawal does not change the exchange rate of unrelated outstanding shares.

---

### [M-01] Missing nested authorization prevents on-time settlement

| Field | Value |
|---|---|
| Severity | Medium |
| Location | `controller::settle`, `flight_pool_manager::settle_on_time`, and `risk_vault::record_premium_income` |
| Root Cause | The Controller authorizes the call into FlightPoolManager but does not authorize the deeper FlightPoolManager-to-RiskVault invocation that requires the Controller's address. |

**Summary**

During on-time settlement, the Controller invokes `FlightPoolManager::settle_on_time`. The pool transfers collected premiums to RiskVault and then invokes `record_premium_income`, passing the Controller address.

RiskVault calls `controller.require_auth()`. Soroban authorization does not automatically permit an arbitrary deeper invocation requiring the original contract's address. The Controller does not construct the necessary nested authorization tree, so settlements with at least one buyer revert atomically.

**Root Cause**

The Controller initiates settlement:

```rust
// contracts/controller/src/settle.rs
pool.settle_on_time(&controller_addr, &flight_id, &date);
```

FlightPoolManager performs a deeper call:

```rust
// contracts/flight_pool_manager/src/settle.rs
let args = (&controller, &total_premium).into_val(e);
e.invoke_contract::<()>(
    &vault_addr,
    &Symbol::new(e, "record_premium_income"),
    args,
);
```

RiskVault requires the Controller to authorize that invocation:

```rust
// contracts/risk_vault/src/auth.rs
pub(crate) fn require_controller(e: &Env, controller: &Address) {
    controller.require_auth();
    // ...
}
```

No `authorize_as_current_contract` call constructs authorization for the Pool-to-Vault sub-invocation.

**Impact**

Every on-time flight with one or more buyers can fail settlement. The transaction rollback leaves premiums in the pool and collateral locked, blocking a core protocol lifecycle until the contracts are upgraded.

Flights with no buyers avoid the Vault call and do not exercise the broken path.

Existing tests use broad authorization mocking, which masks the production authorization failure.

**Exploit/Failure Scenario**

1. A traveler buys a policy.
2. The oracle classifies the flight as on time.
3. A keeper invokes Controller settlement.
4. Controller calls FlightPoolManager with Controller authorization.
5. FlightPoolManager transfers premiums and calls RiskVault.
6. RiskVault requires Controller authorization for this deeper invocation.
7. No matching nested authorization exists, so settlement reverts.

**Recommended Fix**

Prefer making the Controller call `record_premium_income` directly after FlightPoolManager transfers the premiums. Otherwise, construct an exact nested authorization entry with `authorize_as_current_contract` before invoking FlightPoolManager.

Add an integration test that does not use `mock_all_auths` and validates the complete authorization tree.

---

### [M-02] Route uniqueness index expires independently from the active route

| Field | Value |
|---|---|
| Severity | Medium |
| Location | `governance_module::route_status` and `whitelist_route` |
| Root Cause | Reads refresh the route entry's TTL but not the separate `FlightRoute` uniqueness index that prevents conflicting routes from sharing a flight ID. |

**Summary**

The protocol stores active route terms under `(flight_id, origin, destination)` and maintains a separate `FlightRoute(flight_id)` entry to guarantee that a flight ID maps to only one route.

`route_status` refreshes the route entry whenever it is used but does not refresh the uniqueness index. The index can therefore expire while the original route remains active. A later normal whitelist operation can add another route using the same flight ID, causing both routes to share downstream pool and oracle state keyed only by `(flight_id, date)`.

**Root Cause**

The uniqueness check depends on `FlightRoute`:

```rust
// contracts/governance_module/src/routes.rs
let fr_key = DataKey::FlightRoute(flight_id.clone());
if let Some((existing_origin, existing_dest)) =
    e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key)
{
    if !(existing_origin == origin && existing_dest == dest) {
        panic_with_error!(e, Error::FlightIdAlreadyMapped);
    }
}
```

Both entries receive TTL when initially written:

```rust
e.storage().persistent().set(&key, &terms);
extend_route_ttl(e, &key);

e.storage()
    .persistent()
    .set(&fr_key, &(origin.clone(), dest.clone()));
extend_route_ttl(e, &fr_key);
```

However, subsequent route usage refreshes only the route entry:

```rust
// contracts/governance_module/src/queries.rs
extend_route_ttl(e, &key);
```

The storage documentation confirms that downstream state omits origin and destination:

```rust
// contracts/governance_module/src/storage.rs
// pool/oracle state is keyed only by (flight_id, date), so two approved
// routes sharing a flight_id but differing in origin/dest would collide.
```

**Impact**

A later ordinary governance operation can create two active routes sharing a flight ID. Purchases, oracle data, settlement status, collateral, and payouts can then be attributed to the wrong physical route.

Removing either colliding route also removes the shared uniqueness entry, allowing further collisions.

**Failure Scenario**

1. Governance whitelists route A for flight ID `F`.
2. Purchases keep route A active and refresh its route entry.
3. The separate `FlightRoute(F)` entry expires.
4. Governance later whitelists route B using flight ID `F`.
5. The uniqueness check sees no index and accepts route B.
6. Routes A and B now collide in downstream `(flight_id, date)` state.

**Recommended Fix**

Refresh `FlightRoute(flight_id)` whenever the corresponding route is read or mutated. Prefer storing the route and uniqueness ownership atomically or validating both entries through a shared helper.

Removal should delete the uniqueness entry only after verifying that it belongs to the exact route being removed.

---

### [M-03] Solvency ratio is not enforced across aggregate liabilities

| Field | Value |
|---|---|
| Severity | Medium |
| Location | `controller::buy_insurance` |
| Root Cause | Each purchase compares current free capital against the new policy's ratio-adjusted payoff instead of applying the configured ratio to aggregate locked capital plus the new payoff. |

**Summary**

The solvency check calculates `new_payoff × solvency_ratio` and compares it with current free capital. Because free capital already excludes previous liabilities, repeated purchases can progressively reduce total collateralization toward the vault's 100% hard floor regardless of a higher configured ratio.

**Root Cause**

```rust
// contracts/controller/src/purchase.rs
let free_capital = vault.get_free_capital();
let required = terms
    .payoff
    .checked_mul(solvency_ratio as i128)
    .expect("multiplication overflow")
    .checked_div(100)
    .expect("division by zero");

if free_capital < required {
    panic_with_error!(e, Error::InsufficientVaultCapital);
}

vault.increase_locked(&controller_addr, &terms.payoff);
```

Free capital is:

```rust
// contracts/risk_vault/src/queries.rs
let tma = Self::get_total_managed_assets(e);
let locked = Self::get_locked_capital(e);
tma.checked_sub(locked).expect("subtraction underflow")
```

The comparison therefore applies the configured ratio only to the latest policy.

**Impact**

With TMA of 1,000 and a 200% solvency ratio, nineteen sequential policies with payoff 50 each pass:

```text
locked liabilities = 950
aggregate collateralization = 1,000 / 950 = 105.3%
configured target = 200%
```

The vault remains nominally 100% collateralized, but the intended safety margin is almost completely bypassed. This materially increases the risk of insolvency from accounting errors, operational costs, or any non-policy liability.

**Recommended Fix**

Apply the ratio to aggregate liabilities using checked arithmetic and upward rounding:

```text
required_tma = ceil((locked_capital + new_payoff) × solvency_ratio / 100)
require(total_managed_assets >= required_tma)
```

Add sequence tests proving that aggregate collateralization never falls below the configured ratio after multiple purchases.

## Findings Summary

| ID | Severity | Title |
|---|---|---|
| H-01 | High | Claimable liabilities inflate remaining shares and enable theft from later depositors |
| M-01 | Medium | Missing nested authorization prevents on-time settlement |
| M-02 | Medium | Route uniqueness index expires independently from the active route |
| M-03 | Medium | Solvency ratio is not enforced across aggregate liabilities |

## Leads

- **Withdrawal queue can grow beyond effective batching** — `risk_vault::process_withdrawal_queue` processes at most 50 entries but still iterates over and reconstructs the complete queue. A sufficiently large queue may exceed Soroban resource or storage-entry limits and block withdrawals. The candidate was downgraded because no concrete failure threshold was demonstrated, and every request requires owned shares redeemable for a positive asset amount.

## Rejected Candidates

- **Buyer TTL expires before claim completion** — rejected because the enforced 90-day booking horizon plus the 60-day claim period remains within the configured 180-day Buyer TTL.
- **FlightData TTL blocks long-horizon settlement** — the mismatch exists, but key-level FlightData extension is explicitly documented as deferred and outside the current executor phase.

## Methodology

The review used seven independent specialist passes:

1. Access Control and Execution Flow
2. Deep Business Logic
3. Economic Security and Invariants
4. Math and Precision
5. Soroban Attack-Vector Pattern Scan
6. Periphery and First-Principles Analysis
7. State Machine and Integration Boundaries

Candidates passed through a separate verification gate, documentation-intent review, guard analysis, exploit chaining, and final adversarial refutation. No composite exploit exceeded the severity of H-01.

The High finding was dynamically reproduced with a standalone Cargo test:

```text
cargo test -p risk_vault --test x_ray_poc

running 1 test
test claimable_liabilities_inflate_remaining_shares ... ok

test result: ok. 1 passed; 0 failed
```

The temporary PoC and generated snapshot were removed after verification.

---

## Limitations

This assessment represents a point-in-time review of the specific repository state identified in this report. The assessment does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, or economic risks.

The review was limited to the defined scope and relied on available source code, documentation, tests, and observable contract behavior. Changes made after commit `2adc2f688a61b2bca0ae2a8e468814fae9dfb6d7` were not assessed. External infrastructure, deployment configuration, private operational systems, key management, frontend applications, off-chain services, and third-party dependencies were not comprehensively audited unless directly relevant to validating a reported finding.

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
- Compliance certification
- A substitute for professional security auditing services

Neither the assessment provider, report author(s), AI systems used during analysis, nor any affiliated parties shall be liable for any direct, indirect, incidental, consequential, special, or punitive damages arising from the use of this report or reliance on its contents.
