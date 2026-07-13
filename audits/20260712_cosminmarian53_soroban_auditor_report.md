# cosminmarian53 Soroban Auditor AI Skills: Sentinel Soroban Findings Report

**Date:** 12 July 2026

---

## Assessment Information

| | |
|---|---|
| **Project Name** | Sentinel Protocol |
| **Network** | Stellar |
| **Smart Contract Platform** | Soroban |
| **Programming Language** | Rust |
| **Assessment Date(s)** | 2026-07-12 |
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
| **Git Commit Hash** | `fcde5aae26fe91cd53558905d390e0918aa53a59` |
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

The assessment identified **no validated security findings** in the scoped production contracts.

The 12 July 2026 reassessment ran all six Soroban Auditor specialist perspectives against the same 67-file production scope. The math/precision, access/flow, economic/invariant, periphery, state/integration, and deep-logic passes submitted no candidate findings or leads. The verification gate therefore had no candidates to promote or reject, and the exploit-chaining and defender gates confirmed an empty new-candidate set.

The review re-checked the main value-moving and lifecycle surfaces:

- Controller purchases require traveler authorization, day-aligned dates, live oracle sale authorization, locked per-flight terms, and aggregate vault solvency.
- Oracle outcome transitions are oracle/controller gated and track pending public outcomes until settlement completes.
- RiskVault direct entry and exit paths block while settlement is pending, and queued withdrawals price against running managed assets.
- FlightPoolManager claim paths enforce policy ownership, claim windows, settlement status, and double-claim protection.
- Active-set recovery paths retain missing-flight entries for restoration or owner-confirmed eviction rather than pruning them permissionlessly.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Leads | 1 |

### Overall Risk Rating

**No validated issue found**

No Critical, High, Medium, or Low severity finding survived source-line verification, guard-map review, documentation-intent review, and adversarial refutation.

---

## Findings

No validated findings.

---

## Leads

No new leads were produced by the reassessment. The following trail is retained from the original review as an unscored hardening note because its exploit path was incomplete and an existing fail-closed gate materially refutes practical reachability.

### Active-set append only checks the reverse index before adding

| Field | Value |
|---|---|
| Status | Downgraded Lead |
| Location | `sentinel_types::active_set::add` |
| Reason | The append backstop checks `ActiveIdx` directly but does not call the exact `contains` fallback; however, a concrete path to duplicate insertion requires a narrow TTL split plus a live sale authorization, and purchase gating fails closed when the sale authorization is absent or archived. |

`sentinel_types::active_set::add` rejects duplicate entries when the reverse index exists, but it does not scan the live pages when the reverse index has archived:

```rust
if e.storage()
    .persistent()
    .has(&ActiveSetKey::ActiveIdx(flight_id.clone(), date))
{
    panic!("entry already in active set");
}
```

The more exact membership helper, `active_set::contains`, falls back to a page scan when `ActiveIdx` is missing, and removal uses a similar scan fallback. The append path instead relies on callers gating registration through their own persistent flight entries.

The candidate duplicate scenario would require:

1. An active-set page remains live and still contains `(flight_id, date)`.
2. The corresponding `ActiveIdx` and oracle `FlightData` entry archive or are otherwise absent.
3. A new purchase for the same `(flight_id, date)` reaches `oracle.register_flight`, causing a second append.

That path was not promoted because the controller now requires a fresh oracle sale authorization before purchase:

```rust
if !oracle.is_sale_open(&flight_id, &date) {
    panic_with_error!(e, Error::SaleNotOpen);
}
```

`is_sale_open` uses temporary storage and fails closed when the sale authorization is absent, expired, or archived. For already-registered pool buckets, the controller also requires the oracle `FlightData` row to physically exist before allowing another purchase. Because the candidate depends on a missing oracle row while preserving a live sale authorization and active page, impact remains unproven.

Recommended hardening, if desired: change `active_set::add` to call `contains(e, flight_id, date)` instead of checking only `ActiveIdx`, or scan pages on missing `ActiveIdx` before appending. This would make the active-set backstop symmetric with `contains` and `remove`.

---

## Findings Summary

| ID | Severity | Title |
|---|---|---|
| - | - | No validated findings |

---

## Methodology Notes

The Soroban Auditor v1.4.0 workflow generated guard, state-flag, integration, math, unsafe, oracle, flash-flow, divergence, invariant, and documentation-intent maps for the scoped production files. Tests, mocks, fuzz targets as source, and `contracts/integration_tests` were excluded from every production-source bundle. Six specialty passes covered math/precision, access/flow, economic invariants, periphery false positives, state/integration, and deep logic. All six completed with no candidate findings or leads. A separate verification gate confirmed the empty candidate set, the exploit chainer produced no composite chains, and the defender had no surviving items to refute.

---

## Limitations

This assessment represents a point-in-time review of the repository state identified in this report. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, or economic risks.

The review was limited to the defined production-contract scope and relied on available source code, documentation, tests, and observable contract behavior. External infrastructure, deployment configuration, private operational systems, key management, frontend applications, off-chain services, and third-party dependencies were not comprehensively audited unless directly relevant to validating a reported finding.

AI-assisted analysis can produce incomplete or incorrect conclusions. Findings were subjected to verification and adversarial refutation within the assessment workflow, but this process is not a substitute for manual expert review, formal verification, comprehensive testing, or continuous production monitoring.

---

## Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of the assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

The assessment does not constitute:

- A formal security certification
- A guarantee of security
- Legal advice
- Financial advice
- Investment advice
