# Sentinel Protocol — Missed-Issue and Remediation Review

**Assessment date:** 12 July 2026  
**Report version:** v1.1  
**Assessment status:** Final  
**Assessment type:** Independent review of prior audit reports and remediations  
**Auditor:** Codex 5.6 Sol High AI  
**Repository commit:** `fcde5aae26fe91cd53558905d390e0918aa53a59`

---

## Executive Summary

This review read the reports in `audits/` and the remediation records in
`audits/remediations/`, then traced their security claims against the current
production contracts. Four remediation gaps remain:

1. The aggregate solvency check added for NM-004 applies only when a policy is
   purchased. Vault withdrawals still reserve only nominal payoff liabilities,
   so an underwriter can withdraw the entire configured reserve margin and
   reduce collateralization to 100% immediately after a higher-ratio purchase.
2. The new governance term limits validate the route's current terms, but the
   Controller replaces those terms with an existing pool bucket's snapshot and
   never validates that snapshot against the current limits. An oversized
   bucket can therefore resume selling after the route is changed back to
   compliant terms, defeating the claimed retroactive de-listing behavior.
3. The buyer-whitelist remediation deliberately treats a Persistent entry's
   TTL as authorization expiry. On Protocol 23+, an archived Persistent entry
   is restored before contract execution rather than read as absent, so a
   dormant `true` approval remains valid instead of requiring re-attestation.
4. The fixed 25-flight settlement batch was sized before settlement began
   removing entries from the new paginated active set. A worst-case 25-flight
   cancelled batch now writes 83 ledger entries and emits 18,100 bytes of
   contract events, exceeding the SDK's modeled mainnet limits of 50 writes
   and 16,384 event bytes. The keeper call therefore cannot advance its cursor.

The first three issues are failures to enforce a security policy across all
state transitions. The fourth is a remediation regression in lifecycle
throughput. None requires violating Soroban authorization or transaction
atomicity.

### Findings Summary

| ID | Severity | Title | Classification |
| --- | --- | --- | --- |
| C56-M01 | Medium | Vault exits can remove the configured solvency reserve | Incorrect/incomplete fix |
| C56-M02 | Medium | Cached flight terms bypass newly lowered governance limits | Missed integration issue |
| C56-L03 | Low | Archived whitelist approvals restore instead of expiring | Incorrect fix / archival-semantics mismatch |
| C56-M04 | Medium | Fixed 25-flight settlement batch exceeds Soroban transaction limits after active-set pagination | Remediation regression |

---

# Detailed Findings

## [C56-M01] Vault exits can remove the configured solvency reserve

| | |
| --- | --- |
| Severity | Medium |
| Affected components | `Controller::buy_insurance`, `RiskVault::get_free_capital`, direct exits, withdrawal queue |
| Prior finding | VF-08 / NM-004 |
| Remediation status | Incomplete |
| Impact | Configured collateralization above 100% can be permissionlessly collapsed to 100% |

### Description

The NM-004 remediation changed policy admission to require:

```text
TMA >= ceil((locked capital + new payoff) × solvency ratio / 100)
```

The current Controller implements that check in
`contracts/controller/src/purchase.rs:173-197`. This prevents additional
policies from being admitted when aggregate exposure already exceeds the
configured ratio.

However, the vault does not preserve the same invariant after admission.
`RiskVault::get_free_capital` remains:

```rust
TMA - locked_capital
```

at `contracts/risk_vault/src/queries.rs:25-28`. It does not subtract the
reserve required by the configured ratio. The following paths all use that
nominal free-capital value:

- direct `withdraw` at `contracts/risk_vault/src/vault_ops.rs:156`;
- direct `redeem` at `contracts/risk_vault/src/vault_ops.rs:215`;
- `max_withdraw` / `max_redeem` at
  `contracts/risk_vault/src/vault_ops.rs:295-313`;
- queued withdrawal processing at
  `contracts/risk_vault/src/capital.rs:132`.

The Controller locks only the nominal payoff at
`contracts/controller/src/purchase.rs:205-206`. Consequently, every asset
above nominal liabilities is reported as withdrawable even when it is the
reserve margin that the configured ratio is intended to retain.

### Reproduction

Assume a 200% solvency ratio:

1. Underwriters deposit 1,000 assets into the vault.
2. Policies create 500 of aggregate payoff liability.
3. The purchase check passes exactly: `1,000 >= 500 × 200%`.
4. The vault records `locked_capital = 500` and reports
   `free_capital = 1,000 - 500 = 500`.
5. An LP directly withdraws 500, or queues shares worth 500 and has the queue
   processed.
6. The resulting state is `TMA = 500`, `locked_capital = 500`: collateralization
   is now 100%, despite the configured 200% requirement.

No further purchase is needed, and no pending-outcome barrier applies before
an outcome becomes public. The exit is an ordinary permissionless LP action.

The existing test
`solvency_ratio_enforced_on_aggregate_liabilities` proves only that an eleventh
purchase is rejected. It does not perform an exit after the tenth purchase or
assert that the ratio remains satisfied across vault state transitions.

### Impact

The vault remains nominally able to pay existing policy liabilities, so this
does not immediately create undercollateralization below 100%. It does nullify
the owner-configured safety margin, including any reserve intended to absorb
operational, accounting, or correlated-event risk. A value as high as the
entire nominal liability can be removed at 200%; larger configured ratios make
an even greater portion of the intended reserve withdrawable.

This is the residual half of VF-08, which correctly identified that merely
locking payoff does not preserve a ratio above 100%. The later NM-004
remediation fixed aggregate purchase admission but incorrectly treated that
admission check as holding the margin across the whole book.

### Recommendation

Define one canonical required-reserve calculation and enforce it in both
policy admission and every vault exit path. For current aggregate state:

```text
required_backing = ceil(locked_capital × solvency_ratio / 100)
withdrawable = max(TMA - required_backing, 0)
```

The vault must know the applicable ratio, either by storing a controller-set
value, reading an immutable/configured source, or receiving a conservatively
validated reserve requirement from the Controller. Apply the resulting
withdrawable amount to direct exits, queue processing, and `max_*` views.

If ratio changes must not retroactively alter existing policies, snapshot and
track the required locked amount per bucket instead, then release that exact
amount at settlement. Add invariant tests covering purchase, direct withdrawal,
redeem, queue processing, ratio changes, and settlement:

```text
TMA >= required_backing(outstanding liabilities)
```

---

## [C56-M02] Cached flight terms bypass newly lowered governance limits

| Field | Value |
| --- | --- |
| Severity | Medium |
| Affected components | Governance term limits, Controller purchase term selection, pool term snapshots |
| Remediation status | Incomplete integration |
| Impact | Oversized existing flight buckets can continue accepting policies after limits are lowered |

### Description

The governance module now lets the owner cap absolute payoff and the
payoff-to-premium ratio. Its documentation states that lowering the limits
retroactively de-lists oversized routes (`contracts/governance_module/src/admin.rs:68-84`).
`route_status` implements that behavior for the route's **current resolved
terms** at `contracts/governance_module/src/queries.rs:88-99`.

The Controller initially obtains those validated terms, but for an existing
`(flight_id, date)` bucket it subsequently replaces them with the pool's
snapshotted values:

```rust
let terms = match pool.get_flight_config(&flight_id, &date) {
    Some(cfg) => ResolvedTerms {
        premium: cfg.premium,
        payoff: cfg.payoff,
        delay_hours: cfg.delay_hours,
    },
    None => terms,
};
```

This occurs at `contracts/controller/src/purchase.rs:129-158`. No call then
checks the selected snapshot against the current `max_payoff` or
`max_payoff_ratio`. `FlightPoolManager::register_flight` verifies only that the
snapshot matches itself and satisfies the basic positive/payoff-above-premium
rules; it has no governance-limit context.

Thus, the route validated by `route_status` and the terms actually used for
premium transfer, solvency accounting, collateral locking, and payout can be
different security domains.

### Reproduction

1. While limits are permissive, an admin configures a route with premium 10
   and payoff 1,000.
2. One buyer registers a future flight bucket. The pool permanently snapshots
   `(10, 1,000, delay_hours)` for that `(flight_id, date)`.
3. The owner lowers `max_payoff` to 100. The current route is now reported as
   `Disabled`, as the governance unit test expects.
4. The admin updates the route to compliant terms, for example premium 10 and
   payoff 100. `route_status` becomes `Active` again.
5. A later buyer purchases the already-registered flight date. The Controller
   validates the compliant `(10, 100)` route, replaces it with the pool snapshot
   `(10, 1,000)`, and completes the purchase using the oversized payoff.

This is especially relevant to the stated threat model for the new limits:
they are intended to contain a compromised admin key. A compromised admin can
seed one oversized bucket while limits are permissive, and that bucket remains
a bypass after the owner lowers limits and the route is made superficially
compliant. Repeated buyers can add the old oversized payoff until the separate
vault solvency gate is exhausted.

The existing Controller test
`test_second_buyer_transacts_at_snapshotted_terms_after_term_change` confirms
the snapshot precedence but does not compose it with a lowered term limit. The
governance test `test_route_status_disabled_when_limits_lowered_below_route`
checks only the current route and therefore misses the cross-contract bypass.

### Impact

The owner cannot rely on lowered term limits to stop new exposure on existing
flight buckets. Policies written through the bypass retain the oversized
payoff and will receive it if the authorized oracle later records a qualifying
delay or cancellation. Exploitation requires a pre-existing oversized active
bucket, a live oracle sale authorization, and sufficient vault solvency; these
preconditions reduce severity but do not restore the intended owner/admin
security boundary.

### Recommendation

Validate the **final selected terms** in `buy_insurance`, after the pool
snapshot substitution. Suitable designs include:

1. Expose a governance method such as `terms_within_current_limits(terms)` and
   require it for the pool snapshot before collecting premium or locking
   collateral.
2. Return the current limits through the Controller's governance interface and
   apply the same checked validation locally.
3. Store a route generation or term-policy version in each pool bucket and
   explicitly close existing buckets when a new limit invalidates their
   generation.

Preserve immutable pricing among buyers of one flight, but do not conflate
price immutability with authorization to continue selling. An invalidated
bucket can retain its terms for existing policy settlement while rejecting new
buyers.

Add an integration test that registers a bucket, lowers the limits, changes the
route to compliant current terms, and verifies that a second purchase remains
blocked because the bucket snapshot exceeds the new limits.

---

## [C56-L03] Archived whitelist approvals restore instead of expiring

| Field | Value |
| --- | --- |
| Severity | Low |
| Affected components | Controller buyer whitelist storage and purchase gate |
| Prior finding | AA-CT-02 |
| Remediation status | Incorrect model decision |
| Impact | Dormant buyers retain authorization beyond the intended re-attestation period |

### Description

AA-CT-02 reported that a dormant buyer's whitelist entry could archive after
approximately 180 days. Its remediation deliberately adopted that behavior as
periodic re-attestation: an inactive approval was expected to lapse, fail
closed on the next purchase, and require an administrator to approve the buyer
again.

That intended model is stated directly in
`contracts/controller/src/whitelist.rs:16-24`:

```text
a buyer DORMANT for the full window lapses silently and must be re-approved —
the archived entry reads as not-whitelisted
```

The implementation stores only a boolean in Persistent storage:

```rust
e.storage().persistent().set(&key, &allowed);
e.storage().persistent().extend_ttl(
    &key,
    TRAVELER_FLIGHTS_TTL_LEDGERS,
    TRAVELER_FLIGHTS_TTL_LEDGERS,
);
```

at `contracts/controller/src/storage.rs:57-64`. The purchase gate later reads
that boolean with `unwrap_or(false)` at
`contracts/controller/src/storage.rs:67-71`, then refreshes its TTL after a
successful check (`contracts/controller/src/purchase.rs:47-52`).

On the repository's target Soroban protocol, an expired Persistent entry is
archived, not deleted. Starting in Protocol 23, RPC simulation normally places
an accessed archived entry in the transaction's restore list; it is restored
with its original value before the host function runs. If restoration is not
prepared, the invocation fails before contract execution. Contract code does
not observe a previously written archived Persistent value as ordinary
`None`.

The repository uses `soroban-sdk = 25.3.1`. Therefore, when a dormant approved
buyer returns after the nominal 180-day TTL:

1. the archived `BuyerWhitelisted(address) = true` entry is discovered during
   simulation;
2. the entry is restored before `buy_insurance` executes;
3. `read_buyer_whitelisted` returns `true`, not `false`;
4. the purchase succeeds and `touch_buyer_whitelisted` renews the restored
   approval.

The exact behavior is specified by Stellar's state-archival documentation:
<https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival>.

### Impact

The whitelist's documented inactivity timeout is not enforced. An address
approved once remains approved until an explicit `remove_whitelisted_buyer`
write, even after being dormant beyond the intended periodic re-attestation
window. This matters when whitelist approval represents time-sensitive KYC,
jurisdiction, sanctions, partnership, or controlled-rollout eligibility.

The issue does not let a never-approved address enter the whitelist, and the
feature is disabled by default. Explicit administrative revocation still
works because it overwrites the stored value with `false`. These constraints
support Low severity.

### Relationship to prior remediation

The 2026-07-04 remediation did not merely document an incidental availability
property; it selected expiry as the authorization model and explicitly
described it as failing closed. The later CF5-M01 archival-semantics review
recognized generally that archived Persistent entries cannot be observed as
missing, but the chosen whitelist policy and its security consequence were not
corrected. Current comments and query documentation still claim an archived
approval reads as false.

### Recommendation

Do not use Persistent TTL as a semantic authorization deadline. Choose one of:

1. Store `{ allowed, expires_at }` and require `allowed && now < expires_at` in
   both `is_whitelisted` and `buy_insurance`. Administrative re-approval should
   write a new explicit deadline.
2. Store approvals in Temporary storage if deletion at TTL expiry exactly
   matches the desired authorization model and the supported maximum lifetime.
3. If approvals are intended to remain valid until explicit revocation,
   remove the re-attestation claims from code and documentation and treat TTL
   restoration as the expected availability path.

The explicit-timestamp design is the clearest because it separates business
authorization lifetime from network storage lifetime. Add a test that advances
ledger timestamp past `expires_at` while preserving/restoring the stored value
and proves the purchase gate returns `BuyerNotWhitelisted`.

---

## [C56-M04] Fixed 25-flight settlement batch exceeds Soroban transaction limits after active-set pagination

| Field | Value |
| --- | --- |
| Severity | Medium |
| Affected components | `Controller::execute_settlements`, pool settlement, paginated active-set removal |
| Prior findings | NM-005 and NM-001 |
| Remediation status | Regressed after active-set pagination |
| Impact | A full ready-to-settle window can revert atomically and permanently block settlement progress |

### Description

NM-005 found that keeper batches of 100 exceeded Soroban transaction limits.
The remediation lowered `MAX_SETTLE_BATCH` to 25 based on an estimate of
approximately two persistent entries per settled flight: oracle `FlightData`
and pool `FlightConfig`, plus fixed overhead. That assumption is still stated
at `contracts/controller/src/constants.rs:10-18`.

The later NM-001 remediation replaced the single active-flight vectors with
the shared paginated `active_set`. Pool settlement now updates each
`FlightConfig` and calls `prune_active_list`:

- `settle_on_time` does so at
  `contracts/flight_pool_manager/src/settle.rs:31-43`;
- delayed and cancelled settlement does so at
  `contracts/flight_pool_manager/src/settle.rs:160-164`;
- `prune_active_list` delegates to `active_set::remove` at
  `contracts/flight_pool_manager/src/storage.rs:54-60`.

Each removal can write or remove the target `ActiveIdx`, an active-set page,
the moved tail entry's `ActiveIdx`, a tail page, and the shared count. These
entries were not part of the old two-entries-per-flight estimate. The exact
swap-removal writes are visible at
`contracts/sentinel_types/src/active_set.rs:242-287`.

`execute_settlements` nevertheless selects exactly
`min(MAX_SETTLE_BATCH, len - cursor)` entries and offers no caller-supplied
smaller limit (`contracts/controller/src/settle.rs:224-242`). It performs all
per-flight settlement work before persisting the next cursor at lines 343-350.
Because Soroban invocation failure is atomic, exceeding a resource limit rolls
back every settlement and the cursor update.

### Reproduction and measured resources

A targeted SDK 25.3.1 test created 25 distinct flight buckets with one buyer
each, recorded all 25 as cancelled, classified them, and invoked
`execute_settlements`. Resource enforcement was disabled only for the final
measurement so the host could report the complete invocation footprint:

| Resource | Measured full batch | SDK 25.3.1 modeled mainnet limit | Result |
| --- | ---: | ---: | --- |
| Write entries | 83 | 50 | Exceeded by 33 |
| Contract event bytes | 18,100 | 16,384 | Exceeded by 1,716 |
| Memory-read entries | 87 | 100 total ledger entries | Minimal remaining headroom before accounting differences |

The measured invocation also consumed 51,366,096 instructions and 18,905,249
bytes of memory, which remained below their corresponding modeled limits. The
decisive failures are therefore write-entry count and event size, not CPU.
Native-contract test execution can underestimate WASM CPU, but it does not
make 83 distinct writes fit within a 50-write transaction limit.

### Reachability and impact

No malicious privilege is required. Twenty-five ordinary insured flights can
be cancelled or sufficiently delayed in the same processing window. Once all
25 statuses are ready, the next settlement window attempts the full fixed
batch. The transaction exceeds the network limits, reverts, and leaves the
same cursor and statuses in place, so identical retries fail again.

The consequences extend beyond delayed claims:

- payout funds are not moved into the pool and claim windows do not open;
- nominal liabilities remain locked in the vault;
- oracle pending outcomes remain nonzero, so the vault's settlement barrier
  continues blocking deposits and direct withdrawals;
- there is no keeper parameter that can reduce this particular invocation to
  a progress-making sub-batch.

An upgrade or another privileged recovery mechanism is therefore needed to
clear a saturated ready window. The scenario is operationally plausible during
a correlated cancellation event, which is exactly when settlement liveness is
most important. This supports Medium severity.

### Recommendation

Do not encode one untested batch size for both classification and settlement.
Give `execute_settlements` a caller-supplied limit capped by a conservative
contract maximum, and ensure a keeper can always retry one flight. Lower the
default settlement maximum using the complete cross-contract footprint,
including worst-case cross-page swap removal, token transfers, vault writes,
TTL rent bumps, and events.

Preferably decouple financial settlement from active-set maintenance: mark the
flight settled and advance lifecycle state in the critical transaction, then
prune settled index entries through a separate bounded, permissionless call.
This keeps index bookkeeping from making payouts unexecutable.

Add production-resource-enforced regression tests for 25 on-time, delayed, and
cancelled flights, with removals spanning different active-set pages. Tests
must assert both that the chosen safe batch succeeds and that repeated calls
advance the cursor until every pending outcome is cleared.

---

## Review Notes

The active-set duplicate lead in `20260712_cosminmarian53_soroban_auditor_report.md`
was re-examined but not promoted here. Although `active_set::add` checks only
the reverse index, normal policy registration extends the index, oracle data,
and pool config beyond the departure date, while a sale authorization cannot
extend past that date. Under the current booking-horizon and TTL bounds, the
missing-index/missing-flight-state combination is therefore not reachable
during an open purchase window without abnormal restoration or state
corruption. Replacing the direct index check with exact `contains` remains
sensible defense in depth.

## Verification

The current workspace test suite was executed after review:

```text
cargo test --workspace
```

Result: **414 tests passed, 0 failed**.

The passing suite does not refute the findings: its aggregate-solvency test
checks only consecutive purchases, and its term-limit and snapshotted-term
tests exercise the two mechanisms independently rather than composing them.
The whitelist tests exercise write, remove, toggle, and ordinary purchase
behavior, but do not validate the selected re-attestation policy against
Protocol 23+ restoration semantics. The settlement tests cover multiple
flights functionally but do not exercise a full 25-flight worst-case batch
under modeled production resource limits. The targeted measurement performed
for C56-M04 recorded 83 writes and 18,100 event bytes for that batch.

## Conclusion

Prior remediation substantially improved policy admission and route validation,
but the remaining findings demonstrate that security rules must be enforced at
the state transition where they matter. Solvency requirements must constrain
later exits, governance limits must constrain the final terms actually consumed
by the purchase path, and authorization expiry must use an explicit time check
rather than Persistent-storage archival. Keeper batch sizes must also be
re-measured whenever downstream storage structures change; otherwise an
indexing remediation can silently make the settlement pipeline unexecutable.
Until then, the documented reserve, term-limit, whitelist-lifetime, and
settlement-liveness guarantees do not hold across all reachable state
transitions.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, economic risks, or integration failures. The runtime behavior of archived Persistent entries was assessed from Stellar Protocol 23 state-archival documentation and `soroban-sdk` 25.x semantics (automatic restoration within the transaction footprint; pre-execution failure otherwise), consistent with the external validation of this report; a live-network experiment remains a low-cost empirical check but is no longer a blocking uncertainty for any finding herein.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of these assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

This assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- financial or investment advice;
- compliance certification;
- a substitute for professional security auditing services.
