# Claude Fable 5 — Security Re-Audit Report (v2, 2026-07-11)

**Auditor:** Claude Fable 5 (automated AI audit, second pass)
**Audited commit:** `5e37718` (branch `new-issues-fixes`, clean)
**Scope:** all contracts under `contracts/` — `controller`, `risk_vault`,
`flight_pool_manager`, `oracle_aggregator`, `governance_module`, `mock_usdc`,
and the shared `sentinel_types` crate. Each contract reviewed in isolation,
then the cross-contract wiring (purchase, classification, settlement, claim,
withdrawal-queue, settlement-barrier, and TTL flows).

**Method:** manual review, contract-by-contract then flow-by-flow.
Architecture documents (`spec/architecture.md`, `spec/simple_architecture.md`)
and the complete audit history (`audits/`, `audits/remediations/`,
`spec/audit.md`) were reviewed first. Findings already fixed, deferred, or
accepted (accepted-risk / won't-fix / by-design) in prior rounds are
**excluded** unless the underlying code materially changed. This codebase has
been through four audit rounds; the remediation quality is high and the
new-finding surface is correspondingly small.

---

## Section 1 — Security Findings

### Medium

#### M-01. `evict_missing_flight` permanently strands vault collateral, pool premiums, and a pool active-list slot (cross-cutting: OracleAggregator ↔ RiskVault ↔ FlightPoolManager)

- **Location:** `oracle_aggregator/src/admin.rs` (`evict_missing_flight`);
  consequence lands in `risk_vault/src/capital.rs` (`decrease_locked`) and
  `flight_pool_manager/src/storage.rs` (`prune_active_list`).
- **Description:** Eviction is the documented terminal escape hatch for an
  active-list entry whose `FlightData` archived. The 2026-07-11 fix (CF5-M02)
  made eviction release the vault's settlement-barrier count via
  `outcome_pending`, but eviction remains terminal **only on the oracle
  side**. Every flight in the oracle's active list was registered by a
  purchase, so it necessarily has ≥ 1 buyer, `payoff × buyer_count` of locked
  vault collateral, and `premium × buyer_count` escrowed in the pool. After
  eviction the flight is permanently outside keeper enumeration
  (re-registration does not re-add it, and restoring the archived
  `FlightData` afterward does not either), and `decrease_locked` is invoked
  **only** from `execute_settlements` — there is no other release path.
  Consequently: (a) the flight's locked collateral is stuck forever,
  permanently reducing the vault's free capital, so the tail of LP capital
  can never be withdrawn; (b) the pool bucket stays `Active` forever, so its
  premiums can be neither settled to the vault nor swept to
  `RecoveredBalance`; (c) its `ActiveFlightList` slot in the pool leaks (the
  pool, unlike the oracle, has no eviction function), consuming the capped
  list permanently. The function's documented safe-use condition — "the
  flight needs no further on-chain resolution" — is therefore unsatisfiable
  for any evictable flight: every one still has collateral riding on it.
  Prior rounds accepted that eviction removes the flight from enumeration,
  but the permanent fund-lockup and pool-slot leak were not enumerated as
  accepted consequences.
- **Remediation direction:** either (1) document that eviction must never be
  used while a flight has outstanding buyers — i.e., restore-and-settle is
  not just preferred but the only fund-safe path; or (2) design a matching
  owner-gated reconciliation for the other two contracts (e.g., a follow-up
  the controller can execute to release the flight's collateral and
  settle/sweep the pool bucket), with the same event-audit-trail treatment as
  `FlightEvicted`.

### Low

#### L-01. `recover_uncollected(Recredit)` has no upper-bound / backing-coverage guard symmetric to the H-01 lower bound (RiskVault)

- **Location:** `risk_vault/src/claims.rs` (`recover_uncollected`, `Recredit`
  arm).
- **Description:** The prior H-01 fix protects against owner *underpaying* an
  existing credit (`amount >= existing`), but there is no guard in the other
  direction: `Recredit` accepts any amount with no check against what the
  vault can actually cover. `ClaimableBalance` credits are supposed to
  satisfy the identity `raw_balance == TMA + Σ uncollected claimables`; a
  fat-fingered oversized recredit (e.g., a decimals slip when reconstructing
  amounts from event logs) silently creates an unbacked liability. The
  subsequent `collect()` then transfers assets that back outstanding shares,
  driving `raw_balance` below TMA — silent insolvency surfacing later as a
  failed `collect`/`withdraw`/`send_payout` for some unrelated party. This is
  within the trusted-owner model, but the codebase's own philosophy (H-01,
  C-02, `record_premium_income`'s balance check) is to add cheap on-chain
  guards against owner/caller *error*, and this is the one recovery path
  still missing one.
- **Remediation direction:** on `Recredit`, assert the credited amount is
  coverable by the vault's asset surplus over TMA
  (`asset.balance(vault) − TMA`, which is exactly the pool of asset available
  to satisfy claimable entries). This never blocks a legitimate restore of a
  previously-earned credit and turns a mis-keyed amount into a clean revert.

### Cross-cutting notes (accepted residuals, re-verified — no new findings)

Checked against the current code and confirmed to remain as previously
accepted/deferred; listed so the acceptance is a conscious, current decision:

- **Pre-publication information asymmetry around the settlement barrier.**
  The barrier engages when an outcome becomes public *on-chain*
  (`set_landed` / `set_cancelled` / void classification), not when it becomes
  knowable in the real world. LPs can still exit via direct `redeem` before a
  real-world delay is pushed on-chain, and can deposit ahead of predictable
  premium income — including the fully on-chain-computable void income
  between `date + 14d` and the classifier's next pass. This is the residual
  the deferred settlement-epoch model would address; magnitudes are bounded
  by oracle/classifier cadence.
- **Adverse selection on pre-departure-announced cancellations of
  never-purchased flights** (CAI-H01 residual, accepted as
  operator/monitoring duty): the executor tombstones only polled (i.e.,
  purchased) flights, so the practical window for buying a
  publicly-announced-cancelled, not-yet-purchased flight is bounded by the
  purchase-day-alignment gate, not by one cron cycle. The buyer whitelist
  (default off) is the on-chain lever if this is observed in practice.
- **The barrier has no owner reconciliation path** if `PendingOutcomes` ever
  desyncs upward (e.g., a mis-set `outcome_pending` on eviction, or oracle
  writes to a restored-but-evicted flight). An on-chain override was
  considered and rejected in CF5-L02; the residual recovery is contract
  upgrade.

No High-severity issues were found. Specifically re-verified as sound: the
TMA-basis share pricing and its running-total consistency in
`process_withdrawal_queue`; the solvency invariant (`locked ≤ TMA` holds
across all mutation paths, and delayed settlements strictly increase free
capital); purchase gates 3c/3d against buying into publicly-known outcomes;
the forward-only state machine and the balance of every `PendingOutcomes`
increment/decrement pair (including the tombstone path, which correctly never
enters the list or the counter); double-claim/double-sweep/double-settle
idempotency; and the classify delay math (`floor(delay/3600) ≥ h` is exactly
`delay ≥ h·3600` — no truncation bias).

---

## Section 2 — General Improvements

*(not security-relevant; no severity ranking)*

1. **Stale doc — `set_landed` plausibility floor.** `spec/architecture.md`
   (state-machine key rules and Oracle Trust Model item 6) still documents
   `actual_arrival_time >= estimated_arrival_time` as enforced, but
   `oracle_aggregator/src/lifecycle.rs` deliberately removed it (early
   arrivals are legitimate). Update the doc so operators don't rely on a
   check that no longer exists.
2. **Stale doc — settled-flight retention.** `spec/architecture.md` says
   `SETTLED_RETENTION_DAYS = 30`; code is 7
   (`oracle_aggregator/src/constants.rs`, changed in the NM-002 remediation).
   The same section also still describes missing `FlightData` as
   "evict-and-continue", whereas the pruner now retains such entries.
3. **Stale doc — controller deployment invocation.** The deploy example
   passes `--solvency_ratio` (no such constructor arg — it's fixed at 100 and
   owner-settable) and omits the required `owner` and `authorized_keeper`
   args of the actual `__constructor`.
4. **Doc inconsistency — upgradeability.** `spec/audit.md` I-03 records "no
   upgrade path" as an accepted design, while every contract ships an
   owner-gated `upgrade()` and later remediations lean on "emergency Wasm
   upgrade" as last-resort recovery. One of the two statements is stale;
   since upgrade is now the only recovery path for several accepted edge
   cases, the register should be corrected.
5. **Dead error variant.** `Controller::Error::MinLeadTimeExceedsMaximum =
   302` is defined but never raised (superseded by
   `MinLeadTimeLeavesNoBookingWindow = 314`). Remove or mark deprecated so
   client-side error tables don't carry an unreachable code.
6. **Instance-TTL renewal asymmetry on user-facing paths.**
   `RiskVault::collect` renews the instance TTL with an explicit "alongside
   every other user-facing path" rationale, but `FlightPoolManager::claim`
   does not. Heavy claim traffic during a cron lapse would not keep the pool
   instance alive. Trivial to align.
7. **Defensive-check asymmetry on settlement money movement.** The vault
   verifies premium receipt in `record_premium_income` (balance ≥ new TMA),
   but `settle_delayed`/`settle_cancelled` open a claim window without
   verifying the vault's payout actually arrived. The single immutable
   controller caller orders the calls correctly today, but mirroring the
   vault's cheap balance check (pool balance ≥ payoff × buyer_count before
   opening the window) extends the same defense-in-depth style to the pool.
8. **`route_status` mutates state while governance is paused.** The pause
   documentation says all governance write entry points halt, but
   `route_status` (a read entry point) performs writes — index self-heal and
   route/index/instance TTL renewals — regardless of pause. The writes are
   benign; either gate the self-heal on pause or (simpler) document the
   exception where the pause behavior is described.
9. **Governance admin set lives in Instance storage.** Each `Admin(Address)`
   key grows the single contract-instance ledger entry. Fine at the expected
   handful of admins, but unlike every other unbounded set in the system it
   has neither a cap nor a documented scale assumption — worth one sentence
   in the docs, given how consistently the other lists were capped.

---

*Per project convention, no audit-finding IDs are cited in code comments; the
remediation record lives in
[`remediations/20260711_claude_fable5_v2_remediation.md`](remediations/20260711_claude_fable5_v2_remediation.md).*
