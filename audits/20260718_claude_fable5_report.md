# Claude Fable 5: Sentinel Soroban Findings Report

**Assessment date:** 18 July 2026

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
| Commit | `2556542f07ea817da60aadfe45bb932a22dabfa9` |
| Snapshot date | 2026-07-18 |

---

## Executive Summary

This assessment reviewed all Sentinel Protocol Soroban contracts in isolation and then in composition (cross-contract calls, shared state, and trust assumptions between them), after first reviewing the architecture documents (`spec/architecture.md`, `spec/simple_architecture.md`, `sequence_diagrams.md`) and the full prior-audit record: 29 reports across seven rounds (2026-05-31 through 2026-07-14) plus every remediation file in `audits/remediations/`. Findings already fixed, explicitly accepted, deferred, or rejected as false positives in prior rounds were excluded unless the underlying code materially changed since; where a finding below is adjacent to an accepted residual, the adjacency is stated explicitly and the finding is limited to what is new.

The codebase is in unusually strong shape. The major historical classes — stale-NAV LP entry/exit, share-price inflation, solvency erosion, active-list saturation, TTL/archival semantics, forward-only outcome integrity, fail-closed purchasing — are addressed with layered defenses and extensively documented in-code. Every candidate issue in this pass was subjected to an explicit false-positive review against the code and the remediation record before inclusion.

**Two Medium and two Low severity issues were found.** No High severity issues were found.

### Findings Summary

| ID | Severity | Title | Contracts |
| --- | --- | --- | --- |
| CF5C-M01 | Medium | LP exits can front-run delay outcomes that are publicly predictable before the oracle is able to write them (healthy pipeline, normal operation) | risk_vault ↔ oracle_aggregator ↔ controller |
| CF5C-M02 | Medium | No upper-bound sanity validation on oracle arrival timestamps; a unit-confused write irreversibly mints or denies payouts | oracle_aggregator → controller → risk_vault |
| CF5C-L01 | Low | Rotating the authorized oracle does not invalidate the outgoing oracle's live sale authorizations | oracle_aggregator ↔ controller |
| CF5C-L02 | Low | The anti-squatting request-value floor vanishes at low TMA, making bootstrap-phase queue squatting nearly free | risk_vault |

### Severity Distribution

| Critical | High | Medium | Low | Informational |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 2 | 2 | 0 |

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
- Frontend and off-chain executor services (referenced only where contract behavior depends on them; the executor's current timestamp handling was inspected as evidence for CF5C-M02)
- Compromise of owner, admin, keeper, or oracle credentials (standing accepted trust model); CF5C-M02 concerns *malformed* input from an honest-but-buggy oracle backend, which the contracts' own validation philosophy treats as in-scope
- Everything recorded as deferred / won't-fix / accepted / by-design in `audits/remediations/` — notably: the trusted-oracle assumption and forward-only no-correction design (AA-OA-03), the withdrawal-queue keyed-storage migration and its Sybil caps (AA-RV-03 / AA-RV-01), the canonical attested flight-registry endgame (AA-CT-01 / CAI-H01), the ≤ 24 h sale-authorization staleness residual (CAI-H01 / C57-H01), the 14-day void-as-on-time outage trade-off (AA-CT-03 / CAI-M01), the oracle-outage-longer-than-6 h pricing-delay residual and the void-path income-predictability residual (C57-H02 / H-01, 2026-07-14), the no-exit-reservation design consideration (CF5B-L02), the exactly-tight buyer-proof bound (CF5B-L01), the index self-heal first-reader-wins limit (CF5-L01), pause-gating asymmetries recorded as deliberate, and single-key owner.

---

## Items Considered and Discarded as False Positives

In line with the assessment instructions, every candidate finding was re-verified against the code and the remediation record before inclusion. Items investigated and dropped, with the reason:

- **Pool-wide (not per-bucket) balance floors** in `record_premium_income` and `settle_with_claim_window` — documented defense-in-depth against a compromised caller; the controller is trusted and per-bucket escrow accounting is out of reach on-chain.
- **Disabled ERC-4626 surface behavior** (`deposit`/`mint`/`withdraw`/`redeem` revert; `max_*` return 0; `preview_*` are quotes) — accepted ERC-7540-style asynchronous-vault convention (20260714 remediations).
- **Queue waits at zero free capital; purchases compete with queued exits; monolithic queue / TravelerFlights storage shapes** — all explicitly by-design or deferred with mitigations (NM-002 residual, CF5B-L02, AA-RV-03, AA-CT-02).
- **Pool-config-archives-while-purchasable re-registration hazard** (fresh `FlightConfig` resetting `buyer_count` under live `Buyer` keys) — verified unreachable: the config TTL always covers the flight date plus buffer while purchases remain possible, so the config cannot archive during the purchase window; post-outcome divergence is caught by gate 3c and the `OracleDataUnavailable` gate.
- **Partial-fill over-burn in `process_withdrawal_queue`** — verified safe: floor–floor round trip strictly bounds `fillable_shares < request.shares` and `assets_part ≤ remaining_free`.
- **Cancel-path pricing optionality** (`cancel_deposit` / `cancel_withdrawal` during a pending outcome) — verified none exists: cancellation returns escrow at face value in both directions; documented in-code.
- **`PendingOutcomes` counter balance** — verified increment/decrement-balanced across every path, including both void edges (increment at classification), the pre-registration cancellation tombstone (deliberately uncounted, never enumerable), and eviction (owner-asserted flag, accepted CF5-M02 residual).
- **`increase_locked`/`send_payout` transient invariants** — verified `Locked ≤ TMA` holds at every settlement commit point; a delayed settlement strictly grows the margin by `premium × buyer_count`.
- **Governance `remove_admin` pause-gated** — negligible risk since every admin-usable entry point is also pause-gated; retained as a consistency note under General Improvements only.
- **`snapshot` intra-day sample pinning** — documented in-code as untrusted analytics, never a pricing input.

---

## Security Findings

Severity definitions follow the prior reports: **High** — direct loss or freezing of user funds, or protocol-wide authorization failure; **Medium** — conditional loss, value mis-attribution, or denial of core functionality under plausible conditions; **Low** — edge-case, corner-condition, or defense-in-depth gaps with bounded impact or demanding preconditions.

### Medium

---

#### CF5C-M01 — LP exits can front-run delay outcomes that are publicly predictable before the oracle is able to write them (healthy pipeline, normal operation)

**Contracts / locations:**
- `contracts/risk_vault/src/constants.rs:1-22` (`LP_PRICING_DELAY_SECS` sizing rationale)
- `contracts/risk_vault/src/capital.rs:135-207` (`process_withdrawal_queue` maturity + barrier gates)
- `contracts/risk_vault/src/auth.rs:27-34` (`settlement_pending` reads the oracle's written-outcome counter)
- `contracts/oracle_aggregator/src/lifecycle.rs:145-192` (`set_landed` — the earliest possible on-chain disclosure of a delay outcome)
- `executor/centralized_cron/src/flight_data_fetcher.ts` (landed resolution waits for ETA + 1 h; 2 h fetch cadence)

**Description.** The two-phase LP pricing design states its guarantee explicitly (constants.rs, and the 20260714 remediation record): *"by the time a request matures, every outcome knowable at commitment is on-chain: either settled (already in the price) or pending (the barrier holds the request queued until settlement)."* The 6-hour `LP_PRICING_DELAY_SECS` is sized against the oracle pipeline's **observation-to-write latency** — the ~3 h worst case between a landing being observed and `set_landed` reaching the chain.

For delay outcomes, however, the earliest possible write is the landing itself: the executor can only push `set_landed` after actual arrival, and the settlement barrier (`PendingOutcomes`) engages only at that write. A delay-driven outcome is frequently near-certain much earlier than that — a departure delay of several hours makes an arrival delay beyond the route threshold effectively certain at departure time, which precedes the `Landed` write by roughly the flight's duration plus fetch latency. During that whole interval the flight sits `Active` on-chain, the barrier reads clear, and nothing distinguishes it from an on-time flight.

Concretely: for any flight where `flight_duration + write_latency > LP_PRICING_DELAY_SECS` (≈ any flight longer than ~4–6 h — most long-haul traffic), an underwriter who observes the public departure delay can `request_withdrawal` immediately, have the request mature 6 h later while the flight is still airborne, and be priced by the keeper's ~5-minute `run_queue_maintenance` cadence **before the outcome ever reaches the chain** — exiting at the pre-loss share price. Their share of the flight's loss, up to `(payoff − premium) × buyer_count`, shifts to the remaining LPs. The maneuver is repeatable per qualifying flight, requires no privileged access, and both gates in `process_withdrawal_queue` (maturity, barrier) pass legitimately.

The entry-side mirror exists — committing a deposit ≥ 6 h before a near-certain on-time settlement captures a share of premium income belonging to incumbents — but is premium-bounded and small.

**Relation to accepted residuals.** The remediation record accepts two members of this family: (a) an oracle-pipeline **outage** longer than the pricing delay reopening the window (C57-H02 residual; operational response is to pause the vault), and (b) **void-path premium income** being deterministically predictable arbitrarily far ahead ("not closed by any delay"; accepted as premium-bounded). This finding is a third member — **payout-bounded rather than premium-bounded, and present with a fully healthy pipeline** — that the accepted-residual documentation does not cover, and that contradicts the stated "knowable-at-commitment" guarantee for the delayed-landing channel specifically. Cancellations are not affected (the executor tombstones them within one 2 h cycle, well inside the 6 h delay).

**Impact.** Systematic adverse selection among LPs: informed exits (and to a lesser degree entries) around long-haul delayed flights transfer that flight's pending loss to passive LPs. Bounded per event by `(payoff − premium) × buyer_count`; no protocol insolvency; requires capital at risk in the vault and public flight-tracking data.

**Remediation direction.** Options, in increasing order of intrusiveness: (a) explicitly accept and document this residual alongside the two existing ones, and correct the guarantee statement in `constants.rs` / `spec/architecture.md` to state its actual horizon (outcomes knowable *at or after landing minus 6 h*); (b) extend the barrier semantics so an `Active` flight whose ledger time has passed its recorded scheduled arrival (or `estimated_arrival_time + delay_hours`) counts as a pending outcome — closing the window at the cost of barrier duty-cycle whenever flights are between scheduled arrival and settlement (worth modelling against real traffic before adopting); (c) lengthen the pricing delay toward the scheduled-arrival horizon (largest UX cost, still not airtight against departure-delay foreknowledge). Documentation-only option (a) is the minimum; the choice between (a) and (b) is a product decision about how much LP-vs-LP fairness the protocol wants to buy with queue latency.

---

#### CF5C-M02 — No upper-bound sanity validation on oracle arrival timestamps; a unit-confused write irreversibly mints or denies payouts

**Contracts / locations:**
- `contracts/oracle_aggregator/src/lifecycle.rs:117-124` (`set_estimated_arrival` validation: rejects `0` and `< date` only)
- `contracts/oracle_aggregator/src/lifecycle.rs:155-161` (`set_landed` validation: rejects `0` and `< date` only)
- `contracts/controller/src/settle.rs:160-175` (delay classification consumes the raw difference)
- `executor/centralized_cron/src/aeroapi_client.ts:112-115` (`parseTimestamp` — currently correct, ÷ 1000)

**Description.** Both oracle outcome writes validate their timestamps from below, with in-code rationale that is exactly right: *"a bad timestamp accepted now corrupts the delay classification later with no on-chain correction path."* There is no validation from above. A milliseconds-for-seconds regression in a future executor backend — precisely the class of migration hazard the `sentinel_types` doc comments repeatedly guard against for UTC-day keying and `scheduled_in`-vs-`estimated_in` — passes both checks, because a millisecond-scale value (~1.7 × 10¹²) is comfortably greater than any day-aligned `date` (~1.7 × 10⁹):

1. **Millisecond `actual_arrival_time`** (`set_landed`): `actual − estimated` computes to ~1.7 × 10¹² seconds → every affected flight classifies `ToBeSettledDelayed` → the vault pays `(payoff − premium) × buyer_count` per flight, **systematically across every flight the buggy executor settles until noticed**, unrecoverable under the forward-only state machine.
2. **Millisecond `estimated_arrival_time`** (`set_estimated_arrival`): the delay computation saturates to zero → every genuinely delayed flight on that ETA classifies on-time → valid claims denied, equally uncorrectable; additionally the `Active`-void timeout (`estimated + 14 d`) becomes unreachable, so a flight that never lands strands until the record archives and the owner runs the eviction path.

The current executor converts correctly, so this is defense-in-depth — but it is the missing symmetric half of a validation the contract already half-implements for exactly this stated reason, it guards an irreversible fund-moving path with no correction mechanism by design, and the prior remediation record's position that "input validation rejects malformed payloads; wrong-but-plausible data remains a trusted-role assumption" (AA-OA-03) supports it: a unit-confused timestamp is malformed, not plausible.

**Impact.** Contingent on a trusted-component defect (likelihood low), but the consequence is systematic, irreversible wrongful payouts or claim denials across all flights processed during the defect window — the highest-consequence honest-mistake failure mode left open in the oracle. The forward-only machine, deliberately, offers no undo.

**Remediation direction.** Add upper bounds mirroring the existing lower bounds: reject `estimated_arrival_time` beyond a plausible schedule horizon (e.g. `date + ~3 days` — no scheduled arrival is days after its departure day) and `actual_arrival_time` beyond a plausible resolution horizon (e.g. `date + ~30 days`, comfortably past any real diversion/recovery scenario while five orders of magnitude below a ms-scale value). One comparison per write path; no ABI change.

---

### Low

---

#### CF5C-L01 — Rotating the authorized oracle does not invalidate the outgoing oracle's live sale authorizations

**Contracts / locations:**
- `contracts/oracle_aggregator/src/admin.rs:44-52` (`set_oracle` — rotation for backend migration)
- `contracts/oracle_aggregator/src/storage.rs:23-29` (`SaleAuth` — temporary storage, not enumerable on-chain)
- `contracts/oracle_aggregator/src/lifecycle.rs:43-105` (`open_sale` / `close_sale`)
- `contracts/controller/src/purchase.rs:112-127` (purchase gate consumes `is_sale_open`)

**Description.** `OracleAggregator::set_oracle` swaps the authorized oracle key with no effect on outstanding `SaleAuth` entries: every window the outgoing oracle opened remains live for up to its remaining validity (`SALE_AUTH_MAX_VALIDITY_SECS` = 24 h) and continues to authorize purchases through the controller. Temporary-storage keys cannot be enumerated on-chain, so there is no bulk-revoke; the new oracle can only `close_sale` windows it learns about from `SaleOpened`/`SaleClosed` events off-chain.

If rotation is routine backend migration this is harmless. If rotation is a **compromise response** — the scenario key rotation exists for — the attacker's parting attestations survive the rotation: flights the honest pipeline never verified (including publicly cancelled ones) stay purchasable until each window lapses or is individually closed. The impact class is bounded: fabricating a *claim* additionally requires a malicious outcome write, which rotation does stop, so the residue is (a) the already-accepted ≤ 24 h stale-attestation purchase window (CAI-H01 / C57-H01 residual) triggered by a new path, and (b) premium-forfeiting collateral-pinning griefing via policies on nonexistent flights (voided after 14 days, premiums to the vault). This finding is therefore an extension of an accepted residual to the rotation trigger, not a new impact class — reported because the rotation runbook nowhere records it.

**Impact.** During the ≤ 24 h post-rotation window: purchases against unverified or publicly-cancelled flight instances (each such cancelled-flight policy is a deterministic `payoff − premium` claim once the new oracle records the cancellation), plus bounded collateral griefing. Requires a compromised-then-rotated oracle key.

**Remediation direction.** Runbook item (no clean on-chain fix exists given temporary-storage enumeration limits): on any rotation performed as a compromise response, the new oracle immediately sweeps `close_sale` over all windows reconstructed from `SaleOpened` events, or the controller is paused for the 24 h validity horizon. Document this on `set_oracle` itself — the vault-side `set_oracle` / `force_set_oracle` doc comments are the model for stating rotation preconditions.

---

#### CF5C-L02 — The anti-squatting request-value floor vanishes at low TMA, making bootstrap-phase queue squatting nearly free

**Contracts / locations:**
- `contracts/risk_vault/src/claims.rs:56-74` (`request_deposit` floor), `:196-221` (`request_withdrawal` floor)
- `contracts/risk_vault/src/constants.rs:61-77` (`MIN_REQUEST_FLOOR_DIVISOR` clamp design)

**Description.** The effective per-request minimum is `clamp(configured, floor_cap × occupancy, floor_cap)` with `floor_cap = TMA / 2500`. Both protective terms are **value-relative**, so at or near zero TMA (vault launch, or after a severe drawdown) `floor_cap = 0` and the occupancy term is 0 — and the upper clamp then **also nullifies any owner-configured minimum** (`min(configured, 0) = 0`). One-stroop requests are admissible. Five sybil addresses (the 20-per-address cap) can fill the 100-slot deposit queue at negligible cost, and re-snipe slots as each maintenance pass frees them, delaying genuine LP entry during exactly the phase where the vault needs deposits. The owner has no lever: the clamp designed to stop a hostile configuration from excluding ordinary positions simultaneously prevents any configured floor from binding while TMA is small.

The withdrawal queue has the same degenerate case but requires holding shares, so the deposit queue is the practical target. The condition self-corrects as TMA grows (the relative floors become meaningful), and processing drains up to 50 matured dust requests per pass, so this is availability griefing with a race per slot — not a lockout. The prior occupancy-floor remediation (commit #73 / AA-RV-01 record) does not note the low-TMA degenerate case.

**Impact.** Bootstrap-phase denial/delay of LP entry (and exit-queue admission) at near-zero attacker cost; no fund loss; self-resolving at scale.

**Remediation direction.** Add a small **absolute** dust floor (a flat constant in asset units, e.g. one whole token) applied beneath the relative clamp, or let the owner-configured minimum bind un-clamped while TMA is below a documented threshold. Either preserves the existing guarantee (no configuration can exclude ordinary positions from a meaningfully-capitalized vault) while pricing bootstrap-phase slots.

---

### Cross-cutting observations

Both Medium findings exist only in the seams between components, not in any contract alone:

- **CF5C-M01** is a timing-composition gap: the oracle writes outcomes at landing (correct), the barrier keys off writes (correct), and the queue prices matured requests against current NAV (correct) — the gap is that the composition's stated guarantee assumes outcomes become knowable only at landing, which is false for delay outcomes specifically.
- **CF5C-M02**'s blast radius is cross-contract (oracle accepts → controller classifies → vault pays), which is why the single-comparison fix belongs at the oracle write — the one choke point every downstream consumer trusts.
- **CF5C-L01** is an instance-boundary continuity gap of the same shape as the remediated CF5B-L04: authorization state (sale windows) outliving the authority that created it across a rotation.

Systemically: the LP-fairness perimeter now has three named residuals of one family (outage > 6 h; void-path income; and CF5C-M01's pre-landing delay foreknowledge). They would benefit from being documented together in `spec/architecture.md` as a single "pricing-delay horizon" statement, so future tuning of `LP_PRICING_DELAY_SECS` or the barrier semantics is evaluated against all three at once.

---

## General Improvements

Non-security suggestions; no severity ranking.

1. **Dead error variants.** `WithdrawalQueueActive` (714), `ExceedsFreeCapital` (715), and `SettlementPending` (718) in `risk_vault/src/error.rs` are no longer raised anywhere since direct entry/exit was disabled and the barrier became a silent no-op deferral. Mark them retired in a comment (the controller's retired `BuyerWhitelisted` key is the model) or remove them at the next ABI-breaking upgrade, so integrators don't write handlers for unreachable codes.

2. **Duplicated solvency-ratio bounds.** `MIN_SOLVENCY_RATIO` / `MAX_SOLVENCY_RATIO` are defined independently in `controller/src/constants.rs` and `risk_vault/src/constants.rs`, with comments on each side promising they mirror the other. This is the cross-crate drift hazard `sentinel_types::ttl`/`timeouts` were created to eliminate, and it is more load-bearing than the already-recorded inert duplicates (`MAX_ACTIVE_FLIGHTS`, `SECONDS_PER_DAY`): the vault rejects controller pushes outside its copy of the bounds, so drift would brick `set_solvency_ratio`. Move both to `sentinel_types`.

3. **Shared ceil-division idiom.** The reserve computation `(x × ratio + 99) / 100` appears in `controller/src/purchase.rs` (admission) and `risk_vault/src/queries.rs` (`get_withdrawable_capital`). A shared helper next to the shared bounds would make the two reserve formulas provably identical instead of textually identical.

4. **`remove_admin` is pause-gated** (`governance_module/src/admin.rs`). The codebase's stated convention is that strictly-protective revocation writes stay pause-exempt (`close_sale`, buyer-whitelist removal). Revoking a compromised admin while governance is paused currently requires unpausing first. Practical risk is negligible (every admin-usable entry point is also pause-gated; the only pause-exempt admin power is the controller's buyer-whitelist mutation), but exempting `remove_admin` — or a one-line "gated because…" comment — would make the convention uniform.

5. **Whitelist hot-path write.** `touch_buyer_whitelisted` rewrites the approval deadline and re-extends its TTL on every gated purchase. Skipping the rewrite when the stored deadline is already far out (e.g. > 170 of the 180 days remaining) would drop a persistent write from most whitelisted purchases with no behavior change.

6. **Document rotation ↔ sale-window interaction on `set_oracle`.** Regardless of CF5C-L01's disposition, the aggregator's `set_oracle` doc comment should state that outstanding sale authorizations survive rotation and name the event-driven `close_sale` sweep as the companion step — matching the precondition-documentation standard the vault's `set_oracle` / `force_set_oracle` already meet.

---

# Limitations

This assessment represents a point-in-time review of the specified repository state. It does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, economic risks, or integration failures. Off-chain executor code was consulted only as evidence for contract-facing behavior (timestamp conversion, fetch cadence, landed-resolution gating); it was not audited. Runtime behavior of archived Persistent entries is assessed under Stellar Protocol 23 state-archival semantics (automatic restoration within the transaction footprint; pre-execution failure otherwise), consistent with the prior round's external validation.

# Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of these assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

This assessment does not constitute:

- a formal security certification;
- a guarantee of security;
- legal advice;
- investment advice; or
- an endorsement of the project.

Use of this report is at the sole risk of the reader.
