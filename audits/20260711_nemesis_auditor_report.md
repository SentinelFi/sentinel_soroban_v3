# Nemesis AI Auditor: Sentinel Protocol Security Assessment

**Date:** 11 July 2026

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
| **Assessment Date(s)** | 2026-07-11 |
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
| **Git Commit Hash** | `cdac8a8bf33e80dc4a1308642dc65978becbddfb` |
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

The assessment covered 66 production Rust files, approximately 6,172 lines,
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

The assessment identified two verified Medium-severity findings.

The first finding is the remaining active-flight capacity ceiling. Oracle
Aggregator and Flight Pool Manager still store active flights in capped
single-entry vectors. When either vector reaches 1,000 entries, first purchases
for new flights fail protocol-wide until entries are settled, pruned, or
manually evicted.

The second finding affects underwriter exit liveness. RiskVault uses a single
strict-FIFO withdrawal queue and disables all direct exits while the queue is
non-empty. A large head request that exceeds current free capital blocks all
later requests, even if later requests are small enough to be serviced from the
available free capital.

The prior High-severity stale-share-price issue is materially remediated in
this snapshot: OracleAggregator tracks pending public outcomes, and RiskVault
blocks deposits, mints, direct exits, queue processing, and snapshots while a
public outcome remains financially unsettled. The prior snapshot pricing issue
is also remediated by pricing snapshots on Total Managed Assets.

### Findings Summary

| ID | Severity | Title | Primary Impact |
| --- | --- | --- | --- |
| NM-001 | Medium | Global active-flight list caps can halt new policy admission | Protocol-wide first-purchase denial |
| NM-002 | Medium | Large head withdrawal requests can pin all underwriter exits | Exit liveness degradation and queue griefing |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 0 | 0 |

### Overall Risk Rating

**Medium**

The assessed snapshot removes the most serious stale-PnL LP extraction risk
from the 4 July report. The remaining risks are availability and liveness
issues caused by global single-vector queues/lists. They should be addressed
before sustained production flight volume or material underwriter capital.

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
5. The process converged after four passes with no new verified findings in
   the final pass.

The assessment specifically examined:

- authorization and cross-contract invocation boundaries;
- route identity, term resolution, and policy registration;
- oracle outcome state, pending-outcome accounting, and settlement barriers;
- collateral locking and release across settlement outcomes;
- pool settlement, claim, sweep, and recovered-balance accounting;
- vault deposits, direct exits, withdrawal queue processing, claimable
  liabilities, and snapshot pricing;
- active-list, queue, cursor, and TTL lifecycle behavior;
- defensive code that could mask broken invariants.

Every High and Medium hypothesis was verified by code trace, native tests, or
both. Hypotheses relying on trusted owner/key compromise or contradicted
current Soroban transaction atomicity were excluded.

---

# Detailed Findings

## [NM-001] Global active-flight list caps can halt new policy admission

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | OracleAggregator and FlightPoolManager active-flight storage and registration |
| **Impact** | Protocol-wide denial of first purchases for new flights |
| **Status** | Open |
| **Discovery Path** | State-capacity mapping enriched by Feynman boundary analysis |
| **Verification** | Boundary tests and controller purchase call trace |

### Description

OracleAggregator and FlightPoolManager each store flight keys in a single
instance-storage `Vec<(Symbol, u64)>`. Both vectors are capped at 1,000 entries
to avoid exceeding Soroban contract-data entry limits.

When either list reaches the cap, `register_flight` rejects the next new
flight. Controller's `buy_insurance` path requires successful registration in
both contracts for the first purchase of a `(flight_id, date)`, so either
rejection aborts admission for all new flights.

FlightPoolManager removes entries on settlement. OracleAggregator retains
settled entries for a configured retention period and then depends on
permissionless pruning. Missing archived flight data is intentionally retained
until owner eviction, so stale operational records can also consume capacity.

### Affected Code

- `contracts/oracle_aggregator/src/constants.rs:15-24`
- `contracts/oracle_aggregator/src/lifecycle.rs:174-210`
- `contracts/oracle_aggregator/src/lifecycle.rs:309-395`
- `contracts/flight_pool_manager/src/constants.rs:28-38`
- `contracts/flight_pool_manager/src/lifecycle.rs:88-102`
- `contracts/controller/src/purchase.rs:143-154`

### Broken Invariant

A valid, solvent policy purchase should not depend on unrelated historical or
operational flight records fitting inside one global ledger entry.

### Trigger Scenario

1. The oracle or pool active list accumulates 1,000 entries.
2. A traveler submits a valid first purchase for a new flight.
3. Controller calls `FlightPoolManager::register_flight` and
   `OracleAggregator::register_flight`.
4. The capped contract rejects registration with `ActiveFlightListFull`.
5. The purchase reverts. Subsequent new-flight purchases continue to fail
   until entries are settled, pruned, or manually evicted.

This can happen through ordinary growth, executor downtime, pruning gaps, or
concentrated valid booking volume. It does not require compromise of privileged
keys.

### Verification

The repository's boundary tests were executed against the assessed commit:

| Test | Result |
| --- | --- |
| `oracle_aggregator::test_register_flight_rejects_when_active_list_full` | Passed; contract error 606 |
| `flight_pool_manager::test_register_flight_rejects_when_active_list_full` | Passed; contract error 417 |

The Controller call trace confirms that registration in both contracts is a
mandatory part of every first purchase for a flight.

### Recommendation

Replace each monolithic active-flight vector with scalable keyed or paginated
storage:

- individually keyed active-flight records;
- count and cursor metadata;
- a reverse index for constant-time removal;
- paginated read methods for off-chain consumers;
- bounded keeper scans over pages rather than one global vector;
- a migration path for existing active-list state.

As an interim mitigation, monitor list occupancy, prune aggressively, and run
owner eviction plus `settle_evicted_flight` for confirmed archived records
before capacity becomes operationally unsafe.

---

## [NM-002] Large head withdrawal requests can pin all underwriter exits

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Affected Components** | RiskVault withdrawal queue, direct exits, queue maintenance |
| **Impact** | Underwriter exit liveness degradation and queue griefing |
| **Status** | Open |
| **Discovery Path** | Cross-feed: state queue coupling -> Feynman multi-transaction ordering |
| **Verification** | Current-commit code trace and temporary native PoC |

### Description

RiskVault has three interacting rules:

1. `withdraw` and `redeem` reject while `WithdrawalQueue` is non-empty.
2. `process_withdrawal_queue` is strict FIFO.
3. If the head request's priced asset amount exceeds current free capital, the
   processor keeps the head request, sets `hit_capacity = true`, and preserves
   every later request without evaluating whether those later requests are
   fundable.

A large first request can therefore pin the global exit path while any capital
remains locked. Smaller later requests that could be paid from current free
capital receive no claimable balance, and they cannot use direct redeem because
the non-empty queue globally disables direct exits.

### Affected Code

- `contracts/risk_vault/src/vault_ops.rs:121-128`
- `contracts/risk_vault/src/vault_ops.rs:176-180`
- `contracts/risk_vault/src/claims.rs:38-63`
- `contracts/risk_vault/src/capital.rs:132-171`

### Broken Invariant

If free capital is available, an exit request that fits inside that free
capital should have some bounded path to execution. A single unfundable request
should not globally freeze smaller fundable exits.

### Trigger Scenario

1. Underwriter A deposits a large amount.
2. Policies lock most, but not all, vault capital.
3. A queues a full-position withdrawal whose priced assets exceed current free
   capital.
4. Underwriter B queues a smaller withdrawal whose priced assets are less than
   current free capital.
5. Keeper calls `process_withdrawal_queue`.
6. The head request is kept because it exceeds free capital. The loop then
   keeps every later request without pricing it.
7. B receives no claimable balance and cannot redeem directly because the queue
   is non-empty.

The attacker locks their own shares while pinning the queue, but they do not
need privileged access. They can also fill the bounded queue using multiple
addresses; the existing global cap test confirms the 251st request is rejected
once the 250-slot queue is full.

### Verification

Code trace confirmed:

- direct `withdraw` and `redeem` both reject when `get_withdrawal_queue()` is
  non-empty;
- `request_withdrawal` accepts requests based on share ownership, queue length,
  and request-value floor, but does not cap the request to currently free
  capital;
- `process_withdrawal_queue` stops evaluating later requests after the first
  unfundable request.

A temporary unit PoC was run and removed. It used:

- A deposit of 1,000 assets from the head requester;
- B deposit of 100 assets;
- 1,000 assets locked, leaving 100 free;
- A full-share request queued before B's half-share request.

After processing, the queue still contained both requests, B's claimable
balance was zero, and B's direct redeem attempt reverted because the queue was
active.

Existing test coverage also confirms global queue saturation:

| Test | Result |
| --- | --- |
| `risk_vault::test_withdrawal_queue_global_length_cap` | Passed; 251st request rejected with contract error 716 |

### Recommendation

Choose one queue policy and encode it explicitly:

1. Partial-fill the head request up to available free capital, leaving a
   reduced head request for the remainder.
2. Add a per-request maximum based on current free capital or a configurable
   fraction of TMA.
3. Permit direct exits for the caller's own fundable amount when the queue head
   is unfundable for longer than a bounded delay.
4. Split the queue into pages with per-page progress and a starvation rule for
   repeatedly unfundable head entries.

Any fix should preserve the stale-PnL mitigation: queued requests must still be
priced only after pending public outcomes settle.

---

## Fixed or Not Reproduced from Prior Report

The following previously material issues were checked against the assessed
snapshot and were not reported as open findings:

- Public outcome stale pricing: fixed by `PendingOutcomes` in
  OracleAggregator and RiskVault's settlement barrier. Verified by
  `risk_vault::test_constructor_wires_settlement_barrier`.
- Snapshot pricing on raw physical balance: fixed by using
  `RiskVault::get_total_managed_assets` in `snapshot`. Verified by
  `risk_vault::test_snapshot_uses_managed_assets_not_physical_balance`.
- Route flight-id drift: route/index TTL coupling and healing now reject or
  repair stale ownership paths.
- Claimable liability pricing: executable share conversions use TMA, and
  queue processing decrements TMA when claimable balances are credited.

---

## Positive Security Properties

The review confirmed the following material protections:

- Purchases reject non-day-aligned flight dates and post-outcome oracle states.
- First-purchase route terms are snapshotted by the pool and reused by later
  buyers of the same `(flight_id, date)`.
- Aggregate solvency is checked against existing locked capital plus the new
  payoff.
- Oracle outcome disclosure increments a pending-outcome counter that blocks
  stale vault entry/exit pricing until settlement.
- Queue processing is disabled while pending outcomes exist, so queued exits
  are priced after PnL recognition.
- Snapshot pricing uses managed assets, not raw token balance.
- Claiming remains open during pool pause, so an emergency pause cannot consume
  an already-funded claim window.
- Route removal writes retirement markers to prevent immediate remapping of a
  flight ID while downstream state can still exist.
- Missing oracle data is not permissionlessly pruned; owner eviction is paired
  with a Controller reconciliation path that releases pool and vault state.

---

## Conclusion

The assessed snapshot materially improves on the 4 July 2026 baseline. The
stale public-outcome LP option and the snapshot-price liability mismatch are
remediated.

The remaining verified risks are liveness limits from global single-vector
structures: active-flight admission caps and a strict-FIFO withdrawal queue
that can be pinned by an unfundable head request. Both should be redesigned
before production volume or vault capital makes these queues economically
important.

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
