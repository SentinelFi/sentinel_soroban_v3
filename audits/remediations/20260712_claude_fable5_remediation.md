# Claude Fable 5 Report (2026-07-12) — Remediation Summary

**Source report:** [`20260712_claude_fable5_report.md`](../20260712_claude_fable5_report.md)
**Audited commit:** `0e83ad6` (main)
**Remediation date:** 2026-07-13
**Test status:** full workspace suite green — **431 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.

All actionable items were validated as genuine against the current sources
and fixed; the reclassified design consideration is now documented as a
specified design property, and the withdrawn finding needed no action.

| ID | Severity (v1.1) | Verdict | Status |
|----|----------|---------|--------|
| CF5B-L04 | Low | Confirmed | ✅ Fixed (checked rotation + paused-only forced path) |
| CF5B-L05 | Low | Confirmed | ✅ Fixed (`close_sale` pause-exempt) |
| CF5B-L01 | Informational | Confirmed | ✅ Fixed (assert re-stated on the true bound over shared constants) |
| CF5B-L02 | Design consideration | Acknowledged | 📝 Documented as a specified design property (no reservation policy) |
| CF5B-L03 | Withdrawn | — | No action (residual hardening noted, not taken) |

---

## Fixed

### CF5B-L04 — `set_oracle` rotation silently discards pending-outcomes barrier state

**Confirmed (Low).** `RiskVault::set_oracle` swapped the settlement-barrier
target unconditionally. A fresh OracleAggregator starts with
`PendingOutcomes = 0`, so rotating while the old oracle still reported
public-but-unsettled outcomes — precisely the moment a rotation plausibly
happens — opened the barrier immediately, letting LPs enter/exit at the
stale pre-settlement share price.

**Fix — the report's recommended shape, with the force path made
mechanically safe rather than advisory:**

- `set_oracle` now refuses (`OraclePendingOutcomesUnreconciled`, 725) while
  the **current** oracle reports `has_pending_outcomes()`. The routine
  rotation therefore cannot open the barrier: it only proceeds once the old
  oracle reads clear.
- New owner entry `force_set_oracle` covers the contingency the rotation
  exists for — an old oracle so dead the check itself cannot execute. It
  skips the check but **requires the vault to be paused**
  (`ForcedRotationRequiresPause`, 726): pause blocks every LP entry/exit
  (deposit, mint, withdraw, redeem, queue processing), so the stale-price
  window physically cannot occur; exits stay blocked until the owner
  reconciles the old oracle's pending PnL and deliberately unpauses. This
  hard-codes the runbook rule the report proposed as a minimum ("pause the
  vault across the rotation") instead of relying on operator discipline.
- The `oracle_set` event now carries a `forced: bool` so monitoring can
  distinguish routine configuration from an open incident — mirroring how
  `evict_missing_flight` records its judgment call.

*Files:* `risk_vault/src/{admin,error,events}.rs`.
*Tests:* `test_set_oracle_refuses_while_outcomes_pending` (rotation blocked
while the mock oracle reports pending, proceeds once cleared),
`test_force_set_oracle_requires_pause` (forced path rejected unpaused,
succeeds paused even with pending outcomes) — `risk_vault/src/test.rs`.

### CF5B-L05 — Pausing the oracle blocked its own protective writes

**Confirmed (Low).** Sale authorizations live in temporary storage and stay
readable — and purchasable through the (possibly unpaused) controller — for
up to 24 h regardless of the oracle's pause state, yet both revoking writes
(`close_sale`, and `set_cancelled`'s auth removal) were pause-gated. Pausing
only the oracle therefore *extended* the accepted purchasable-after-public-
cancellation exposure instead of containing it: open windows could not be
revoked on-chain for their full validity.

**Fix — the report's primary recommendation:** `close_sale` is no longer
pause-gated, with the same explanatory-comment convention the governance
module uses for its pause-exempt protective writes (it only removes
authorization — strictly protective, no privilege granted). `set_cancelled`
stays gated: it writes an outcome (a state-machine transition with
accounting side effects), and during an oracle pause the executor closes the
exposure with `close_sale` alone — recording the actual cancellation can
wait for unpause. This gives incident operators the revocation tool without
letting a paused oracle's state machine advance.

*Files:* `oracle_aggregator/src/lifecycle.rs`.
*Tests:* `test_close_sale_works_while_paused` — a paused oracle rejects new
`open_sale` attestations but still revokes a live window, and the purchase
gate (`is_sale_open`) reads closed (`oracle_aggregator/src/test.rs`).

### CF5B-L01 — Buyer-proof lifetime assert checked the wrong constant pair

**Confirmed (Informational).** The controller's compile-time assert checked
`MAX_BOOK_AHEAD + MAX_CLAIM_EXPIRY_WINDOW ≤ 180d` (90 + 60), but the claim
deadline is not bounded by settlement time plus the window: settlement can
run long after the flight date, and the binding cap is the pool-side
`claim_expiry ≤ date + MAX_CLAIM_DEADLINE_AFTER_DATE_SECS` (90 days) — a
constant in a different crate the assert never referenced. Raising that
pool constant would have silently voided the invariant while the assert
kept passing; the true bound (90 + 90 = 180) is exactly tight with zero
slack and assumes the ~5 s/ledger cadence.

**Fix — recommendation (a) plus the constant-consolidation the report's
improvement #2 suggested for exactly this case:**

- `BUYER_PROOF_TTL_LEDGERS` / `BUYER_PROOF_TTL_SECS` and
  `MAX_CLAIM_DEADLINE_AFTER_DATE_SECS` moved to `sentinel_types::timeouts`
  — one definition shared by the pool (which re-exports them under its
  existing names) and the controller, eliminating the hand-mirrored
  `BUYER_KEY_TTL_SECS` copy entirely.
- The controller assert is re-stated on the true bound:
  `MAX_BOOK_AHEAD_SECS + MAX_CLAIM_DEADLINE_AFTER_DATE_SECS ≤
  BUYER_PROOF_TTL_SECS`, referencing the shared constants directly, so a
  change on either side now trips it. A companion compile-time assert in
  `sentinel_types` pins the seconds/ledgers representations to each other
  at the assumed cadence.
- The zero-slack tightness and the 5 s/ledger cadence assumption are now
  documented at the constants and at the assert, together with the v1.1
  correction the report itself makes: an archived proof is restored with
  its original value on next access, so expiry is a restoration cost, not a
  lost claim. The pool's stale "No re-extension needed" comment was
  reconciled with the planned (not yet implemented) executor key-level
  extension job.
- Recommendation (b) — buying slack by shortening the claim-deadline cap or
  the booking horizon — was deliberately not taken: with restoration
  semantics ruling out claim loss (the report's own v1.1 downgrade
  rationale), shrinking either constant would trade real product surface
  (late-settlement claim windows / the booking horizon) for slack against a
  hazard with no fund impact. The corrected assert now makes any future
  re-tightening a conscious, single-line decision.

*Files:* `sentinel_types/src/lib.rs`, `flight_pool_manager/src/constants.rs`,
`controller/src/constants.rs`. Compile-time asserts are their own
regression tests — the suite builds and passes with the corrected bound.

---

## Documented (design consideration)

### CF5B-L02 — Purchases compete with queued withdrawals for freed capital

**Acknowledged as designed; now specified.** Queued withdrawals hold FIFO
priority among themselves but no reservation against new underwriting —
capital freed by settlement can be re-locked by purchases before the next
queue-maintenance pass. Per the report's v1.1 reclassification this is a
liquidity characteristic, not a bug, *provided the rule is specified*. It
now is: `spec/architecture.md`'s withdrawal-queue section states the
no-reservation property explicitly, names the operator levers (a solvency
ratio above 100% structurally reserves capital purchases cannot lock — a
lever strengthened by this branch's reserve-aware exit bound — and `wd_req`
events carry queue occupancy for back-pressure monitoring), and records
that a reservation policy, if ever required by product, must be an explicit
future change (e.g. tightening the purchase solvency check by the queue's
outstanding value). No contract change.

## Withdrawn — no action

### CF5B-L03 — Pool active-set removal on an archived page

Withdrawn by the report itself: under Protocol 23+ semantics an archived
page named in the footprint is restored before execution or the transaction
fails before the settled status could commit, so the stranded-entry sequence
is unreachable. The residual hardening it mentions (a pool-side
`prune_settled`-style sweep) was not taken — the asymmetry with the oracle
is deliberate (the pool removes entries at settlement; the oracle retains
them for a window), and this branch's `active_set::add` bounded-scan
backstop already covers the neighboring stranded-state class.

## General improvements (unranked report suggestions)

Item 2 (cross-crate constant duplication) is partially implemented where it
was load-bearing — the buyer-proof/claim-deadline constants now live in
`sentinel_types` (the exact consolidation the corrected CF5B-L01 assert
needed); `MAX_ACTIVE_FLIGHTS` and `SECONDS_PER_DAY` duplicates remain, as
inert mirrors. Item 3 (pause-gating rationale) is addressed for the case
that mattered (`close_sale` now documents its exemption; `set_cancelled`'s
gating is now a stated decision). Items 1, 4, 5, 6, 7 (wiring-rotation
asymmetry docs, lock-accounting events, settled-entry retention slots,
snapshot day storage, queue-scan complexity) are noted for future passes —
none is security-bearing, and several (6, 7) interact with storage-layout
or deferred-migration decisions better made together.

---

## Interface changes in this pass

- `RiskVault` — `set_oracle` can now revert with
  `OraclePendingOutcomesUnreconciled` (725); new owner entry
  `force_set_oracle` with `ForcedRotationRequiresPause` (726); the
  `oracle_set` event gains a `forced: bool` data field (indexers that
  decoded the event's empty data payload should read the new flag).
- `OracleAggregator` — `close_sale` is callable while paused (signature
  unchanged).
- `sentinel_types` — new `timeouts` constants
  (`BUYER_PROOF_TTL_LEDGERS/SECS`, `MAX_CLAIM_DEADLINE_AFTER_DATE_SECS`);
  pool and controller now consume them. No storage-layout or wire-format
  changes anywhere; no deployment action required.

## Documentation updated

`spec/architecture.md` (oracle-rotation runbook in the deployment section,
`close_sale` pause exemption, vault event list, function reference, the new
withdrawal-queue no-reservation paragraph),
`docs/docs/contracts/risk-vault.md` (owner functions),
`docs/docs/contracts/oracle-aggregator.md` (`close_sale`),
`playground/lib/registry.ts` (`force_set_oracle`, `set_oracle` description).
