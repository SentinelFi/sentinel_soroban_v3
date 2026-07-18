# cosminmarian53 Soroban Auditor AI Skills: Sentinel Soroban Findings Report

**Date:** 14 July 2026

---

## Assessment Information

| | |
|---|---|
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-07-14 |
| **Report Version** | v1.1 |
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
| **Git Commit Hash** | `d7e652130b779334a9f9c667f8be3b3d4d0284fa` |
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

The review covered 67 production `.rs` files.

### Out of Scope

The following were explicitly excluded from vulnerability assessment:

- Tests and test-only source files
- Mocks, including `contracts/mock_usdc`
- Fuzz targets as source
- `contracts/integration_tests`
- Generated build artifacts, examples, and Cargo lockfiles

Fuzz and integration-test directories were not treated as production contract code.

---

## Executive Summary

The assessment identified **one validated High severity finding** in the scoped production contracts.

The surviving issue is an oracle-latency stale-NAV exploit in the RiskVault settlement barrier. The vault blocks LP entry and exit only when the OracleAggregator's on-chain `PendingOutcomes` counter is non-zero. The protocol documentation promises the barrier once a flight outcome is publicly known but not yet settled, but the production executor writes outcomes only on a two-hour cadence. During that gap, a flight result can be public off-chain while `PendingOutcomes` remains zero on-chain, allowing outcome-informed LPs to deposit, mint, withdraw, or redeem at a stale share price.

The finding survived source-line review, documentation-intent review, guard review, economic validation, and a temporary Soroban integration proof-of-concept. The PoC demonstrated both directions of the stale-price trade:

- an informed LP redeemed before a known cancellation was posted and shifted **20.0000000 USDC** of a single-flight loss to the remaining LP in the test setup;
- an informed newcomer deposited before a known on-time result was posted and captured about **5.0000000 USDC** of premium income that should have accrued to the incumbent LP.

The review examined the principal value-moving and lifecycle surfaces:

- Controller policy purchases and settlement orchestration
- Oracle flight registration, sale authorization, outcome publication, and settlement state
- RiskVault deposits, queued withdrawals, capital accounting, snapshots, and claims funding
- FlightPoolManager policy ownership, settlement, claim windows, claims, and bucket lifecycle
- Governance routes, privileged administration, upgrades, and cross-contract caller validation
- Active-set indexing, recovery, removal, and TTL-dependent state behavior

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 |
| Medium | 0 |
| Low | 0 |
| Leads | 0 |

### Overall Risk Rating

**High**

The validated issue permits conditional but material value transfer between LPs under realistic oracle timing conditions. No additional Critical, High, Medium, or Low severity finding survived source-line verification, guard-map review, documentation-intent review, severity classification, and adversarial refutation.

---

## Findings

### [H-01] Oracle reporting latency permits outcome-informed LPs to trade at stale NAV

| Field | Value |
|---|---|
| **Severity** | High |
| **Location** | `risk_vault::auth::settlement_pending` ([auth.rs:L27](../contracts/risk_vault/src/auth.rs#L27)); `RiskVault::deposit` ([vault_ops.rs:L107](../contracts/risk_vault/src/vault_ops.rs#L107)); `RiskVault::mint` ([vault_ops.rs:L177](../contracts/risk_vault/src/vault_ops.rs#L177)); `RiskVault::redeem` ([vault_ops.rs:L199](../contracts/risk_vault/src/vault_ops.rs#L199)); `OracleAggregator::set_landed` ([lifecycle.rs:L181](../contracts/oracle_aggregator/src/lifecycle.rs#L181)); `OracleAggregator::set_cancelled` ([lifecycle.rs:L229](../contracts/oracle_aggregator/src/lifecycle.rs#L229)) |
| **Root Cause** | The vault treats an outcome as "public" only after the delayed oracle transaction increments `PendingOutcomes`, so immediate LP entry and exit stay open during the external outcome-publication window. |

**Summary**

RiskVault share pricing depends on `TotalManagedAssets`, which is updated only when the controller settles a flight outcome. The intended protection is a settlement barrier that blocks deposits, mints, withdrawals, and redeems while a known outcome has not yet been settled. That barrier is keyed only to the oracle's on-chain `PendingOutcomes` counter, so it does not activate until the two-hour FlightDataFetcher posts the outcome on-chain.

If a cancellation, delay, or on-time result is publicly knowable before the oracle transaction lands, informed LPs can transact against the stale pre-outcome NAV. They avoid their share of known losses by exiting early, or capture known premium income by entering before an on-time settlement.

**Root Cause**

The vault barrier reads only the oracle's on-chain pending counter:

```rust
// contracts/risk_vault/src/auth.rs:L27-L33
pub(crate) fn settlement_pending(e: &Env) -> bool {
    let oracle: Address = e
        .storage()
        .instance()
        .get(&VaultKey::Oracle)
        .expect("oracle not set");
    OracleClient::new(e, &oracle).has_pending_outcomes()
}
```

All immediate LP entry and exit paths rely on that check before pricing shares:

```rust
// contracts/risk_vault/src/vault_ops.rs:L107-L114
fn deposit(e: &Env, assets: i128, receiver: Address, from: Address, operator: Address) -> i128 {
    Self::extend_ttl(e);
    operator.require_auth();
    assert_no_settlement_pending(e);
    ...
    let shares = managed_convert_to_shares(e, assets, Rounding::Floor);
```

```rust
// contracts/risk_vault/src/vault_ops.rs:L199-L213
fn redeem(e: &Env, shares: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
    Self::extend_ttl(e);
    operator.require_auth();
    assert_no_settlement_pending(e);
    ...
    let assets = managed_convert_to_assets(e, shares, Rounding::Floor);
```

However, `PendingOutcomes` is incremented only when the authorized oracle posts the outcome on-chain:

```rust
// contracts/oracle_aggregator/src/lifecycle.rs:L181-L189
data.status = FlightStatus::Landed;
data.actual_arrival_time = actual_arrival_time;
e.storage().persistent().set(&key, &data);
...
increment_pending_outcomes(e);
```

```rust
// contracts/oracle_aggregator/src/lifecycle.rs:L229-L235
data.status = FlightStatus::Cancelled;
e.storage().persistent().set(&key, &data);
...
increment_pending_outcomes(e);
```

The executor cadence creates the exploitable gap. The architecture specifies FlightDataFetcher every two hours, and the implementation schedules it accordingly:

```ts
// executor/centralized_cron/src/index.ts:L43-L46
// Cron #1 - FlightDataFetcher - oracle key - every 2 hours at :00
cron.schedule("0 */2 * * *", async () => {
  ...
});
```

This contradicts the documented settlement-barrier intent. The docs state that once a flight outcome is publicly known but not yet settled, deposits and withdrawals are blocked to prevent stale-price front-running ([solvency-and-safety.md:L32](../docs/docs/concepts/solvency-and-safety.md#L32), [provide-liquidity.md:L44](../docs/docs/guides/provide-liquidity.md#L44), [risk-vault.md:L39](../docs/docs/contracts/risk-vault.md#L39)).

**Impact**

The loss is a direct transfer between LPs and scales with the unrecognized flight PnL and the attacker's share of vault ownership or deposit size.

For the loss-avoidance path, with two LPs each holding 1,000 USDC of vault shares and one cancellation with `PAYOFF = 50` and `PREMIUM = 10`, the pending vault loss is 40 USDC. In the control run, each LP bears half of that loss and is worth 980 USDC after settlement. In the attack run, the informed LP redeems for 1,000 USDC before the oracle writes the cancellation, then settlement leaves the passive LP with 960 USDC. The attacker extracts 20 USDC from the passive LP for one flight.

For the gain-capture path, if a 10 USDC premium from a known on-time result is not yet posted, a newcomer depositing 1,000 USDC before the oracle write is minted at stale NAV and captures about 5 USDC of premium income that should have belonged to the incumbent LP.

The attack is repeatable across outcome windows and is bounded by available free capital, incoming LP capital, and unrecognized PnL size. The guard `operator.require_auth()` does not refute the issue because the attacker is a legitimate LP or depositor using intended vault functions. The reserve cap also does not refute it because it protects solvency, not fair value between informed and passive LPs.

**Exploit Scenario**

1. A flight has active policies and locked vault capital.
2. The flight result becomes public through the airline, AeroAPI, airport feeds, or other public data before Sentinel's FlightDataFetcher posts the result on-chain.
3. `OracleAggregator.has_pending_outcomes()` still returns false because `set_landed` or `set_cancelled` has not executed yet.
4. If the result is delayed or cancelled, an informed LP calls `RiskVault::redeem` or `RiskVault::withdraw` and exits at the pre-loss NAV.
5. If the result is on time, an informed LP calls `RiskVault::deposit` or `RiskVault::mint` and receives shares at the pre-premium NAV.
6. The oracle later posts the result, the controller settles, and the remaining or incumbent LPs absorb the loss or share the gain with the informed trader.

**Validation**

A temporary integration PoC was added and then removed from `contracts/integration_tests/src/tests/x_ray_poc.rs`. The targeted command passed:

```bash
cargo test -p integration_tests x_ray_oracle_latency -- --nocapture
```

The PoC asserted that `OracleAggregator.has_pending_outcomes()` was false in the off-chain-known/on-chain-unposted window, that immediate vault entry or exit succeeded, and that the resulting value transfer matched the stale-NAV economic model.

**Recommended Fix**

Do not rely on the oracle's posted `PendingOutcomes` counter as the sole freshness signal for immediate LP entry and exit. Move immediate deposits, mints, withdrawals, and redeems to an epoch/queue model whose effective price is finalized only after a delay greater than the maximum oracle reporting and settlement window.

At minimum, direct LP operations should enqueue intent and execute only after the oracle freshness window has passed and `has_pending_outcomes()` is still false at execution time:

```diff
- operator.require_auth();
- assert_no_settlement_pending(e);
- let shares = managed_convert_to_shares(e, assets, Rounding::Floor);
- Vault::deposit_internal(e, &receiver, assets, shares, &from, &operator);
+ operator.require_auth();
+ enqueue_deposit_intent(e, assets, receiver, from, operator, current_ledger_time(e));
+ // A keeper/finalizer executes after ORACLE_FINALITY_DELAY:
+ //   assert_no_settlement_pending(e);
+ //   assert_oracle_window_finalized(e, queued_at);
+ //   price against the then-current, post-outcome NAV.
```

Apply the same delayed-pricing rule to `mint`, `withdraw`, `redeem`, and withdrawal-queue processing. Reducing the cron interval lowers the window but does not remove the race; cancellations and delay outcomes can still be public before the oracle transaction is submitted and finalized.

---

## Leads

No leads survived the independent verification gate.

---

## Findings Summary

| ID | Severity | Title |
|---|---|---|
| H-01 | High | Oracle reporting latency permits outcome-informed LPs to trade at stale NAV |

---

## Methodology Notes

The Soroban Auditor v1.4.0 workflow generated authorization-guard, state-flag, cross-contract integration, math/precision, unsafe-memory, oracle, flash-flow, divergence, invariant, and documentation-intent maps for the scoped production files. Tests, mocks, fuzz targets as source, and `contracts/integration_tests` were excluded from every production-source bundle.

Six specialist passes covered math/precision, access/flow, economic invariants, periphery false positives, state/integration, and deep business logic. Candidate output was subjected to verification that re-read the relevant vault, oracle, controller, documentation, and executor code paths; checked authorization and reserve guards; and compared the behavior with documented intent.

The stale-NAV oracle-latency candidate survived verification and was promoted to a High finding after dynamic Soroban proof-of-concept testing. No additional candidate survived validation as a reportable issue.

Targeted validation command:

```bash
cargo test -p integration_tests x_ray_oracle_latency -- --nocapture
```

Result: 2 passed, 0 failed. The temporary PoC files and generated snapshots were removed after validation, leaving only this report updated.

---

# Limitations

This assessment represents a point-in-time review of the specified repository
state. It does not guarantee the absence of vulnerabilities, defects, design
weaknesses, implementation errors, economic risks, or integration failures.
Runtime archival and restoration behavior should continue to be validated
against the target Stellar/Soroban network version and operational tooling.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness,
accuracy, reliability, suitability, or correctness of these assessment results.
The absence of reported findings does not imply the absence of vulnerabilities,
defects, security weaknesses, or exploitable conditions. This assessment should
not be relied upon as the sole basis for security, investment, deployment,
governance, operational, or business decisions.

This assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial or investment advice;
- compliance certification;
- a substitute for professional security auditing services.

