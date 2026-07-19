# Claude Fable 5: Sentinel Soroban Findings Report

**Assessment date:** 19 July 2026

**Report version:** v1.0

**Assessment status:** Final

**Assessment type:** AI-Assisted Internal Security Review

**Auditor:** Claude Fable 5

---

## Assessment Information

| | |
| --- | --- |
| Project | Sentinel Protocol |
| Network | Stellar |
| Smart contract platform | Soroban |
| Programming language | Rust |
| Repository | https://github.com/SentinelFi/sentinel_soroban_v3/tree/main |
| Branch | `main` |
| Commit | `6fa82ac8568ff2833518a7872bb7f4e963019645` |
| Snapshot date | 2026-07-19 |

---

## Executive Summary

This assessment reviewed all Sentinel Protocol Soroban contracts in isolation and then in composition (cross-contract calls, shared state, and trust assumptions between them), after first reviewing the architecture documents (`spec/architecture.md`, `sequence_diagrams.md`) and the full prior-audit record: 30 reports across eight rounds (2026-05-31 through 2026-07-18), the 2026-07-19 Scout static-analysis report, and every remediation file in `audits/remediations/`. Findings already fixed, explicitly accepted, deferred, or rejected as false positives in prior rounds were excluded unless the underlying code materially changed since; where a finding below is adjacent to an accepted residual, the adjacency is stated explicitly and the finding is limited to what is new.

Particular attention was paid to the code introduced or modified in the five most recent commits (#81–#85): the route-ownership gate on `update_route_terms`, the claim/sweep boundary fix, the pool active-set reconciliation lever (`reconcile_settled_active_entry`), the deposit-escrow exclusion in the vault's premium-receipt and recredit guards, and the shared solvency-reserve guard. All were verified sound.

The codebase is in unusually strong shape. Access control is uniform and correct on every entry point (including the `Pausable`/`Ownable` trait impls); the forward-only oracle state machine, the pending-outcomes settlement barrier, the two-phase delayed LP pricing, and the solvency-reserve math are internally consistent and mutually reinforcing; rounding directions consistently favor the vault; and every collateral-locking state has a bounded terminal path. The `PendingOutcomes` counter was independently re-derived and balances across every path. Every candidate issue in this pass was subjected to an explicit false-positive review against the code and the remediation record before inclusion.

**Three Low severity issues were found.** No Critical, High, or Medium severity issues were found.

### Findings Summary

| ID | Severity | Title | Contracts |
| --- | --- | --- | --- |
| CF5D-L01 | Low | Bootstrap-phase LP queue-slot squatting is cheap in absolute terms, and the owner cannot raise the effective floor | risk_vault |
| CF5D-L02 | Low | Purchases remain live while the governance module alone is paused, and the pause blocks the route-disable lever | governance_module ↔ controller |
| CF5D-L03 | Low | `settle_evicted_flight` erases a possibly-known payout outcome with no on-chain cross-check against the flag used at eviction | controller ↔ oracle_aggregator |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 3 | 0 |

Non-security suggestions (unranked) are listed under [General Improvements](#general-improvements).

---

## Scope

### In Scope

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types` (shared types, TTL/timeout/solvency constants, paginated active set, upgrade helpers)

### Out of Scope

- Unit-test files, fuzz targets, `contracts/integration_tests` (consulted as evidence only)
- `contracts/mock_usdc` — testnet-only; permissionless mint previously accepted (ASF-03) and feature-gated (re-verified this pass)
- Frontend and off-chain executor services (referenced only where contract behavior depends on them)
- Compromise of owner, admin, keeper, or oracle credentials (standing accepted trust model); CF5D-L03 concerns the blast radius of an *honest-but-mistaken* owner transaction, which the codebase's own bounded-owner-setter philosophy treats as in-scope
- Everything recorded as deferred / won't-fix / accepted / by-design in `audits/remediations/` — notably: the ≤ 24 h sale-authorization staleness residual (CAI-H01 / C57-H01), the 14-day void-as-on-time outage trade-off and voided-premium forfeiture (AA-CT-03 / CAI-M01), the three pricing-delay-horizon residuals documented together in Known Limitations (oracle outage > 6 h; pre-landing delay foreknowledge, CF5C-M01; void-income predictability), the monolithic bounded queues and `TravelerFlights` index (AA-RV-03 / AA-CT-02), Sybil queue occupation in *relative* terms (AA-RV-01 — CF5D-L01 below is limited to the bootstrap absolute-cost corner), the no-exit-reservation design (CF5B-L02), the first-reader-wins route-index self-heal (CF5-L01), `force_set_oracle` + immediate unpause, surviving sale authorizations across oracle rotation (CF5C-L01 runbook), born-expired claim windows on late settlement (AA-FPM-02), the exactly-tight 180-day buyer-proof bound (CF5B-L01), the `evict_missing_flight` owner-asserted `outcome_pending` flag itself (CF5-M02 residual — CF5D-L03 below is limited to the unchecked *pairing* of the two recovery steps), batch/footprint sizing (worst-case prune and queue-credit shapes previously measured against live network limits, 2026-07-14), snapshot intra-day pinning, and single-key owner.

---

## Items Considered and Discarded as False Positives

In line with the assessment instructions, every candidate finding was re-verified against the code and the remediation record before inclusion. Items investigated and dropped, with the reason:

- **`prune_settled` dense-window resource wedge** (a 60-slot window in which most entries are simultaneously prunable requires ~123 footprint keys / ~62 writes) — verified already measured in the 2026-07-14 assessment against live network limits (400 footprint keys, 200 reads/writes); fits with ample margin. Deployment-simulation monitoring remains the accepted control for mutable network settings.
- **`reconcile_settled_active_entry` permissionless abuse** (new in #83) — verified safe: it removes an active-set entry only when the bucket's own `FlightConfig` proves `status != Active`; settled buckets are never re-added to the set (`register_flight` early-returns on an existing key), so it can never strip a live flight from keeper enumeration.
- **Route-ownership gate and claim/sweep boundary** (new in #84) — verified correct: `update_route_terms` now applies the same uniqueness-index ownership check as `route_status`/`whitelist_route`/`enable_route`; `claim` (`now >= expiry` rejects) and `sweep_expired` (`now < expiry` rejects) are exact complements with no dead or overlapping ledger second.
- **Deposit-escrow masking of the premium-receipt guard** — verified fixed by #82: both `record_premium_income` and the Recredit surplus bound subtract `sum_escrowed_deposits`; the remaining claimable-residual looseness is the documented floor semantics.
- **Withdrawal partial-fill rounding and FIFO** — re-verified: floor–floor round trip strictly bounds `fillable_shares < request.shares` and `assets_part ≤ remaining_free`; the running-TMA pricing keeps every request in a pass at a consistent share price; `remaining_free` and `tma` decrement in lockstep so the reserve is never invaded.
- **Cancel-path pricing optionality on either queue** — re-verified none exists: cancellation returns escrow at face value; a queued request is always priced post-outcome.
- **`PendingOutcomes` balance** — re-derived across every edge including both void increments at classification, the pre-registration tombstone (deliberately uncounted, never enumerable, unreachable by classification since tombstones are never active-listed), and eviction.
- **Mass-purchase capital-lockup griefing** — priced by design: premiums are forfeited to LPs on on-time/void settlement, the ratio term-limit forces vault-scale payoffs to carry vault-scale premiums, and the solvency gate bounds total lock.
- **Secondary-market share transfers during a pending-outcome window** — not a protocol vulnerability: the barrier prevents extraction from the vault/other LPs at stale NAV; a voluntary share sale transfers priced risk to a willing counterparty, standard for any transferable vault share.
- **Governance-paused `route_status` protective writes** — grant no privilege; deliberate and documented (the pause halts administrative entry points only). The *operational* asymmetry it creates is reported separately as CF5D-L02, which is about runbook hazard, not the write exemption.

---

## Security Findings

Severity definitions follow the prior reports: **High** — direct loss or freezing of user funds, or protocol-wide authorization failure; **Medium** — conditional loss, value mis-attribution, or denial of core functionality under plausible conditions; **Low** — edge-case, corner-condition, or defense-in-depth gaps with bounded impact or demanding preconditions.

### Low

#### CF5D-L01 — Bootstrap-phase LP queue-slot squatting is cheap in absolute terms, and the owner cannot raise the effective floor

**Contracts/locations:** `risk_vault` — `claims.rs:64` and `claims.rs:215` (effective-minimum computation), `constants.rs:104` (`MIN_REQUEST_FLOOR_CAP_ABS`).

**Adjacency:** this is a residual *quantification* of the accepted Sybil-occupation design (AA-RV-01) as most recently hardened by CF5C-L02; the mechanism is unchanged and is not re-litigated. What is new is that the acceptance rationale — "pinning the queue full escrows a material fraction of managed assets" — degenerates in absolute terms during bootstrap, and that the owner's configuration lever is structurally disabled during exactly that phase.

**Description.** The queue-slot pricing formula is `effective_min = clamp(configured_min, floor_cap × occupancy / cap, floor_cap)` with `floor_cap = max(TMA/2500, 1 token)`. The absolute one-token term (added by CF5C-L02 for exactly this phase) makes bootstrap slots *non-free*, but not *expensive*: with TMA ≈ 0, filling the entire 100-slot deposit queue costs ≈ Σᵢ(i/100 tokens) ≈ **50 tokens of fully-refundable escrow** (~$50 for a 7-decimal USDC), and the 150-slot withdrawal queue ≈ 75 tokens once the attacker holds any shares. Because the configured minimum is clamped *down* to `floor_cap` (a deliberate anti-lockout measure), the owner cannot raise the effective floor above one token while TMA is small — even a configured minimum of 1,000 USDC binds at one token. A squatter who cancels each request before it matures (the 6 h pricing delay) and immediately re-submits sustains a full queue indefinitely for transaction fees only, rejecting all legitimate `request_deposit` calls (`DepositQueueFull`) while the vault is trying to raise its initial capital. The 20-per-address cap is trivially sybil-split (acknowledged in-code). No funds are at risk; impact is a temporary entry-liveness DoS confined to the launch/severe-drawdown phase, self-resolving as TMA grows (`TMA/2500` dominates from ~2,500 tokens of TMA).

**Remediation direction (documentation-level).** Either (a) treat it operationally — seed the vault with an owner/genesis deposit before opening public entry, so the value-relative term immediately dominates the one-token floor (a one-line addition to the deployment runbook in `spec/architecture.md` / `contracts/deploy_order.md`); or (b) let the owner-configured minimum bind un-clamped (or clamp against a constant rather than `TMA/2500`) while TMA is below a small threshold, restoring the owner's lever during bootstrap only.

#### CF5D-L02 — Purchases remain live while the governance module alone is paused, and the pause blocks the route-disable lever

**Contracts/locations:** `governance_module` — `queries.rs:33` (`route_status` un-gated by design), `routes.rs:176` (`disable_route` is `when_not_paused`); `controller` — `purchase.rs:68`.

**Description.** This is a cross-contract operational-hazard finding rather than a code defect; it emerges only from the composition of two individually-correct, individually-documented decisions. Pausing the governance module halts only its *administrative* writes; `route_status` deliberately keeps serving `Active` (with its protective TTL side effects), so `Controller.buy_insurance` continues admitting purchases on every listed route while governance is paused. Simultaneously, the pause disables `disable_route`/`remove_route`. During a governance-scoped incident — say, a mispriced or wrongly-listed route discovered mid-incident — the operator's instinctive combination "pause governance + disable the bad route" is therefore internally contradictory: the pause blocks the disable, and sales continue. The correct mid-incident levers (pause the *Controller* to halt all purchases, or the oracle's pause-exempt `close_sale` to kill insurability per flight) live in different contracts than the one the operator just paused, the interaction is not spelled out in any one place, and there is no on-chain signal that the intuitive action produced the opposite of its intent. The spec's "pause all five contracts together" rule covers the safe path, but this specific asymmetry is its one silent corner.

**Remediation direction (documentation-level).** Add an explicit warning to the incident runbook and to the governance module's `pause` doc comment: "pausing this contract does NOT stop sales on existing routes and DOES block `disable_route`; to stop sales, pause the Controller (all purchases) or use the oracle's `close_sale` (per flight)." Optionally reconsider making `disable_route` pause-exempt — it is revocation-shaped, matching the existing `remove_admin` / `close_sale` / `remove_whitelisted_buyer` exemption convention (the in-code rationale for keeping it gated is acknowledged; the choice is a team call, the warning is the minimum).

#### CF5D-L03 — `settle_evicted_flight` erases a possibly-known payout outcome with no on-chain cross-check against the flag used at eviction

**Contracts/locations:** `controller` — `settle.rs:565` (`settle_evicted_flight`); `oracle_aggregator` — `admin.rs:105` (`evict_missing_flight`).

**Adjacency:** the owner-asserted `outcome_pending` flag itself is an accepted residual (CF5-M02, reaffirmed 2026-07-14). This finding is limited to what is new: the two steps of the recovery are *independently* callable and nothing ties the second step to the first having happened for the same flight with a consistent flag.

**Description.** The two-step recovery (`evict_missing_flight(outcome_pending)` → `settle_evicted_flight`) is owner-only. `settle_evicted_flight` verifies only "no `FlightData` row + not oracle-listed + pool bucket Active" — conditions that do not prove an eviction ever occurred for this flight, nor which `outcome_pending` value it carried. An eviction performed with `outcome_pending = true` for a flight whose public outcome was `ToBeSettledDelayed`/`ToBeSettledCancelled` is followed by a reconciliation that settles with void/on-time economics (premiums to vault, buyers denied their payout) with no event linking the eviction record to the reconciliation, and no on-chain check that the pairing is consistent. Both calls are owner-gated, so this is inside the trust model; the concern is blast radius — one wrong or mis-sequenced owner transaction silently converts owed payouts into vault income, reconstructable only after the fact from the event trail.

**Remediation direction (documentation-level).** Require, in the recovery runbook (`evict_missing_flight` and `settle_evicted_flight` doc comments plus the spec's function-reference table), that the operator quote the corresponding `FlightEvicted` event — and its `outcome_pending` flag — in the change record before running `settle_evicted_flight`, and state explicitly that a `true` flag on a flight whose last public status was Delayed/Cancelled means buyers are being denied a known payout. A code-level option, if the area is ever revisited: have eviction write a small persistent marker that `settle_evicted_flight` consumes, making the *pairing* machine-checked (this is a smaller ask than the previously-rejected per-flight counted marker for the flag itself).

---

## Cross-Cutting Observations (no new vulnerabilities)

These emerge only from contract interactions; none is exploitable, but they are the load-bearing seams reviewers and operators should keep watching:

1. **The vault↔oracle identity invariant remains the system's most fragile wiring assumption.** The settlement barrier reads `PendingOutcomes` from the *vault's* oracle pointer while outcomes accrue on the *controller's* immutable pointer. The code handles this as well as on-chain code can (constructor wiring, rotation guards, `forced` flag, matching `get_oracle` getters on both sides) — but it remains a deployment-verification obligation with silent-failure semantics if violated. Verified consistent in the current code; keep `controller.get_oracle() == vault.get_oracle()` in the deploy checklist and monitoring.
2. **Pause switches interlock across contracts.** Keeper loops call pause-gated entry points on three contracts; pausing any one of pool/oracle/vault halts settlement wholesale and pins the LP barrier engaged until the set is unpaused together. CF5D-L02 is the one asymmetric corner of the documented pause-as-a-set rule.
3. **The `PendingOutcomes` counter balances across every path** (landed/cancelled increments, both timeout-void increments at classification, settlement decrement, eviction decrement via the owner flag). Independently re-derived this pass; no unbalanced edge found, including the pre-registration tombstone path, which correctly bypasses both the counter and the active set.
4. **Pool↔vault↔controller wiring is only partially self-verifiable on-chain** — see General Improvement 2.

---

## General Improvements

Non-security suggestions; unranked.

1. **Unify the storage-archival narrative across the codebase.** Comments and defensive branches split between two incompatible models: older paths assume an archived persistent entry reads as `None` (`active_set` page-miss handling, `MissingFlightData` in `prune_settled`, `evict_missing_flight`'s stated purpose), while newer code and the team's own 2026-07-14 verified disposition assume Protocol-23 restore-on-access ("restored with its original value, never read as absent" — the buyer-whitelist redesign is built on exactly this). Under the restore model, several recovery paths (notably `evict_missing_flight` → `settle_evicted_flight` for *archived* rows) are likely unreachable for their stated purpose. The tracked testnet archival-semantics experiment (CF5-M01 ops backlog) should be completed before mainnet, and every "archived reads as absent" comment either corrected or annotated as a defense-in-depth branch for a model that may not apply. Misleading comments in recovery code are an incident-response hazard even when the code itself fails safe.
2. **Add the missing wiring getters on the Controller** (`get_risk_vault`, `get_governance`, `get_asset_token`). The `get_oracle` getter exists specifically so the vault↔oracle invariant is checkable on-chain; the analogous invariants (controller and pool must agree on the vault; controller, pool, and vault must agree on the asset token — a mismatch bricks settlement via the `PremiumNotReceived` guard) currently require trusting the deployment record. Cheap, and symmetric with the established precedent.
3. **Whitelist-deadline slides are invisible to indexers.** `touch_buyer_whitelisted` rewrites the approval deadline with no event, and skips rewrites inside the 10-day refresh interval. Off-chain dormancy monitors watching only `buyer_whitelisted` events will compute stale deadlines and false-alarm on active buyers; correct monitoring must join `InsuranceBought` events *and* replicate the refresh-interval skip. Either emit a lightweight deadline-slide event or document the exact reconstruction rule where the indexer requirements live.
4. **`MIN_REQUEST_FLOOR_CAP_ABS` hardcodes a 7-decimal asset.** The in-code comment already says "revisit at wiring time"; consider deriving it from `asset.decimals()` at construction (one call, stored once) or promoting the comment into the deployment checklist in `deploy_order.md`, so a 6- or 9-decimal settlement asset doesn't silently shift the floor by 10×.
5. **Spec drift nit in `architecture.md`:** the sweep flow still reads "panic if `timestamp() <= claim_expiry`" while the code (correctly, after the #84 boundary fix) uses strict `<` as the exact complement of `claim`'s `>=`; worth syncing so the documented boundary matches the audited one. The Known Limitations section is otherwise impressively current.
6. **Minor duplication in the vault request paths:** the per-address count scan and the effective-minimum computation are duplicated between `request_deposit` and `request_withdrawal` (~25 lines each). Extracting a shared helper would keep the two queues' admission policies from drifting in future edits — the same "one definition" argument the codebase already applies to `sentinel_types::solvency` and `active_set`.
