# Nemesis AI Auditor: Sentinel Protocol Security Assessment

**Date:** 12 July 2026

This report presents the verified Nemesis AI Auditor results for the Sentinel
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
| **Assessment Date(s)** | 2026-07-12 |
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
| **Git Commit Hash** | `fcde5aae26fe91cd53558905d390e0918aa53a59` |
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

The assessment covered 67 production Rust files, approximately 7,022 lines,
and the public or trait entrypoints exposed by the in-scope contracts.

### Out of Scope

- `contracts/mock_usdc`
- Mock contracts and mock infrastructure
- Unit-test files and `#[cfg(test)]` modules
- `contracts/integration_tests`
- Fuzz targets and generated `target` output
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

The assessment identified **two verified open Medium-severity findings** in
the in-scope production Soroban contracts. Both are cross-contract invariant
gaps that survived the Nemesis verification gate and were reproduced with
native Soroban tests:

- the configured solvency ratio is enforced when policies increase locked
  liabilities, but vault withdrawal paths preserve only nominal 100% backing;
- governance term limits validate the route's current terms, but an existing
  pool bucket's older terms replace them after validation and are not checked
  against the current limits.

The review specifically re-checked the two Medium-severity findings from the
11 July 2026 Nemesis report. Both are materially remediated in this snapshot:

- active-flight storage is now backed by `sentinel_types::active_set`, a
  paginated persistent set with reverse indexes and 100,000-entry operational
  caps, replacing the prior 1,000-entry monolithic active-list limit;
- RiskVault withdrawal queue processing now partially fills an oversized head
  request from available free capital, preventing a large head request from
  pinning all later exits while preserving FIFO priority.

The active-list and strict-FIFO queue findings from the prior report remain
remediated. The two findings below are new Nemesis cross-feed discoveries.

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| NM-001 | Medium | Vault exits can remove the configured solvency reserve | Collateralization can fall from the configured ratio to 100% |
| NM-002 | Medium | Cached flight terms bypass newly lowered governance limits | New policies can retain payoff terms above the current owner-set cap |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 0 | 0 |

### Overall Risk Rating

**Medium**

The reviewed snapshot shows substantial hardening across prior attack surfaces:
sale authorization, pending-outcome settlement barriers, TMA-basis share
pricing, aggregate solvency checks, paginated active-flight sets, strict route
identity controls, and queue progress under partial liquidity.

---

## Methodology

Nemesis used an alternating, feedback-driven audit process:

1. A Feynman business-logic pass questioned purpose, ordering, assumptions,
   boundaries, error paths, and multi-transaction behavior across in-scope
   entrypoints.
2. A state-inconsistency pass mapped coupled state, mutation paths, parallel
   operations, and missing counterpart updates.
3. State gaps were fed back into targeted Feynman interrogation to identify
   underlying assumptions and adversarial transaction sequences.
4. New root causes were fed into targeted state re-analysis.
5. The targeted feedback pass reproduced both remaining gaps and then
   converged without additional verified findings.

The assessment specifically examined:

- authorization and cross-contract invocation boundaries;
- route identity, route retirement, default-term mutation, and route-index TTL
  self-healing;
- oracle sale authorization, cancellation tombstones, outcome state, pending
  outcome accounting, and owner eviction reconciliation;
- active-list pagination, reverse-index removal, cursor iteration, and TTL
  degradation behavior;
- controller purchase ordering, premium transfer, collateral locking, and
  aggregate solvency enforcement;
- pool settlement, claim windows, buyer proof lifetime, claims, sweeps, and
  recovered-balance accounting;
- vault deposits, direct exits, queued exits, partial queue fills, claimable
  liabilities, recovery paths, and snapshot pricing;
- defensive code that could mask broken invariants.

Every Critical, High, and Medium hypothesis was verified by code trace, native
tests, or both. Hypotheses relying on trusted owner/key compromise, explicit
owner misconfiguration, or contradicted current Soroban transaction atomicity
were excluded.

---

# Detailed Findings

## [NM-001] Vault exits can remove the configured solvency reserve

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Source** | Feynman guard-consistency question → State mutation cross-check |
| **Affected components** | Controller purchase solvency check; RiskVault direct and queued exits |
| **Verification** | Hybrid code trace and native Soroban PoC |

### Coupled state and invariant

`TotalManagedAssets`, `LockedCapital`, and the Controller's `SolvencyRatio`
jointly define the protocol's configured collateralization. After a ratio is
selected, the intended invariant is:

```text
TMA >= ceil(LockedCapital * SolvencyRatio / 100)
```

The purchase path enforces that relationship when liabilities grow at
`contracts/controller/src/purchase.rs:173-197`. The vault does not enforce it
when assets leave. `RiskVault::get_free_capital` returns only
`TMA - LockedCapital` at `contracts/risk_vault/src/queries.rs:24-28`, treating
every asset above nominal payoff liabilities as withdrawable.

That weaker value gates all relevant exit paths:

- direct `withdraw` at `contracts/risk_vault/src/vault_ops.rs:132-167`;
- direct `redeem` at `contracts/risk_vault/src/vault_ops.rs:192-225`;
- `max_withdraw` and `max_redeem` at
  `contracts/risk_vault/src/vault_ops.rs:292-313`;
- queued withdrawal processing at
  `contracts/risk_vault/src/capital.rs:107-312`.

### Feynman question

> Why is the solvency-ratio guard present when `LockedCapital` increases but
> absent from every sibling operation that decreases `TotalManagedAssets`?

### State Mapper gap

| Mutation path | TMA | Locked capital | Ratio reserve enforced |
| --- | ---: | ---: | --- |
| Policy purchase | unchanged | increases | Yes |
| Direct withdraw/redeem | decreases | unchanged | No |
| Queue processing | decreases | unchanged | No |

### Trigger sequence

1. Underwriters deposit 1,000 assets.
2. The owner configures a 200% solvency ratio.
3. Policies accumulate 500 of aggregate payoff liability. The purchase check
   passes exactly because `1,000 >= 500 * 200%`.
4. The vault reports 500 of free capital (`1,000 - 500`).
5. An LP withdraws 500 directly, or receives the same value through the queue.
6. Final state is `TMA = 500`, `LockedCapital = 500`: nominal liabilities are
   still backed, but the configured 200% reserve has collapsed to 100%.

### Impact

Any LP holding sufficient shares can permissionlessly remove the full safety
margin above nominal liabilities before an outcome becomes public. The vault
does not become immediately undercollateralized below 100%, so the issue is not
High severity, but the owner-configured reserve policy is ineffective across
ordinary exit state transitions.

### Verification evidence

A temporary native test created ten 50-asset liabilities against 1,000 TMA at
a 200% ratio, then successfully withdrew 500 assets. It observed
`TMA == LockedCapital == 500` after the withdrawal. The test
`audit_poc_solvent_ratio_margin_can_be_withdrawn` passed.

### Recommendation

Define one canonical required-backing calculation and use it for policy
admission and every exit path:

```text
required_backing = ceil(LockedCapital * SolvencyRatio / 100)
withdrawable = max(TMA - required_backing, 0)
```

Make the applicable ratio or required reserve available to RiskVault, and use
the derived amount in direct exits, queue processing, and the `max_*` views.
Add invariant tests covering purchases, direct exits, queued exits, ratio
changes, and settlement releases.

---

## [NM-002] Cached flight terms bypass newly lowered governance limits

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Source** | State authorization gap → targeted Feynman re-interrogation |
| **Affected components** | Governance term limits; Controller purchase term selection; FlightPoolManager snapshots |
| **Verification** | Hybrid code trace and native Soroban PoC |

### Coupled state and invariant

Current governance limits are intended to control whether new exposure may be
sold, while a pool `FlightConfig` snapshot preserves the economic terms owed to
already admitted buyers. Existing policies may retain old terms, but every new
sale must satisfy the current owner-set limits.

`GovernanceModule::route_status` correctly returns `Disabled` when current
resolved route terms exceed the current limits at
`contracts/governance_module/src/queries.rs:88-99`. In
`Controller::buy_insurance`, however, those validated terms are later replaced
with an existing pool bucket's snapshot at
`contracts/controller/src/purchase.rs:129-158`. The final selected premium and
payoff are never revalidated against `MaxPayoff` or `MaxPayoffRatio`.

`FlightPoolManager::register_flight` only checks that the snapshot matches the
stored bucket and that payoff is positive and exceeds premium at
`contracts/flight_pool_manager/src/lifecycle.rs:32-70`; it has no access to the
current governance limits.

### Feynman question

> Why does the Controller validate one set of terms for authorization, replace
> it with a different set for payment and liability creation, and never repeat
> the security-policy check on the terms it actually uses?

### State Mapper gap

| Coupled state | Current route | Existing pool snapshot | New-sale decision |
| --- | --- | --- | --- |
| Owner term limits | Checked | Not checked | Snapshot wins |
| Price consistency within a flight bucket | May change | Preserved | Snapshot wins |

### Trigger sequence

1. While limits are permissive, a route uses premium 10 and payoff 50, and the
   first buyer registers a future flight bucket with those terms.
2. The owner lowers `max_payoff` to 20. The old route terms are no longer
   eligible for new exposure.
3. The route is updated to compliant current terms: premium 10, payoff 20.
   `route_status` is `Active` again.
4. A second buyer purchases the already registered flight date.
5. The Controller validates the compliant current route, substitutes the pool
   snapshot, collects premium 10, and locks payoff 50, above the current cap.

### Impact

Lowering governance limits cannot reliably stop new exposure on an existing
flight bucket. A pre-existing oversized snapshot can continue admitting buyers
until sale authorization or vault solvency stops it. The prerequisite bucket,
live oracle sale authorization, and available vault capital make exploitation
conditional, supporting Medium severity.

### Verification evidence

A temporary native test registered a bucket at payoff 50, lowered the cap to
20, updated the current route to payoff 20, and successfully added a second
buyer. The stored bucket remained at payoff 50 with `buyer_count == 2`. The
test `audit_poc_cached_terms_bypass_lowered_governance_cap` passed.

### Recommendation

Validate the final terms selected by `buy_insurance` after any pool-snapshot
substitution. Expose a governance check for arbitrary resolved terms, return
the current limits and apply identical checked validation in the Controller,
or version route authorization and close snapshots invalidated for future
sales. Preserve old terms for existing policy settlement, but reject new
buyers while the snapshot exceeds current limits.

---

## Fixed or Not Reproduced from Prior Reports

The following previously material issues were checked against the assessed
snapshot and were not reported as open findings:

- Global active-flight capacity limit: remediated by
  `sentinel_types::active_set` paginated pages, reverse indexes, count
  metadata, paged reads, and 100,000-entry sanity caps in both OracleAggregator
  and FlightPoolManager.
- Strict-FIFO withdrawal queue pinning: remediated by partial fill logic in
  `RiskVault::process_withdrawal_queue`, which burns the fillable share slice,
  credits claimable assets, and keeps the remainder at the head.
- Public outcome stale pricing: `PendingOutcomes` blocks LP entry, direct exit,
  queue processing, and snapshots while public outcome PnL is unsettled.
- Snapshot pricing on raw physical balance: snapshots use
  `RiskVault::get_total_managed_assets`, matching executable share conversion
  basis and excluding uncollected claimable liabilities.
- Route flight-id drift: `FlightRoute` index healing, stale-duplicate rejection,
  and removed-route retirement markers prevent downstream `(flight_id, date)`
  bucket collisions from normal untrusted paths.
- Claimable liability over-credit recovery: `recover_uncollected` now rejects
  underpaying recredits and bounds recredits by asset surplus over TMA.
- Missing-flight eviction pending-counter dead end: `evict_missing_flight`
  accepts an audited `outcome_pending` flag and decrements `PendingOutcomes`
  when the evicted row was counted, while `Controller::settle_evicted_flight`
  releases pool premiums and vault collateral.

---

## Positive Security Properties

The review confirmed the following material protections:

- Purchases require day-aligned dates, bounded lead time, bounded booking
  horizon, active route terms, live oracle sale authorization, and pre-outcome
  oracle status.
- First purchase snapshots route terms into FlightPoolManager, and later buyers
  of the same `(flight_id, date)` use those locked terms instead of mutable
  current governance defaults.
- Aggregate solvency is checked against existing locked capital plus the new
  payoff, with the configured ratio applied to total liabilities.
- Public outcomes and void classifications increment `PendingOutcomes`; final
  oracle settlement decrements it.
- Queue processing is disabled while pending outcomes exist, and direct exits
  are disabled while the queue is non-empty.
- Oversized queue-head requests are partially filled when free capital can fund
  at least one share, preserving FIFO while ensuring available liquidity makes
  progress.
- Claim windows are capped to the buyer-proof lifetime, and claims remain
  callable while the pool is paused so emergency pauses cannot silently expire
  already-funded traveler payouts.
- Active-flight enumeration is paginated and bounded for keeper calls, with
  reverse-indexed swap removal and diagnostics for missing pages or data.
- Owner eviction of missing oracle rows is separated from controller-side
  settlement of the corresponding pool bucket and vault collateral release.

---

## Conclusion

The assessed snapshot materially improves on the 11 July 2026 baseline, and
the previous active-list capacity and withdrawal-queue liveness findings are
remediated. Two Medium cross-contract invariant gaps remain: vault exits do not
preserve the configured solvency margin, and cached pool terms can bypass
newly lowered governance limits for new buyers.

Remediating both findings requires enforcing the same security policy on every
state transition, not only on the state-creation path. Residual operational
risk also remains around keeper liveness, TTL restoration, owner runbooks for
rare eviction/recovery paths, and active-list and withdrawal-queue occupancy.

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
