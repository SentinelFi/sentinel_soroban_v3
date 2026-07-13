# Claude Fable 5: Sentinel Soroban Findings Report

**Assessment date:** 12 July 2026

**Report version:** v1.1

**Assessment status:** Final (revised after external validation)

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
| Commit | `0e83ad6340864eb6ab51d0817a9a6982f0ab21b0` |
| Snapshot date | 2026-07-12 |

---

## Executive Summary

This assessment reviewed all six Sentinel Protocol Soroban contracts in isolation and then in composition (cross-contract calls, shared state, and trust assumptions between them), after first reviewing the architecture documents (`spec/architecture.md`, `spec/simple_architecture.md`, `sequence_diagrams.md`) and the full prior-audit record: 23 reports across four rounds (2026-05-31, 2026-06-25, 2026-07-04, 2026-07-11) plus every remediation file in `audits/remediations/`. Findings already fixed, explicitly accepted, deferred, or rejected as false positives in prior rounds were excluded from this report unless the underlying code materially changed since.

The codebase is in very strong shape and visibly hardened by the prior rounds.

**No High or Medium severity issues were found.** After external validation (v1.1), the report stands at **two Low findings and one Informational finding**; one further item was reclassified as a design consideration and one was withdrawn.

### Findings Summary

| ID | Severity (v1.1) | Title | Contracts |
| --- | --- | --- | --- |
| CF5B-L04 | Low | `RiskVault::set_oracle` rotation silently discards in-flight `PendingOutcomes` barrier state | risk_vault ↔ oracle_aggregator |
| CF5B-L05 | Low | Pausing the oracle blocks its own protective writes (`close_sale`, `set_cancelled`) while live sale windows keep authorizing purchases | oracle_aggregator ↔ controller |
| CF5B-L01 | Informational (downgraded from Low) | Buyer-proof lifetime compile-time assert checks the wrong constant pair; real bound is zero-slack and cadence-sensitive | controller ↔ flight_pool_manager |
| CF5B-L02 | Design consideration (reclassified) | Purchases compete with queued withdrawals for freed capital — reservation policy unspecified | controller ↔ risk_vault |
| CF5B-L03 | Withdrawn | Pool active-set removal on an archived page — trigger sequence unreachable under Protocol 23 archival semantics | flight_pool_manager (sentinel_types::active_set) |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 2 | 1 |

Non-security suggestions (unranked) are listed under [General Improvements](#general-improvements).

---

## Scope

### In Scope

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types` (shared types, TTL/timeout constants, paginated active set, upgrade helpers)

### Out of Scope

- Unit-test files, fuzz targets, `contracts/integration_tests` (consulted as evidence only)
- `contracts/mock_usdc` — testnet-only; permissionless mint previously accepted (ASF-03) and feature-gated
- Frontend and off-chain executor services (referenced only where contract behavior depends on them)
- Compromise of owner, admin, keeper, or oracle credentials (standing accepted trust model)
- Everything recorded as deferred / won't-fix / accepted in `audits/remediations/` — notably: the trusted-oracle assumption (AA-OA-03), the withdrawal-queue keyed-storage migration and its Sybil caps (AA-RV-03/AA-RV-01), the settlement-barrier liveness trade-offs (NM-001-0704, CF5-L02), the canonical flight-registry redesign (AA-CT-01 / CAI-H01), the 14-day void-as-on-time outage trade-off (AA-CT-03 / CAI-M01), the ≤ 24 h sale-authorization staleness window (CAI-H01-0711 residual), the Soroban archival-semantics question (CF5-M01) and its dependents (CF5-M02, CF5-L01), single-key owner, and `mock_usdc` mint.

Where a finding below touches an accepted item, the adjacency is stated explicitly and the finding is limited to what is *new* relative to the accepted residual.

---

## Security Findings

Severity definitions follow the prior reports: **High** — direct loss or freezing of user funds, or protocol-wide authorization failure; **Medium** — conditional loss, value mis-attribution, or denial of core functionality under plausible conditions; **Low** — edge-case, corner-condition, or defense-in-depth gaps with bounded impact or demanding preconditions.

### Low

---

#### CF5B-L04 — `RiskVault::set_oracle` rotation silently discards in-flight `PendingOutcomes` barrier state

**Contracts / locations:**
- `contracts/risk_vault/src/admin.rs:70-75` (`set_oracle`)
- `contracts/oracle_aggregator/src/storage.rs:89-111` (`PendingOutcomes` counter)

**Description.** The vault's settlement barrier is only as correct as the counter of the oracle it points at. `set_oracle` (owner-only, kept rotatable for the redeploy-the-oracle contingency) swaps the barrier target with no reconciliation: a freshly deployed OracleAggregator starts with `PendingOutcomes = 0`, so if the rotation happens while the *old* oracle still has outcomes public-but-unsettled — which is precisely the situation in which an oracle emergency plausibly occurs — the barrier opens immediately and LPs can deposit/withdraw/redeem at the stale, pre-settlement share price. That is exactly the value transfer between LPs the barrier exists to prevent, and it needs no attacker sophistication beyond watching for the `oracle_set` event during an incident.

The counter itself cannot be migrated (it lives in the old oracle's instance storage and is not owner-writable), and the new oracle cannot learn of settlements that will land against the old one's flights.

**Impact.** Stale-price LP entry/exit during an owner-driven rotation window — a redistribution among LPs proportional to the unrecognized PnL, bounded by the pending flights' magnitude. Requires an owner action, so this is an admin-procedure hazard (same class as the remediated CF5-M02 eviction-flag hazard) rather than an external attack.

**Remediation direction.** Cheapest: have `set_oracle` refuse while the *current* oracle reports `has_pending_outcomes()`, with an explicit `force` mode only for the case where the old oracle is truly unreachable — the very contingency the rotation exists for — recording that choice on the event (mirroring how `evict_missing_flight` handles its judgment call) and keeping the vault paused until the old oracle's pending PnL is reconciled. At minimum, document the invariant in the runbook: rotate only after the old oracle's pending count reads zero, or pause the vault across the rotation.

---

#### CF5B-L05 — Pausing the oracle blocks its own protective writes while live sale windows keep authorizing purchases

**Contracts / locations:**
- `contracts/oracle_aggregator/src/lifecycle.rs:85-96` (`close_sale`, `#[when_not_paused]`), `:202-246` (`set_cancelled`, `#[when_not_paused]`)
- `contracts/controller/src/purchase.rs:125-127` (purchase gate consumes `is_sale_open`)

**Description.** Sale authorizations live in temporary storage and remain readable regardless of the oracle's pause state; `is_sale_open` is a query and `buy_insurance` runs on the controller. Both writes that *revoke* insurability — `close_sale` and `set_cancelled` (which force-removes the sale auth in the same transaction) — are pause-gated. Pausing only the oracle therefore produces an inverted protection: new attestations stop (good), but every already-open window (validity up to `SALE_AUTH_MAX_VALIDITY_SECS` = 24 h) stays live and *cannot be revoked on-chain*, while purchases through the unpaused controller continue. If a flight with a live window is publicly cancelled during that interval, each purchase into it is a deterministic `payoff − premium` claim once the pause lifts and the cancellation/settlement pipeline runs.

The ≤ 24 h purchasable-after-public-cancellation exposure is an accepted residual of the sale-authorization design (CAI-H01 residual, 2026-07-11) — *for executor outages*. The new observation is that the pause switch, an incident tool, mechanically disables the two defenses that close that window, so an operator who pauses the oracle without also pausing the controller has extended the accepted exposure rather than contained it. The governance module documents the opposite convention for exactly this reason (`route_status`'s protective writes are deliberately pause-exempt).

**Impact.** During a partial-pause incident, up to 24 h of deterministic-payout purchases against a publicly cancelled flight, bounded per-policy by the governance term limits and per-flight by the solvency gate. Requires an incident plus operator error (pausing oracle but not controller).

**Remediation direction.** Exempt `close_sale` from the pause gate (it only removes authorization — strictly protective, no privilege granted), and consider the same for the sale-auth-removal portion of `set_cancelled`; alternatively document a hard runbook rule that the controller is always paused before or together with the oracle. The one-line comment convention already used on `claim` and `route_status` fits here.

---

### Informational

---

#### CF5B-L01 — Buyer-proof lifetime compile-time assert checks the wrong constant pair; the real bound is zero-slack and cadence-sensitive

**Contracts / locations:**
- `contracts/controller/src/constants.rs:87-90` (compile-time assert)
- `contracts/flight_pool_manager/src/constants.rs:17,26` (`BUYER_TTL_LEDGERS`, `MAX_CLAIM_DEADLINE_AFTER_DATE_SECS`)
- `contracts/flight_pool_manager/src/settle.rs:135-138` (claim-deadline cap)
- `contracts/governance_module/src/constants.rs:18,24` (retirement marker, same root cause)

**Description.** Buyer policy proofs (`PoolKey::Buyer`) are written once at purchase with `BUYER_TTL_LEDGERS = 3,110,400` — the network-maximum persistent TTL, equal to 180 days *only at exactly 5 s/ledger* — and are never re-extended on-chain. The controller carries a compile-time assert intended to guarantee a proof outlives any claim deadline:

```
MAX_BOOK_AHEAD_SECS + MAX_CLAIM_EXPIRY_WINDOW_SECS <= BUYER_KEY_TTL_SECS   // 90d + 60d ≤ 180d
```

This checks the wrong pair of constants. The claim deadline is *not* bounded by `settle_time + MAX_CLAIM_EXPIRY_WINDOW_SECS` with `settle_time ≤ date`; settlement routinely happens after `date`, and the pool explicitly supports settlement as late as ~90 days after it (`SETTLEMENT_GRACE_SECS`). The *actual* binding bound is the pool-side cap `claim_expiry ≤ date + MAX_CLAIM_DEADLINE_AFTER_DATE_SECS` (90 days), giving a worst case of

```
MAX_BOOK_AHEAD_SECS + MAX_CLAIM_DEADLINE_AFTER_DATE_SECS = 90d + 90d = 180d
```

— exactly equal to the proof TTL, with **zero slack**, and only under the 5 s/ledger assumption. Two consequences:

1. **The guard would not catch the hazard it exists to prevent.** Raising `MAX_CLAIM_DEADLINE_AFTER_DATE_SECS` (a pool-crate constant the controller assert never references) to any value above 90 days silently breaks the invariant while the assert keeps passing, because the assert's 150-day sum still clears 180. The 30-day margin the assert appears to provide does not exist on the real path.
2. **The real bound is cadence-sensitive with no buffer.** Every other deadline-derived TTL in the system carries `TTL_BUFFER_LEDGERS` (~30 days) of slack, and the sale-auth TTL comment explicitly acknowledges ledger-time drift — but the buyer proof cannot carry a buffer (it is already at the network max) and the claim-deadline cap is set exactly at the boundary. If mainnet ledger cadence ever runs sustainably below 5 s/ledger (faster ledgers are a recurring Stellar roadmap topic), a policy bought at the 90-day horizon whose flight settles late enough for the cap to bind can have its proof archive *before* the claim deadline. The governance retirement marker has the same shape with ~5 % slack (168 d of ledgers guarding a 160-day reservation).

**Correction (v1.1) — why proof expiry is not a claim-loss path.** v1.0 described the expired proof surfacing inside `claim` as `NoPolicy`, with `sweep_expired` then routing the payoff to the protocol's recovered balance. That sequence is inconsistent with Protocol 23+ state-archival semantics, which govern the target network (the workspace pins `soroban-sdk 25.3.1`): an archived Persistent entry named in the transaction footprint is automatically restored before the host function executes (RPC simulation supplies the restore list), and if the entry is not restored the transaction fails before contract execution. Contract logic therefore never observes an archived buyer proof as an ordinary missing entry, and TTL expiry cannot silently convert a valid claim into a sweepable payoff. The residual effect of expiry is operational — restoration fees and an extra step for transactions built outside the normal simulation flow. Reference: <https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival>

**Impact.** Maintenance hazard, not a fund-safety issue: the compile-time assert does not guard the real bound, so a future change to the pool-side constant could silently void the intended invariant while the assert keeps passing, and the zero-slack cadence assumption is undocumented. No claim-loss path exists under current protocol semantics; downgraded to Informational accordingly.

**Remediation direction.** (a) Re-state the compile-time assert on the true bound — `MAX_BOOK_AHEAD_SECS + MAX_CLAIM_DEADLINE_AFTER_DATE_SECS ≤ BUYER_KEY_TTL_SECS` — importing or mirroring the pool constant so a change on either side trips it. (b) Introduce explicit slack by lowering `MAX_CLAIM_DEADLINE_AFTER_DATE_SECS` (e.g. to 60 days) or `MAX_BOOK_AHEAD_SECS`, so the invariant holds down to a documented minimum cadence. (c) Document the cadence assumption. Note that the current TTL cron extends only *instance* TTLs — key-level extension of buyer entries is an explicitly planned executor improvement ("Improvement #6" in `executor/centralized_cron/src/ttl_extender.ts`), not implemented today; buyer keys are reconstructable off-chain from `BuyerAdded` events when that job is built, and the pool constants comment ("No re-extension needed") should be reconciled with that plan.

---

### Reclassified and Withdrawn (v1.1)

---

#### CF5B-L02 — Purchases compete with queued withdrawals for freed capital; no reservation or priority for the exit queue *(reclassified as design consideration in v1.1)*

**Contracts / locations:**
- `contracts/controller/src/purchase.rs:181-197` (solvency check)
- `contracts/risk_vault/src/capital.rs:109-312` (`process_withdrawal_queue`)

**Disposition (v1.1).** External validation correctly observes that no documented invariant grants queued LPs priority over future policy admission: queued withdrawals are deliberately valued and funded only when `process_withdrawal_queue` runs, accepted requests retain FIFO priority among themselves, and new underwriting consuming free capital is normal protocol activity. Absent a specified reservation policy, sustained purchase demand delaying exits is a liquidity characteristic of the design rather than a contract bug. Reclassified from Low to a design consideration: if product requirements intend withdrawal requests to reserve future liquidity ahead of new underwriting, that rule should be specified and implemented explicitly — the remediation options below remain the implementation menu for that choice. The original description is retained for the design record.

**Description.** `buy_insurance` admits a policy whenever `TMA ≥ ceil((locked + payoff) × solvency_ratio / 100)`, with no reference to the withdrawal queue. `process_withdrawal_queue` services requests strictly from *free* capital (`TMA − locked`). These two consumers of free capital are unsynchronized: capital freed by a settlement can be re-locked by new purchases in the interval before the keeper's next queue-maintenance pass (nominal cadence ~5 minutes, but any gap suffices), and nothing entitles the queue head to capital that was free at any earlier instant.

The accepted NM-002 residual (2026-07-11) covers the passive case — "if free capital is zero the queue waits (capital-availability fact, not liveness defect)". The new observation is the *active* one: purchase flow continuously consumes the very capital the queue is waiting for, and at the minimum solvency ratio (100 %) purchases may lock TMA in full. Under sustained purchase demand — organic or deliberate — queued LPs are serviced only from the premium yield of on-time settlements rather than from principal, stretching exits arbitrarily. A deliberate griefing campaign is expensive (each policy costs a premium that is forfeited on an on-time outcome) but is not otherwise bounded.

**Impact.** Fairness/liveness degradation for exiting underwriters: queued withdrawals — the *only* exit path once the queue is non-empty, since direct `withdraw`/`redeem` are blocked while it is — can be deferred indefinitely while the vault remains fully solvent. No loss of funds; shares remain escrowed at full value.

**Remediation direction.** Options, in increasing order of intrusiveness: (a) document the behavior and add queue-age observability so operators can raise `solvency_ratio` (which structurally reserves a free-capital buffer) when the queue backs up; (b) have `buy_insurance` tighten its solvency requirement by the asset value of the queue head (or the whole queue) so purchases cannot consume capital the queue already covers; (c) as part of the already-deferred keyed-queue migration (AA-RV-03), reserve freed capital for the queue at `decrease_locked` time. Option (b) is a two-line read of vault state on an already cross-contract-heavy path and preserves strict FIFO end-to-end.

---

#### CF5B-L03 — Pool active-set removal on an archived page *(withdrawn in v1.1)*

**Contracts / locations:**
- `contracts/flight_pool_manager/src/storage.rs:58-60` (`prune_active_list` ignores `remove()`'s return)
- `contracts/sentinel_types/src/active_set.rs:206-289` (`remove` returns `false` on unreadable pages)
- Contrast: `contracts/oracle_aggregator/src/lifecycle.rs:401` (`prune_settled`, re-callable) and `contracts/oracle_aggregator/src/admin.rs:88` (`evict_missing_flight`)

**Original claim (v1.0).** `active_set::remove` returns `false` when the entry's page — or the tail page it must swap from — cannot be read after archival. The pool has exactly one removal opportunity per flight (`prune_active_list` inside `settle_on_time` / `settle_with_claim_window`, which discards the boolean); if that attempt failed while the bucket committed `Settled*`, the entry would be unremovable for the life of the contract, since the pool exposes no equivalent of the oracle's re-callable `prune_settled` or owner-gated `evict_missing_flight`.

**Why it is withdrawn.** The trigger sequence is unreachable through archival under Protocol 23+ semantics (the workspace pins `soroban-sdk 25.3.1`): a Persistent page named in the transaction footprint is either restored before execution — so `remove` reads it normally — or the transaction fails before contract execution, so the `Settled*` status cannot commit alongside the failed removal. An archived entry is never exposed to contract logic as an ordinary `None`. v1.0 itself conditioned reachability on the then-open CF5-M01 archival-semantics question; external validation resolves that question against reachability. A genuinely absent page would require code-driven deletion or state corruption, and no path creating that state was demonstrated. Reference: <https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival>

**Residual note.** A pool-side `prune_settled`-style sweep or owner eviction remains reasonable defense in depth against non-archival state corruption and would remove the recovery-surface asymmetry with the oracle — a hardening option, not a security finding.

---

### Cross-cutting observations

Both confirmed findings — and the informational item — exist only in the seams between contracts, not in any contract alone:

- **CF5B-L04** is a state-continuity gap across an *instance* boundary (old oracle vs. new oracle) rather than a contract boundary; the barrier reads whichever instance the vault points at and both instances behave correctly in isolation.
- **CF5B-L05** is a pause-topology issue: each contract's pause gating is individually defensible, but the composition (oracle paused + controller live + temporary-storage reads unaffected by pause) inverts the intended protection.
- **CF5B-L01** (informational) is a two-crate constants problem: the controller asserts an invariant whose binding term lives in the pool crate, and the mirrored `BUYER_KEY_TTL_SECS` constant hides the mismatch. Single-contract review of either crate shows a locally sensible bound.

Additionally, two systemic observations (both anchored to accepted or now-resolved items, no severity assigned): the entire TTL/timeout arithmetic shares a single `LEDGERS_PER_SECOND` assumption in `sentinel_types::ttl`, so a network cadence change moves *every* wall-time guarantee at once, with the buyer proof (CF5B-L01) merely the only zero-slack instance; and the CF5-M01 archival-semantics question, on which several defensive branches hinge (`None` page reads, `has_flight_data` false paths, `evict_missing_flight` reachability), is resolved by Protocol 23 documentation — archived Persistent entries are restored within the transaction footprint or the transaction fails before execution — making those branches defense in depth against code-driven state loss rather than archival handlers. The low-cost testnet experiment recorded in the ops backlog remains worthwhile as an empirical confirmation, but is no longer a blocking uncertainty for any finding in this report.

---

## General Improvements

Non-security suggestions; no severity ranking.

1. **Controller wiring is rotation-asymmetric.** The vault can rotate its oracle and the controller its keeper, but the controller's five wired addresses (governance, vault, oracle, pool, asset) are constructor-fixed with no setters — any dependency redeploy forces a controller Wasm upgrade (and the oracle/pool/vault `set_controller` being one-time means a *controller* redeploy forces upgrades of all three). This is defensible as attack-surface minimization, but the asymmetry with `RiskVault::set_oracle` is undocumented; either document the redeploy-implies-upgrade matrix in `deploy_order.md`/`upgrade.md` or add owner-gated rotation with the same event discipline as `oracle_set`.

2. **Cross-crate constant duplication.** `MAX_ACTIVE_FLIGHTS = 100_000` is defined independently in the oracle and pool crates ("Matches the other cap" by comment only), `SECONDS_PER_DAY` appears in three crates, and `BUYER_KEY_TTL_SECS` is a hand-mirrored copy of the pool's `BUYER_TTL_LEDGERS` (its comment acknowledges the mirror). These are exactly the drift hazards `sentinel_types` exists to eliminate — moving them next to `ttl`/`timeouts` would also enable the corrected CF5B-L01 assert to reference the real constants instead of mirrors.

3. **Pause-gating rationale is documented inconsistently.** The deliberate exemptions (`claim`, `route_status`, `recover_uncollected`) carry excellent explanatory comments, but their gated counterparts (`sweep_expired` gated vs. permissionless `prune_settled` ungated; `collect` gated vs. `claim` exempt; `close_sale` gated — see CF5B-L05) do not state whether gating was a decision or a default. A one-line "gated because…" comment on each, or a pause-behavior table in `spec/architecture.md`, would prevent the next remediation round from having to re-derive intent.

4. **Lock accounting emits no events.** `increase_locked`/`decrease_locked` are silent; locked-capital history is only reconstructable by joining controller settlement events with purchase events. A minimal `locked_changed` event (delta + new total) would let monitoring verify the `Locked ≤ TMA` and lock-conservation invariants directly from the event stream — the same observability standard the queue and claimable-balance paths already meet.

5. **Settled entries consume classify/settle batch slots for the full 7-day retention window.** After a settlement wave, up to `SETTLED_RETENTION_DAYS` of already-settled flights occupy slots in every keeper batch (`MAX_SETTLE_BATCH = 25`), diluting throughput exactly when backlog is largest. Since eviction is already delegated to `prune_settled`, consider shortening retention, or having the keeper's paging skip entries whose oracle status is `Settled` when sizing its window (they are already no-ops individually).

6. **`snapshot()` stores a raw timestamp but gates on a derived day.** `LastSnapshotTime` holds `now` and the guard recomputes `last / SECONDS_PER_DAY`; storing the day number directly (the same value used as the storage key and event field) removes a division and makes the once-per-calendar-day semantics self-evident.

7. **Queue scans are O(n) per request.** `request_withdrawal` linearly counts the caller's pending requests and `get_withdrawal_queue_len` deserializes the whole vector; both are fine at the 250 cap but will not survive the already-deferred keyed-queue migration (AA-RV-03) unchanged — worth folding a per-address counter and a stored length into that migration's design now so its interface doesn't need a second revision.

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
