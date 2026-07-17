# Sentinel Protocol — Independent Soroban Security Assessment

**Assessment date:** 14 July 2026  
**Report version:** v1.3  
**Assessment status:** Final  
**Assessment type:** Independent production-contract security review with targeted executor follow-up  
**Auditor:** Codex AI  
**Repository commit:** `d7e652130b779334a9f9c667f8be3b3d4d0284fa`

---

## Executive Summary

This assessment reviewed every in-scope production Rust file in Sentinel's
Soroban contracts and traced the complete policy lifecycle across contract
boundaries: route authorization, sale attestation, purchase, premium escrow,
collateral locking, oracle resolution, classification, financial settlement,
traveler claims, expiry recovery, vault entry and exit, and queued withdrawal
processing. A targeted follow-up also reviewed the centralized executor's sale
revocation, cron scheduling, source-account transaction submission, and HTTP
operations interface because those paths directly drive the trusted oracle and
keeper roles.

The review identified **two High-severity fund-loss findings and three
Medium-severity findings**. First, the remediation for CAI-H01 limits
but does not eliminate deterministic post-cancellation purchases. A live sale
authorization remains usable after a cancellation becomes public until the
oracle revokes it or the authorization expires, which the contract permits up
to 24 hours later. Second, the vault's pending-outcome barrier activates only
after the public outcome is written on-chain. Before that write, an informed
LP can enter or exit against stale net asset value and transfer the known
settlement loss or gain to other LPs.

The first Medium finding concerns the oracle's single active-flight set, which
mixes flights booked up to 90 days ahead, flights ready for classification or
settlement, and flights retained for seven days after settlement. The keeper
can inspect only 25 entries per classification call and 10 per settlement
call. A public outcome that sits behind unrelated rows therefore keeps the
vault-wide pending-outcome barrier engaged until two independent cursors reach
it. At realistic active-set sizes this can block LP entry, direct exits, and
withdrawal-queue processing for hours or days and can delay travelers' claim
windows.

Two additional Medium findings affect the centralized executor. The hourly
classifier and five-minute settler both fire at hourly `:00` and independently
build transactions from the same keeper account. Without per-account
serialization or sequence-error retry, they can use the same source sequence
and one cannot succeed. Separately, the HTTP operations server exposes every
signer-backed job through unauthenticated, rate-unlimited POST endpoints and
does not bind explicitly to loopback. If deployment networking makes that port
reachable, an external caller can force fee expenditure, API quota consumption,
role-key contention, and sale denial.

The rotating cursors guarantee eventual coverage only if the keeper submits
enough transactions; they do not provide a bounded outcome-to-settlement
latency. The documented advice to increase keeper cadence is a useful interim
mitigation and reduces severity, but it does not isolate ready work from the
100,000-entry mixed set or let the keeper target a known outcome.

Two additional owner-only recovery concerns were confirmed as code behaviors
but not promoted to Medium findings under the stated trusted-owner model. They
are retained as hardening leads so that the remediation record does not
overstate the mechanical safety of forced oracle rotation or the payout safety
of manually evicting missing flights. Hypotheses that ignored transaction
atomicity, relied on stale SDK resource ceilings, or treated archived
Persistent entries as ordinary missing state were rejected.

The result is a point-in-time assessment, not a guarantee that the protocol is
free of other defects. It applies only to the source snapshot and scope stated
below.

### Findings Summary

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| C57-H01 | High | Live sale authorizations preserve a deterministic post-cancellation purchase window | Partially mitigated; accepted residual |
| C57-H02 | High | Off-chain-public outcomes let informed LPs trade at stale NAV before the barrier activates | Open |
| C57-M01 | Medium | Mixed active-flight enumeration can hold the global settlement barrier for hours or days | Open |
| C57-M02 | Medium | Colliding keeper crons can submit different transactions with the same account sequence | Open |
| C57-M03 | Medium | Unauthenticated executor triggers expose signer-backed jobs to external abuse | Open; deployment-conditional |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 2 | 3 | 0 | 0 |

### Overall Risk Rating

**High.** C57-H01 exposes the vault to purchases after a payout-triggering
event is public, and C57-H02 permits informed LPs to transfer a known
settlement loss or gain through stale share pricing. C57-M01 can additionally
degrade protocol-wide availability at intended operating volume, while
C57-M02 and C57-M03 expose the trusted automation layer to avoidable liveness
and externally triggered denial-of-service failures.

---

## Assessment Scope

### In Scope

The review covered 67 production Rust files and 7,385 lines across:

- `contracts/controller/src`
- `contracts/flight_pool_manager/src`
- `contracts/governance_module/src`
- `contracts/oracle_aggregator/src`
- `contracts/risk_vault/src`
- `contracts/sentinel_types/src`

This included public entrypoints, internal accounting helpers, cross-contract
client interfaces, storage layouts, authorization gates, pause and upgrade
paths, shared types, TTL calculations, and the paginated active-set
implementation.

The targeted executor follow-up covered these production files and their
direct configuration/documentation dependencies:

- `executor/centralized_cron/src/index.ts`
- `executor/centralized_cron/src/soroban_client.ts`
- `executor/centralized_cron/src/server.ts`
- `executor/centralized_cron/src/sale_authorizer.ts`
- `executor/centralized_cron/src/aeroapi_client.ts`
- the individual keeper job wrappers and executor configuration

### Out of Scope

- Unit-test and property-test source files
- Mock contracts, including `contracts/mock_usdc`
- `contracts/integration_tests`
- Fuzz targets and generated `target` artifacts
- Frontend, deployment, and off-chain infrastructure outside the targeted
  centralized-executor paths listed above
- Private key custody and compromise of explicitly trusted owner, admin,
  oracle, keeper, or controller roles
- Vulnerabilities inside Stellar/Soroban or third-party dependencies, except
  where dependency behavior was necessary to validate an in-scope call

Tests were excluded from the audited source scope but were executed as
verification evidence.

---

## Methodology

The audit used a manual, contract-by-contract and cross-contract review:

1. Enumerated every production entrypoint and its caller/authentication model.
2. Mapped all value stores: vault managed assets, locked capital, share supply,
   pool premium and payoff escrow, claimable withdrawals, and recovered funds.
3. Traced every mutation of coupled state through success, revert, retry,
   timeout, pause, and settlement paths.
4. Checked arithmetic domains, rounding direction, conversion monotonicity,
   counter bounds, timestamp boundaries, and positive-amount validation.
5. Audited the oracle and pool state machines for invalid transitions,
   duplicate registration, double settlement, double claims, and stale sale
   authorization.
6. Reviewed Persistent, Temporary, and Instance storage usage, including TTL
   sizing, Protocol 23+ restoration semantics, pagination, reverse indexes,
   swap-removal, and cursor behavior under list mutation.
7. Verified cross-contract call ordering and distinguished transient states
   inside one atomic invocation from states that can actually commit.
8. Reviewed the relevant `stellar-tokens` vault internals to confirm operator
   authorization, allowance spending, mint/burn, and transfer behavior used by
   the custom managed-asset accounting.
9. Rechecked material hypotheses against the current tests and automated
   invariant/property suite.
10. Traced executor cron concurrency, source-account sequence acquisition,
    HTTP trigger reachability, AeroAPI failure handling, and pause/unpause sale
    revocation behavior.

The audit prioritized fund loss, insolvency, unauthorized state changes,
claim denial, deterministic-payout purchases, accounting divergence, and
protocol-wide denial of service. Cosmetic issues and speculative concerns
without a reachable security impact were not reported.

---

## Security Model and Invariants Reviewed

| Area | Required invariant | Result |
| --- | --- | --- |
| Route identity | One `(origin, destination)` owns a `flight_id` during any downstream collision window | Preserved |
| Policy economics | Every new policy uses positive terms with `payoff > premium`, a nonzero delay threshold, and current governance limits | Preserved |
| Sale authorization | Purchases require a live, sufficiently fresh oracle attestation and a pre-outcome oracle status | Partially preserved; C57-H01 leaves a post-cancellation freshness window |
| Buyer uniqueness | One traveler can buy at most one policy per `(flight_id, date)` | Preserved |
| Premium and liability coupling | Every accepted buyer contributes one premium and one gross payoff lock | Preserved |
| Aggregate solvency | Admission and every LP exit preserve `TMA >= ceil(locked × solvency_ratio / 100)` | Preserved |
| Pool funding | A delayed/cancelled bucket is funded to `payoff × buyer_count` before its claim window opens | Preserved |
| Claim conservation | Every buyer payoff is claimed once or becomes recoverable once after expiry | Preserved |
| Withdrawal accounting | Processed claimable balances are removed from TMA before shares are priced again | Preserved |
| Queue escrow | Pending request shares remain vault-held until cancellation, burn, partial fill, or zero-value return | Preserved |
| Pending-outcome barrier | Public but financially unrecognized outcomes block vault entry and direct/queued exit pricing | Pre-write safety exposed by C57-H02; post-write liveness exposed by C57-M01 |
| Oracle lifecycle | Status transitions are forward-only and each counted pending outcome is released at terminal settlement | Preserved on normal paths and under correctly executed trusted-owner recovery |
| Active-set integrity | Count, pages, reverse indexes, and moved-tail indexes remain synchronized on add/remove | Structural integrity preserved; ready-work isolation fails in C57-M01 |
| Upgrade authorization | Each production upgrade wrapper is owner-gated before invoking the shared Wasm replacement helper | Preserved |
| Executor source sequencing | Jobs sharing one Stellar source account cannot race the same sequence number | Violated by the hourly classifier/settler collision in C57-M02 |
| Executor operations boundary | Signer-backed job triggers are restricted to authenticated operators | Deployment-conditionally violated by C57-M03 |

---

## Security Findings

### [C57-H01] Live sale authorizations preserve a deterministic post-cancellation purchase window

| Field | Value |
| --- | --- |
| Severity | High |
| Confidence | High |
| Status | Partially mitigated / accepted residual; prior remediation incorrectly summarized the issue as fixed |
| Impact | A traveler can buy a claim after learning that its payout-triggering cancellation has already occurred, causing deterministic vault loss |
| Primary components | `OracleAggregator::open_sale`, `OracleAggregator::close_sale`, `Controller::buy_insurance`, executor SaleAuthorizer |
| Prior history | CAI-H01, reported on 11 July 2026 and marked fixed by the sale-authorization remediation |

#### Description

The CAI-H01 remediation added an oracle-controlled, expiring sale
authorization. This is a meaningful mitigation, but it is a point-in-time
attestation rather than proof that no outcome has become public since the
attestation was issued. `open_sale` permits an authorization expiry as far as
`SALE_AUTH_MAX_VALIDITY_SECS = 86,400` seconds in the future. A purchase then
checks only that the on-chain oracle status is `NotInitiated` or `Active` and
that the stored authorization has not expired.

An external cancellation does not itself mutate either value. The stale
authorization becomes unusable only when an oracle transaction calls
`close_sale` or `set_cancelled`, or when its expiry is reached. A cancellation
that becomes public immediately after `open_sale` therefore leaves a valid
post-outcome purchase window. The remediation note itself acknowledges that
an off-chain cancellation can precede the revocation transaction and records
the maximum residual duration as 24 hours during an authorizer outage. The
finding should consequently be tracked as partially mitigated or as an
explicitly accepted residual risk, not as fully fixed.

Relevant source locations:

- `contracts/oracle_aggregator/src/constants.rs:57-67` permits sale
  authorizations lasting up to 24 hours;
- `contracts/oracle_aggregator/src/lifecycle.rs:26-103` opens and closes the
  authorization, while `set_cancelled` separately revokes it when the
  cancellation is finally written on-chain;
- `contracts/controller/src/purchase.rs:94-127` accepts a purchase while the
  stored status remains pre-outcome and `is_sale_open` returns true;
- `audits/remediations/20260711_codex_ai_remediation.md:171-177` documents the
  same residual window after describing CAI-H01 as fixed.

The shipped sale authorizer currently refreshes on a two-hour cron. That
cadence is supporting evidence for realistic exposure, not a prerequisite for
the finding: any delayed revocation preserves the contract-level window, and
the contract itself accepts authorizations lasting up to 24 hours.

The executor also leaves the pause-safe portion of the remediation incomplete.
When the SaleAuthorizer observes a cancellation, it calls only
`set_cancelled`. That outcome transition is correctly pause-gated, so it fails
while OracleAggregator is paused. The executor catches the failure and retries
on a later cycle, but it does not invoke the deliberately pause-exempt
`close_sale` as a first step or fallback. This contradicts the remediation's
stated design that the executor closes exposure with `close_sale` while actual
cancellation recording waits for unpause.

This does **not** permit a purchase to complete while OracleAggregator remains
paused. `buy_insurance` later invokes the pause-gated
`OracleAggregator::register_flight`, and that failure atomically reverts the
purchase. The narrower exposure occurs after unpause: the failed cancellation
write left the sale authorization intact, and a purchase can then complete
until the next successful authorizer retry or authorization expiry. This is an
executor-side extension of C57-H01's existing revocation-latency window, not a
separate finding.

Additional relevant locations are:

- `executor/centralized_cron/src/sale_authorizer.ts:86-117,169-171`, where the
  cancellation branch calls only `set_cancelled` and has no `close_sale`
  fallback;
- `contracts/oracle_aggregator/src/lifecycle.rs:80-103,211-258,262-292`, where
  `close_sale` is pause-exempt but `set_cancelled` and `register_flight` are
  pause-gated;
- `contracts/controller/src/purchase.rs:174-185`, where every otherwise valid
  purchase invokes `oracle.register_flight` before value movement;
- `audits/remediations/20260712_claude_fable5_remediation.md:71-79`, which says
  the executor will use `close_sale` during an oracle pause.

#### Reachability and impact

No trusted-role compromise is required. The sequence is:

1. The oracle issues or refreshes a valid sale authorization.
2. The airline or another public source announces that the flight is
   cancelled.
3. Before `close_sale`, `set_cancelled`, or authorization expiry reaches the
   ledger, a traveler calls `buy_insurance`.
4. The later cancellation settlement funds the buyer's gross payoff from the
   vault; the buyer's deterministic profit is `payoff - premium`.

In the pause-specific variant, step 3 can complete only after the oracle is
unpaused. While it remains paused, the downstream `register_flight` call
reverts the entire purchase even though the earlier sale-authorization query
still reads open.

Buyer approval, when enabled, can limit the set of usable addresses but does
not change the deterministic economics for an already approved traveler. It
is disabled by default and therefore is not a general fix. The loss is direct
and scales with every purchase and route limit accepted during the stale
authorization window, supporting High severity.

#### Recommendation

Do not label the issue fully fixed unless purchase activation is made
independent of revocation latency. One robust design is to queue a purchase
intent and activate the policy only after a cancellation-observation period;
if a qualifying outcome appears before activation, refund the premium and
discard the intent. An authoritative event-driven cancellation feed can
materially reduce exposure but still leaves a residual that should be bounded
with short contract-enforced authorization lifetimes, per-route exposure caps,
monitoring, and an explicit risk-acceptance statement.

Independently of the longer-term policy design, correct the shipped executor:
when cancellation is observed, submit `close_sale` first and then attempt
`set_cancelled`. Revocation is strictly protective and remains available while
the outcome state machine is paused. Add an integration/runbook case covering
"oracle paused, controller live, cancellation observed, then oracle unpaused"
and assert that no stale authorization survives the pause.

If immediate activation is retained, record CAI-H01 as **partially mitigated /
accepted residual**, quantify the maximum authorization age used in
production, and alert whenever revocation latency exceeds that operational
bound.

---

### [C57-H02] Off-chain-public outcomes let informed LPs trade at stale NAV before the barrier activates

| Field | Value |
| --- | --- |
| Severity | High |
| Confidence | High |
| Status | Open |
| Impact | An informed LP can avoid a known loss or dilute a known gain by entering or exiting before the outcome is reflected in vault net asset value |
| Primary components | `OracleAggregator::set_landed`, `OracleAggregator::set_cancelled`, `RiskVault` deposit/mint/withdraw/redeem and withdrawal processing |
| Prior history | Independently reported in `20260714_cosminmarian53_soroban_auditor_report.md`; no remediation was present at assessment time |

#### Description

RiskVault blocks share entry and exit by querying the oracle's aggregate
`PendingOutcomes` counter. This protects pricing only after the oracle has
written the public result on-chain. The counter is incremented inside
`set_landed` and `set_cancelled`; no contract state changes merely because the
same result is already public through an airline, airport, or flight-data
feed.

Consequently, there are two distinct periods:

1. **Outcome public, oracle write not yet committed:** `PendingOutcomes` may
   remain zero, so deposits, mints, withdrawals, redemptions, and queued-exit
   pricing remain available at the pre-outcome TMA.
2. **Oracle write committed, financial settlement pending:** the existing
   barrier correctly blocks those operations until settlement updates TMA.

The barrier therefore closes the post-write stale-pricing window but not the
pre-write window. The shipped flight-data fetcher runs periodically, making
this exposure realistic, but the weakness does not depend on its exact
schedule. Every oracle architecture has some observation and submission
latency unless LP operations use delayed or epoch-based pricing.

Relevant source locations:

- `contracts/risk_vault/src/auth.rs:27-44` implements the barrier exclusively
  through `OracleAggregator::has_pending_outcomes`;
- `contracts/risk_vault/src/vault_ops.rs:107-113,145-151,180-186,204-210`
  applies that check to share entry and exit paths;
- `contracts/risk_vault/src/capital.rs:129-142` applies the same counter to
  withdrawal-queue pricing;
- `contracts/oracle_aggregator/src/lifecycle.rs:181-190` increments the counter
  only when a landed outcome is written;
- `contracts/oracle_aggregator/src/lifecycle.rs:229-236` does the same only
  when a cancellation is written.

Existing integration coverage establishes that LP pricing is blocked after
the counter increments. It does not remove the interval before that
transaction reaches the ledger.

#### Reachability and impact

No privileged call or protocol failure is required. An LP who learns a public
delayed or cancelled outcome before the oracle transaction can redeem at the
old, higher NAV and leave the known payout loss to remaining LPs. Conversely,
an LP who learns that an insured flight completed without a payable outcome
can deposit at the old, lower NAV before the earned premium is recognized and
dilute the gain belonging to existing LPs.

This is a direct LP-to-LP value transfer using ordinary vault entrypoints. The
oracle write and later settlement do not claw back the stale-priced shares or
assets, so the violation persists at the committed final state. Its value
scales with the known bucket settlement and the position entered or exited,
supporting High severity.

#### Recommendation

Price LP entry and exit on delayed or epoch-finalized state rather than making
immediate pricing depend solely on an oracle counter that activates after the
outcome is known. Suitable designs include:

1. queue every LP entry and exit and finalize it only after an oracle
   observation window has elapsed;
2. use settlement epochs whose share price is fixed only after all outcomes
   public before the epoch boundary have been reconciled;
3. permit immediate requests but apply the eventual post-settlement NAV to
   their execution, with cancellation available before finalization.

Higher oracle cadence and event-driven submissions reduce the attack window
but do not eliminate the information asymmetry. If the protocol retains
immediate pricing, it should quantify and explicitly accept that residual
risk rather than treating `PendingOutcomes` as a complete public-outcome
barrier.

---

### [C57-M01] Mixed active-flight enumeration can hold the global settlement barrier for hours or days

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | High |
| Status | Open; operational cadence mitigation documented |
| Impact | Protocol-wide LP entry/exit and queue processing unavailable; traveler claims and collateral release delayed |
| Primary components | `Controller::classify_flights`, `Controller::execute_settlements`, `OracleAggregator` active set, `RiskVault` settlement barrier |
| Prior history | Cadence coupling was accepted/documented as CF5-L02 on 11 July; no on-chain isolation was adopted |

#### Description

The repository already acknowledges the general cadence dependency as a known
limitation. Documentation is not a code remediation, however. The current
layout expands the oracle set's cap from the earlier 1,000 rows to 100,000 and
uses a separate 10-row settlement window, making the two-stage latency
materially larger than the earlier qualitative treatment. This assessment
therefore records the still-open issue at Medium severity; the keeper's ability
to submit additional calls prevents a High rating.

Every first policy for a `(flight_id, date)` registers that tuple in the
oracle's paginated active set. The contracts allow booking up to 90 days ahead,
and the set is capped only at 100,000 entries. Financial settlement does not
remove an entry: `set_settled` leaves it in the same set for a further seven
days before `prune_settled` may evict it.

The same mixed set is the sole source of work for both keeper passes:

- `classify_flights` reads at most `MAX_CLASSIFY_BATCH = 25` consecutive slots;
- `execute_settlements` reads at most `MAX_SETTLE_BATCH = 10` consecutive slots;
- both advance independent persistent cursors past every inspected row,
  including future `NotInitiated`/`Active` rows and terminal `Settled` rows;
- neither entrypoint accepts an exact flight key or consumes a status-specific
  ready queue.

Relevant source locations:

- `contracts/oracle_aggregator/src/lifecycle.rs:263-288` (registration appends),
  `373-400` (settlement retains), and `410-480` (bounded delayed pruning);
- `contracts/oracle_aggregator/src/constants.rs:3-22,43-54` (60-row prune,
  100,000-row cap, seven-day retention);
- `contracts/controller/src/constants.rs:3-27` and
  `contracts/controller/src/settle.rs:35-56,182-186,246-262,365-371`
  (25/10-row windows and independent cursors);
- `contracts/risk_vault/src/auth.rs:22-44` and
  `contracts/risk_vault/src/capital.rs:129-142` (global barrier effects).

When the oracle writes `Landed` or `Cancelled`, it immediately increments
`PendingOutcomes`. The counter is decremented only by `set_settled`, after both
keeper stages have reached and processed the row. While it is nonzero, vault
deposit, mint, withdraw, and redeem revert, and withdrawal-queue processing
returns without pricing any request. The barrier is a correct stale-price
safety control; the mixed work queue turns its per-flight latency into a
protocol-wide availability failure.

For active-set length `N`, a steady-state full rotation requires
`ceil(N / 25)` classification calls and approximately `ceil(N / 10)` default
settlement calls. A row whose outcome changes just after the relevant cursor
passes it can wait roughly one rotation of each independent pass. The
following illustrates that full-rotation latency using the shipped one-hour
classifier and five-minute settler cadences, and the documented under-load
mitigation of running both every five minutes:

| Active rows | 1 h classify + 5 min settle | Both every 5 min |
| ---: | ---: | ---: |
| 420 | 20 h 30 min | 4 h 55 min |
| 1,000 | 48 h 20 min | 11 h 40 min |
| 10,000 | 20 d 3 h 20 min | 4 d 20 h 40 min |

The executor cadence is included in the targeted follow-up to supply concrete
operational timing. The contract weakness remains schedule-independent: for
every fixed call rate, ready-work latency grows linearly with the total
mixed-set occupancy.

These are illustrative near-worst-case rotation times, not claims that every
outcome waits the full interval. They show that merely increasing cadence to
one call every five minutes does not establish a useful settlement SLA as `N`
grows. At 60 settled flights per day, the mandatory seven-day retention alone
contributes roughly 420 terminal rows; insured future flights add to that
population. In a steady stream of outcomes, `PendingOutcomes` can remain
continuously nonzero even though each individual call succeeds.

#### Reachability and impact

No trusted-role compromise is required. Legitimate policy growth creates the
condition. An untrusted traveler can also contribute one row for each distinct,
sale-authorized flight date by being its first buyer. This is not a cost-free
attack: every policy pays a premium and consumes vault collateral, which is why
the finding is not High severity. Nevertheless, the work amplification is
global: unrelated flights consume the same cursor windows, while one delayed
row blocks every LP's executable entry/exit pricing and postpones affected
travelers' funded claim window.

The permissionless prune does not solve the core issue. It cannot remove
future or unresolved flights, cannot remove a settled flight during its
seven-day retention period, and inspects only 60 mixed slots per call. The
keeper can submit more classify/settle transactions, but only the configured
keeper may do so, and the number required scales linearly with all active rows
rather than with ready outcomes.

#### Recommendation

Separate operational work from historical enumeration:

1. On `Landed`/`Cancelled`, enqueue the exact tuple in a bounded
   classification-ready set. On `set_to_be_settled`, move it to a separate
   settlement-ready set. Keeper calls should consume only those sets.
2. Alternatively, add bounded entrypoints that accept exact flight tuples and
   validate their current state on-chain. The off-chain oracle already knows
   which outcomes changed; a rotating full-set sweep can remain as a repair
   backstop rather than the primary path.
3. Remove `Settled` entries from the operational set immediately. Preserve
   observability through events or a separate history index that keeper calls
   never scan.
4. Until an upgrade, loop keeper transactions until `PendingOutcomes == 0`,
   derive the required call rate from live active-set occupancy, repeatedly
   prune through complete rotations, and alert on the age of the oldest
   pending outcome rather than only on cron success.

---

### [C57-M02] Colliding keeper crons can submit different transactions with the same account sequence

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | High |
| Status | Open |
| Impact | Classification or settlement calls can fail at every hourly collision, delaying outcome processing, claims, collateral release, and clearing of the vault settlement barrier |
| Primary components | Executor cron scheduler, `SorobanClient::invokeContract`, FlightClassifier, SettlementExecutor |
| Prior history | Not identified in the reviewed audit reports; QueueMaintainer was already offset specifically to reduce the same sequence-number risk |

#### Description

FlightClassifier is scheduled hourly at minute `:00`. SettlementExecutor is
scheduled every five minutes, including the same hourly `:00`. Both jobs sign
with `keeperSecretKey`, and the cron callbacks execute independently without a
shared lock or submission queue.

Every `SorobanClient::invokeContract` call independently fetches the current
Stellar source account, builds a transaction from that account sequence,
simulates, signs, submits, and polls it. If the two jobs fetch the account
before either transaction consumes its sequence, both build different
transactions using the same next sequence number. Both cannot succeed: after
one transaction consumes that sequence, the other is rejected or fails for a
sequence conflict. The client records the job failure but does not refetch the
account, rebuild and re-simulate the transaction, or otherwise retry a
bad-sequence result.

Relevant source locations:

- `executor/centralized_cron/src/index.ts:50-62` schedules FlightClassifier and
  SettlementExecutor for the same hourly `:00` tick;
- `executor/centralized_cron/src/flight_classifier.ts:16-46` and
  `executor/centralized_cron/src/settlement_executor.ts:21-51` independently
  create clients and submit with the same `keeperSecretKey`;
- `executor/centralized_cron/src/soroban_client.ts:62-81,105-134` fetches the
  source account anew for each call and contains no per-account serialization
  or sequence-conflict retry;
- `executor/centralized_cron/src/index.ts:29-31,64-69` and
  `queue_maintainer.ts:11-14` explicitly offset QueueMaintainer because it
  shares the keeper key, demonstrating that the sequence contention is already
  recognized but incompletely applied.

Changing only the cron offsets would not fully solve the defect. Every manual
HTTP trigger starts another independent job, and a slow transaction can remain
in flight when a nominally separated job begins. Jobs sharing the oracle key
or TTL key have the same structural risk whenever scheduled and manually
triggered executions overlap.

#### Reachability and impact

No malicious caller or trusted-role compromise is required for the default
collision: both keeper jobs become eligible during every hourly `:00` tick.
Network timing determines whether they actually read the same sequence, but
the asynchronous account fetch and simulation windows make that race directly
reachable.

Settlement has another scheduled opportunity five minutes later, while
classification normally retries only at the next hour. If SettlementExecutor
repeatedly wins the shared sequence, newly written `Landed` or `Cancelled`
outcomes remain unclassified. They cannot advance to financial settlement,
traveler claim windows stay unopened, collateral remains locked, and
`PendingOutcomes` can continue blocking every price-sensitive vault entry and
exit. The keeper cannot redirect funds, and later successful calls can recover
progress, which keeps the issue at Medium rather than High severity.

Unauthenticated HTTP triggers in C57-M03 can deliberately amplify this race by
starting additional jobs under the same configured role keys.

#### Recommendation

Serialize the complete build/simulate/sign/submit lifecycle by source public
key. The lock must be shared across all cron and HTTP job invocations and must
be acquired before `getAccount`, not only around `sendTransaction`. Hold it
until the transaction reaches a terminal result so the next caller observes a
consumed sequence.

Add bounded retry for sequence conflicts that refetches the account and fully
rebuilds and re-simulates the transaction. Retain schedule offsets as
defense-in-depth, add per-job overlap suppression, and test two concurrent jobs
using one signer to confirm that both eventually submit with distinct
sequences.

---

### [C57-M03] Unauthenticated executor triggers expose signer-backed jobs to external abuse

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | High |
| Status | Open; deployment-conditional on network reachability |
| Impact | An external caller can force fee expenditure, AeroAPI quota consumption, role-key sequence contention, executor load, and temporary sale denial |
| Primary components | Executor Express server, manual trigger routes, SaleAuthorizer, AeroAPI error handling |
| Prior history | Not identified in the reviewed audit reports |

#### Description

The centralized executor exposes POST routes that run SaleAuthorizer,
FlightDataFetcher, FlightClassifier, SettlementExecutor, QueueMaintainer, and
TTLExtender using the service's configured signer secrets. None of these routes
requires an operator credential, and the server has no request rate limit,
concurrency limit, duplicate-job suppression, or per-source-account lock.

The server also enables wildcard CORS and calls `app.listen(port)` without an
explicit host. With Node's default listen behavior, omitting the host binds an
unspecified/all-interface address rather than loopback only. The log message
prints a `localhost` URL, but it does not restrict the listening socket.
Actual external reachability still depends on the host firewall, container
port publication, reverse proxy, and surrounding network, so this finding is
deployment-conditional.

Relevant source locations:

- `executor/centralized_cron/src/server.ts:19-29` permits requests from every
  browser origin;
- `executor/centralized_cron/src/server.ts:63-122` exposes six unauthenticated
  signer-backed POST triggers;
- `executor/centralized_cron/src/server.ts:124-129` listens without an explicit
  host and logs the potentially misleading localhost address;
- `executor/centralized_cron/src/config.ts:21-23` loads the oracle, keeper, and
  TTL signer secrets used by those jobs;
- `docs/docs/developers/executor.md:58-60` documents the operations API but no
  required authentication or network-isolation control.

Wildcard CORS is not the root authorization failure—non-browser clients ignore
CORS entirely—but it additionally permits a malicious website to initiate
simple cross-origin POST requests from an operator's or any other reachable
browser.

#### Reachability and impact

If the port is reachable, an untrusted caller can invoke every endpoint
repeatedly and concurrently without knowing a signer secret. The routes do not
permit arbitrary contract method selection or attacker-chosen arguments, so
they do not directly grant custody of the role keys or a fund-transfer
primitive. They nevertheless make the service spend fees and external API
quota, perform expensive simulations, hold HTTP requests while polling, and
race legitimate role-key transactions.

SaleAuthorizer creates an additional protocol-level denial-of-service chain.
`AeroApiClient::getFlightData` retries HTTP 429 and server errors three times,
then returns `null`. SaleAuthorizer treats the same `null` as an unverifiable
flight and closes any live sale authorization. An external caller can therefore
run enough concurrent authorizer jobs to exhaust provider quota and cause
otherwise valid sale windows to be revoked. Specifically:

- `executor/centralized_cron/src/aeroapi_client.ts:50-104` converts exhausted
  429/5xx/network retries and several other API failures into `null`;
- `executor/centralized_cron/src/sale_authorizer.ts:121-141` interprets `null`
  as loss of confidence and submits `close_sale` for every live window;
- the same concurrent triggers amplify the source-sequence failures described
  by C57-M02.

The effects are recoverable after quota, signer balance, and job execution
recover, and the endpoints cannot choose arbitrary value recipients. Medium
severity is therefore appropriate when the service is externally reachable.
If a deployment proves the port is restricted to an authenticated private
operations plane, the vulnerability is not externally reachable in that
deployment, though the unsafe application default remains.

#### Recommendation

Bind explicitly to `127.0.0.1` by default and require an intentional
configuration change to listen on another interface. Authenticate every POST
trigger with a securely managed operator token or mutual TLS, reject missing or
invalid credentials before starting work, and configure restrictive CORS only
for any browser-based operator console that is actually used.

Add per-client and global rate limits, single-flight/deduplication guards for
each job, request timeouts, and the shared per-source-account transaction queue
recommended in C57-M02. Keep the port unexposed at the firewall/container layer
as defense-in-depth. Monitor AeroAPI quota and trigger concurrency so the
intentional fail-closed revocation policy cannot be silently activated by
operations-plane abuse.

---

## Contract and Executor Results

### Controller

C57-H01 affects the purchase authorization implemented here, C57-H02 affects
the price-sensitive vault operations called by LPs, and C57-M01 affects the
keeper enumeration. The purchase path authenticates the traveler, enforces
the day-level policy identity, explicit buyer approval when enabled, route
status, lead time, booking horizon, on-chain oracle status, and a live sale
authorization before value movement. Those checks are internally consistent,
but neither on-chain value reflects an external cancellation until the oracle
submits its next transaction (C57-H01). Existing bucket terms are revalidated
against current governance limits. Premium transfer, collateral locking,
buyer registration, indexing, and aggregate counters execute atomically, so a
late duplicate-buyer or downstream failure cannot leave a partial purchase.

Classification and settlement are keeper-gated and resource-bounded, but their
latency is not bounded independently of the mixed active-set length
(C57-M01). Once a row is reached, the settlement path correctly reconciles
pool escrow, vault TMA, gross locked liability, pool status, oracle status, and
the pending-outcome counter in one transaction. The operator-bounded
settlement entrypoint permits progress with a one-flight window if network
resource conditions become tighter than the default batch.

### FlightPoolManager

No valid finding was identified. Registration validates economic terms and
locks them per flight bucket. Buyer proofs, buyer counts, premiums, claim
proofs, claimed counts, and recovered balances remain coupled across purchase,
settlement, claim, sweep, and owner withdrawal. Delayed/cancelled settlement
requires the pool's physical asset balance to cover the bucket's full
claimable value before opening the claim window.

Claims remain available during a pause so the ledger clock cannot consume a
user's claim window while the claim entrypoint is disabled. Double claims and
post-expiry claims are rejected, and expiry sweeping becomes idempotent by
bringing `claimed_count` to `buyer_count`.

### GovernanceModule

No valid finding was identified. Owner/admin separation is enforced, route
writes resolve and validate partially defaulted terms, and reads fail closed
when mutable defaults or current limits make the resolved economics invalid.
The route record, `flight_id` uniqueness index, and retirement marker prevent
two route identities from colliding in downstream `(flight_id, date)` state.

### OracleAggregator

C57-H01 originates in the gap between an external cancellation and revocation
of this contract's still-live sale authorization. C57-H02 originates in the
same pre-write interval because `PendingOutcomes` changes only when the oracle
transaction commits. C57-M01 then arises partly from the mixed active set and
seven-day terminal retention after the write. Oracle and controller write
domains are separate, the flight state machine is forward-only, malformed
arrival timestamps are rejected, pre-registration cancellation tombstones
block purchases once written, and `set_cancelled` removes any live sale
authorization. `close_sale` remains available while paused because it only
revokes authority. These controls do not retroactively invalidate a policy or
LP price accepted before the oracle write.

`PendingOutcomes` is incremented exactly when an insured outcome or timeout
void is written on-chain and decremented at settlement. The normal
oracle-rotation path refuses to abandon pending outcomes; the emergency path
requires the vault to be paused. The owner-only limitations of that emergency
path are recorded separately as a hardening lead below.

### RiskVault

C57-H02 shows that this contract's settlement barrier activates too late to
prevent informed trading before an external outcome reaches the oracle.
C57-M01 then makes the otherwise-correct post-write barrier a protocol-wide
liveness amplifier. Apart from C57-H02, no vault-accounting finding was
identified. Share conversions consistently use TMA rather than raw token
balance, excluding processed but uncollected withdrawal liabilities from share
backing. Direct and queued exits use the same reserve-aware
withdrawable-capital formula as policy admission. Deposit, mint, withdraw,
redeem, request, cancel, process, collect, payout, and premium income paths use
the required rounding and authorization directions.

Queue processing tracks running TMA while live share supply is burned, so
requests in one batch receive a consistent price. Partial fills cannot exceed
the available reserve-aware budget and preserve FIFO by retaining the oldest
remainder ahead of every later request.

### sentinel_types

No valid finding was identified. Shared ABI types eliminate cross-contract
layout drift. Deadline-derived TTL helpers clamp extensions safely, and the
active set validates indexes against page contents, falls back to scans where
appropriate, fails closed on unavailable tail state, bounds duplicate scans,
and updates the moved tail's reverse index during swap-removal.

### Centralized Executor

C57-H01's contract-level revocation window is extended by an incomplete
pause-path implementation: SaleAuthorizer attempts only the pause-gated
`set_cancelled` transition when it observes cancellation and does not first or
subsequently call the pause-exempt `close_sale`. Purchases still revert while
OracleAggregator remains paused because `buy_insurance` calls the pause-gated
`register_flight`; the exploitable stale authorization resumes only after
unpause and lasts until retry or expiry.

C57-M02 arises because independently scheduled and manually triggered jobs do
not share source-account sequencing state. The default hourly classifier and
five-minute settler collide at every hourly `:00`, and every invocation fetches
the account before building its own transaction. C57-M03 arises because the
same signer-backed jobs are exposed through an HTTP operations interface with
no authentication, rate limit, overlap guard, or loopback-only bind. Neither
issue grants arbitrary contract-call authority, but both permit preventable
automation denial of service and compound each other's sequence contention.

---

## Trusted-Owner and Recovery Hardening Leads

The following behaviors are real, but they do not meet the report's Medium
threshold under the explicit trust assumptions. They are excluded from the
severity distribution and retained to qualify overly broad remediation
claims.

### Forced oracle rotation can be followed by immediate unpause

`force_set_oracle` requires the vault to be paused at the moment of rotation,
but it records no sticky incident or reconciliation state. `unpause` checks
only owner authorization and the current pause flag. The owner can therefore
pause, force-rotate from an oracle that still represents unresolved outcomes
to a fresh oracle whose pending counter is zero, and immediately unpause LP
pricing. The remediation claim that the pause precondition makes forced
rotation mechanically safe is too broad.

This is not promoted to Medium because every step is owner-authorized, owner
compromise is out of scope, and the same owner controls upgrades. It is a Low
operational-hardening concern under the stated model. If the emergency path is
retained, set a sticky forced-rotation incident flag that blocks unpause and
all price-sensitive vault operations until an objective on-chain
reconciliation condition is satisfied. An unrestricted owner-only
`mark_reconciled` function would add ceremony but not a security boundary.

Relevant source locations are
`contracts/risk_vault/src/admin.rs:92-113`,
`contracts/risk_vault/src/traits.rs:32-38`, and
`audits/remediations/20260712_claude_fable5_remediation.md:35-50`.

### Missing-flight eviction relies on owner-supplied accounting and void settlement

`evict_missing_flight(..., outcome_pending)` decrements the global pending
counter according to an owner-supplied Boolean rather than per-flight counted
state. Supplying `true` for a flight that was not counted can release another
flight's barrier early. The paired `settle_evicted_flight` recovery path always
uses on-time/void economics: it returns the premium to the vault, releases the
gross payoff lock, and creates no traveler payout. If this path were used for
a genuinely delayed or cancelled flight, its payout semantics would be lost.

The behavior is owner-only and is not reachable from ordinary Protocol 23+
Persistent-entry archival: the entry is restored before contract execution or
the transaction fails, rather than reading as an ordinary missing value. No
production path removes `FlightData`; the tests exercise recovery by deleting
storage directly. The concern is therefore Informational/Low and conditional
on manual recovery or a future state-loss incident, not a current Medium
untrusted exploit.

Prefer a per-flight marker recording whether that exact flight incremented
`PendingOutcomes`, and require recovery to supply and validate the actual
outcome so delayed/cancelled flights retain payout semantics. Relevant source
locations are `contracts/oracle_aggregator/src/admin.rs:87-116`,
`contracts/oracle_aggregator/src/storage.rs:102-113`, and
`contracts/controller/src/settle.rs:403-454`.

---

## Material Hypotheses Rejected

The following issues were investigated but did not meet the reporting bar:

### Raising the solvency ratio makes `get_withdrawable_capital` abort

The diagnostic sequence deposits 1,000 units, locks 600, raises the ratio to
200%, and expects the withdrawable-capital query to fail because the required
reserve (1,200) exceeds TMA (1,000). It does not fail. These values are signed
`i128`s: `1,000.checked_sub(1,200)` validly returns `-200`; it is not an
unsigned underflow. The final `.max(0)` returns zero as intended. The
adversarial test fails its `result.is_err()` assertion, confirming that the
query and all exit gates remain callable while an owner-raised ratio makes the
vault temporarily under-reserved.

### Fifty queue credits or sixty prunes exceed Soroban transaction limits

Both worst-case shapes were measured with SDK resource enforcement disabled so
the complete invocation footprint could be observed:

| Invocation | Instructions | Memory | Read entries observed | Write entries | Write bytes | Events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 unique withdrawal credits | 15,070,570 | 5,270,819 B | 56 | 53 | 8,728 B | 10,600 B |
| 60 aged settled-flight prunes | 26,840,725 | 6,448,584 B | 123 | 62 | 496 B | 0 B |

The pinned SDK's modeled profile still treats roughly 50 writes / 100 footprint
keys as the ceiling, but those are not the current network limits. As of this
assessment, [Stellar Lab's live network-limit view](https://lab.stellar.org/network-limits)
reports 400 million instructions, 41.9 MB memory, 400 footprint keys, 200 disk
reads, 200 disk writes / 132.1 KB, and 16.4 KB for events plus return value per
transaction. Both measured calls remain below every relevant ceiling. Network
settings are mutable, so deployment simulations and monitoring remain
appropriate; exceeding a stale local profile is not a current vulnerability.

### Archived active-set entries cause committed page/index corruption

This requires contract code to observe an archived Persistent footprint entry
as a normal `None` and then commit around it. On the target Soroban archival
model, the footprint is restored before execution or the transaction fails
before state commits. The implementation also validates reverse indexes and
contains bounded scan/fail-closed backstops. No untrusted sequence produced a
committed count/page/index divergence.

### Pool-wide funding check lets one bucket consume another bucket's escrow

The balance check is global, but the only production caller is the Controller.
For every delayed/cancelled bucket, the pool already holds
`premium × buyer_count`, and the Controller atomically transfers
`(payoff - premium) × buyer_count` before opening the claim window. Other
bucket liabilities therefore remain funded. Any downstream failure reverts
the transfer and all associated accounting.

### Payout ordering creates an exploitable `TMA < locked` state

The Controller sends the net payout before releasing the bucket's gross locked
payoff. A transient intermediate state can therefore have lower TMA while the
old lock is still recorded. Soroban does not allow reentrant observation of
that intermediate state, and the complete cross-contract invocation is
atomic. At every committed boundary, the settled liability and TMA are
reconciled.

### Partial withdrawal fills over-credit assets or break FIFO

The fillable share slice is rounded down from the remaining asset budget, and
the conversion back to assets is also rounded down. The credited amount cannot
exceed the budget. The unfilled head remainder is retained before later
requests, and processing stops for the pass, so later users cannot jump it.

### New policies improperly consume liquidity expected by queued LP exits

Queued requests have FIFO priority relative to other queued requests but do
not reserve capital against future underwriting. Requests are priced when
processed, after public outcomes settle. This is an explicit liquidity policy,
not an invariant granting queued LPs priority over new policies; no fund loss
or accounting error results.

### A heavily delayed settlement can open an already-expired claim window

The pool deliberately caps claim deadlines relative to the flight date. After
an extreme keeper outage, settlement may therefore open a window whose cap is
already past and route the funded payout to owner-recoverable escrow. This is
an explicit, tested recovery policy for a trusted-keeper liveness failure, not
an untrusted exploit path. It was not promoted to a security finding under the
stated trust model. Operational monitoring should nevertheless alert well
before settlement approaches the cap.

---

## Conclusion

Five issues met the reporting threshold. C57-H01 leaves a bounded but direct
deterministic-claim purchase window after public cancellation and should be
tracked as partially mitigated or explicitly accepted rather than fixed.
C57-H02 leaves LP share pricing open before a public outcome is written
on-chain, allowing informed value transfer at stale NAV. C57-M01 allows the
mixed active-flight enumeration to turn subsequent settlement latency into a
global vault-availability failure. C57-M02 allows keeper jobs sharing one
source account to race the same sequence and lose required automation calls.
C57-M03 conditionally exposes every signer-backed executor job to
unauthenticated external triggering when the operations port is reachable.

The forced-rotation and missing-flight recovery concerns are genuine owner-only
hardening gaps, but they are not Medium untrusted exploit paths under this
assessment's trust model and are excluded from the formal count. The remaining
solvency, escrow, lifecycle, arithmetic, and storage invariants reviewed were
preserved subject to the findings above.

Future changes to settlement batching, pending-outcome accounting,
claim-deadline policy, active-set storage, vault share pricing, oracle rotation,
or cross-contract wiring should be treated as high-risk because those areas
carry the protocol's most tightly coupled security assumptions.

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
