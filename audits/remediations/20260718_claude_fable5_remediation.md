# Claude Fable 5 Report (2026-07-18) — Remediation Summary

**Source report:** [`20260718_claude_fable5_report.md`](../20260718_claude_fable5_report.md)
**Audited commit:** `2556542` (main)
**Remediation date:** 2026-07-18
**Test status:** full workspace suite green — **473 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.

All four findings were validated as genuine against the current sources.
The two with mechanical fixes were fixed; the two whose remediation is a
product/runbook decision were resolved with the report's documentation-level
option, recorded on the exact functions and spec sections the report named.
All six general improvements were applied.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| CF5C-M01 | Medium | Confirmed | 📝 Documented as an accepted residual; guarantee statements corrected to their true horizon |
| CF5C-M02 | Medium | Confirmed | ✅ Fixed (upper-bound timestamp validation on both oracle outcome writes) |
| CF5C-L01 | Low | Confirmed | 📝 Documented (compromise-response rotation runbook on `set_oracle` and in the spec) |
| CF5C-L02 | Low | Confirmed | ✅ Fixed (absolute floor under the value-relative clamp) |

---

## Fixed

### CF5C-M02 — No upper-bound sanity validation on oracle arrival timestamps

**Confirmed (Medium).** `set_estimated_arrival` and `set_landed` validated
timestamps only from below (non-zero, not before the departure-day
midnight). A milliseconds-for-seconds regression in a future executor
backend — a value ~1000× too large — passed both checks and would have
corrupted the forward-only settlement pipeline irreversibly: a ms-scale
actual arrival classifies every affected flight as delayed (systematic
wrongful payouts of `(payoff − premium) × buyer_count` per flight), a
ms-scale ETA saturates the delay math to zero (systematic claim denial) and
pushes the Active-void timeout out of reach.

**Fix — the report's recommended shape.** Both writes now also reject
arrivals implausibly far past the departure day:

- `set_estimated_arrival` rejects values past `date + 3 days`
  (`MAX_SCHEDULED_ARRIVAL_AFTER_DATE_SECS` — no published schedule puts
  arrival days after departure).
- `set_landed` rejects values past `date + 30 days`
  (`MAX_ACTUAL_ARRIVAL_AFTER_DATE_SECS` — comfortably past any real
  diversion/recovery, and the classify pipeline voids an unresolved flight
  14 days past its scheduled arrival anyway).

Both bounds sit five orders of magnitude below a millisecond-scale value,
reuse the existing `InvalidTimestamp` error, and change no ABI.

*Files:* `oracle_aggregator/src/{constants,lifecycle}.rs`.
*Tests:* `test_arrival_timestamps_upper_bounded` — ms-scale and
just-past-boundary values rejected on both writes; the boundary values
themselves still accepted (`oracle_aggregator/src/test.rs`).

### CF5C-L02 — The anti-squatting request-value floor vanished at low TMA

**Confirmed (Low).** Both protective floor terms (`floor_cap = TMA/2500`
and the occupancy-scaled bound) are value-relative, so at or near zero TMA
(vault launch, severe drawdown) they degenerated to zero — and the upper
clamp then also nullified any owner-configured minimum
(`min(configured, 0) = 0`). One-stroop requests were admissible; five sybil
addresses could fill the 100-slot deposit queue at negligible cost during
exactly the phase the vault most needs deposits, with no owner lever.

**Fix — the report's two suggested directions combined at the least
intrusive point.** `floor_cap` is now bounded from below by an absolute
constant, `MIN_REQUEST_FLOOR_CAP_ABS` (one whole token at the 7-decimal
Stellar asset convention; the decimals assumption is documented for
re-examination at wiring time). Consequences:

- The occupancy-scaled term is anchored on a nonzero cap at every TMA, so
  bootstrap-phase slots are priced (marginal deposit slot approaches one
  token; pinning the queue escrows ~50 tokens and re-sniping is no longer
  free).
- The owner-configured minimum now binds up to one token even at zero TMA,
  restoring the configuration lever the clamp had nullified.
- Behavior at scale is untouched: an empty queue still admits any non-dust
  request, and the no-exclusion guarantee becomes "no configuration can
  exclude a position above `max(TMA/2500, one token)` while a slot is
  free" — one token is de minimis for any meaningfully-capitalized vault.

*Files:* `risk_vault/src/{constants,claims}.rs`.
*Tests:* `test_bootstrap_floor_prices_slots_at_near_zero_tma` — at TMA = 0,
an empty queue still admits dust, an occupied queue rejects it, and a
configured minimum binds up to the absolute cap
(`risk_vault/src/test.rs`); the existing floor/occupancy tests confirm
at-scale behavior is unchanged.

---

## Documented (accepted residuals / runbook)

### CF5C-M01 — LP exits can front-run publicly predictable delay outcomes

**Confirmed (Medium); resolved with the report's option (a).** For delay
outcomes the earliest possible oracle write is the landing itself, so for
any flight longer than the 6 h pricing delay, an underwriter observing a
public departure delay can request a withdrawal at departure, mature
mid-flight, and be priced pre-loss — the "knowable at commitment" guarantee
as previously stated did not hold for the delayed-landing channel. Options
(b)/(c) (barrier-at-scheduled-arrival semantics, a longer pricing delay)
are product decisions trading queue latency/barrier duty-cycle for LP-vs-LP
fairness and were deliberately not taken unilaterally; option (a) is the
report's stated minimum.

**What changed:**

- `LP_PRICING_DELAY_SECS` (`risk_vault/src/constants.rs`) now states the
  guarantee's true horizon — outcomes *writable* at commitment (≈ landing
  minus 6 h), not outcomes *predictable* — and points at the spec for the
  residual family.
- `spec/architecture.md` Known Limitations now documents the three
  pricing-delay-horizon residuals **together**, per the report's
  cross-cutting suggestion, so any future retuning of the delay or the
  barrier is evaluated against all three at once: (1) oracle outage longer
  than the delay, (2) pre-landing delay foreknowledge on a healthy pipeline
  (this finding — payout-bounded, capital-at-risk required, no
  insolvency), (3) void-path income predictability.
- The two-phase-pricing section of the spec and
  `docs/docs/contracts/risk-vault.md` were corrected to the same horizon
  wording.

### CF5C-L01 — Oracle rotation does not invalidate the outgoing oracle's live sale authorizations

**Confirmed (Low); runbook item as the report recommends (no clean on-chain
fix exists — `SaleAuth` entries live in temporary storage and cannot be
enumerated on-chain).** `OracleAggregator::set_oracle` now documents, in
the precondition style of the vault's `set_oracle`/`force_set_oracle`,
that outstanding sale windows survive rotation (harmless for routine
migration) and that **rotation as a compromise response is a two-step
operation**: the new oracle immediately sweeps `close_sale` over every
window still open (reconstructed from the `SaleOpened`/`SaleClosed` event
stream), or the Controller is paused for the full 24 h validity horizon.
The same runbook was added to the spec's backend-migration section and the
oracle docs page. This also discharges general improvement 6.

*Files:* `oracle_aggregator/src/admin.rs`, `spec/architecture.md`,
`docs/docs/contracts/oracle-aggregator.md`.

---

## General improvements (all six applied)

1. **Dead error variants** — `WithdrawalQueueActive` (714),
   `ExceedsFreeCapital` (715), `SettlementPending` (718) verified raised
   nowhere; **removed from the enum** in `risk_vault/src/error.rs` so they
   cannot be constructed by accident, with the numeric codes reserved in a
   do-not-reuse comment (the controller's retired `BuyerWhitelisted` key is
   the model) since integrators may still have handlers for them.
2. **Duplicated solvency-ratio bounds** — `MIN_SOLVENCY_RATIO` /
   `MAX_SOLVENCY_RATIO` moved to a new `sentinel_types::solvency` module;
   controller and vault now re-export the shared pair, eliminating the
   drift hazard that would have bricked `set_solvency_ratio`.
3. **Shared ceil-division idiom** — the reserve formula
   `ceil(locked × ratio / 100)` now lives once as
   `sentinel_types::solvency::required_reserve`, used by both the
   controller's purchase admission and the vault's
   `get_withdrawable_capital`, making the two reserves provably (not just
   textually) identical.
4. **`remove_admin` un-pause-gated** — revocation only removes authority,
   and an incident response plausibly has governance paused exactly when a
   compromised admin key needs revoking. Now pause-exempt with the same
   explanatory-comment convention as the oracle's `close_sale` and the
   controller's `remove_whitelisted_buyer`; `add_admin` and every granting
   write stay gated. Covered in
   `test_pause_gates_writes_but_not_protective_reads`.
5. **Whitelist hot-path write** — `touch_buyer_whitelisted` now skips the
   persistent deadline rewrite (and TTL re-extension) while the stored
   deadline is within 10 days of the ideal slide
   (`BUYER_APPROVAL_REFRESH_INTERVAL_SECS`), dropping a persistent write
   from most whitelisted purchases. The deadline stays within 10 days of
   `now + 180 d` — irrelevant against the 180-day dormancy horizon — and
   an archived entry restores with its original value, so the TTL skip is
   a restoration cost, not a lapse. Covered in
   `test_whitelist_touch_skips_rewrite_within_refresh_interval`.
6. **Rotation ↔ sale-window doc on `set_oracle`** — done as part of
   CF5C-L01 above.

---

## Interface changes in this pass

- `OracleAggregator` — `set_estimated_arrival` / `set_landed` can now
  revert with the existing `InvalidTimestamp` (607) for arrivals past
  `date + 3 days` / `date + 30 days` respectively. No signature change; an
  honest executor is unaffected (real values sit far inside both bounds).
- `RiskVault` — queue admission enforces
  `floor_cap = max(TMA/2500, one whole token)`; sub-token requests that
  previously slipped through at near-zero TMA are now rejected with the
  existing `RequestBelowMinimum` (719). No signature change.
- `RiskVault` — the unreachable error variants 714, 715, and 718 are
  removed from the error enum (a contract-spec change at the next
  upgrade; no live code path could produce them, so no observable
  behavior changes and the codes remain reserved).
- `GovernanceModule` — `remove_admin` is callable while paused (signature
  unchanged).
- `Controller` — buyer-approval deadline rewrites are batched to at most
  one per 10 days per address; `is_whitelisted` semantics unchanged.
- `sentinel_types` — new `solvency` module (`MIN/MAX_SOLVENCY_RATIO`,
  `required_reserve`); controller and vault consume it. No storage-layout
  or wire-format changes anywhere; no deployment action required.

## Documentation updated

`spec/architecture.md` (pricing-delay-horizon residual family in Known
Limitations, two-phase pricing guarantee wording, outcome-write validation
rules ×2, compromise-response rotation runbook in the backend-migration
section, min-request clamp wording in the owner-function table and the
deployment checklist),
`docs/docs/contracts/risk-vault.md` (pricing-delay horizon,
`set_min_withdrawal_request` clamp),
`docs/docs/contracts/oracle-aggregator.md` (outcome-write validation,
`set_oracle` rotation note).
