# cosminmarian53 Soroban Auditor Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_cosminmarian53_soroban_auditor_report.md`](../20260704_cosminmarian53_soroban_auditor_report.md)
**Audited commit:** `6b0db9e` (main)
**Remediation date:** 2026-07-10
**Test status:** full workspace suite green — **333 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

All three findings are validated as genuine at the audited commit. Two of them
(H-01, L-01) describe the same root causes as NM-001 and NM-003 of the
[Nemesis 2026-07-04 report](20260704_nemesis_auditor_remediation.md) and were
already remediated in commit `e4a4a17` ("Fixes for new nemesis audit"), which
landed **after** the commit this report assessed. This pass verified those fixes
against this report's specific recommendations and closed the remaining gap
(L-02) plus a consistency gap the new settlement barrier introduced in the
`max_*` views.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| H-01 | High | Confirmed at audited commit | ✅ Fixed in `e4a4a17` (settlement barrier); verified against this report |
| L-01 | Low | Confirmed at audited commit | ✅ Fixed in `e4a4a17` (snapshot prices on managed assets); verified |
| L-02 | Low | Confirmed | ✅ Fixed in this pass (max views report zero while direct exits are disabled) |

---

## Previously fixed — verified against this report

### H-01 — Public outcomes let informed LPs transfer pending losses to passive LPs
**Confirmed (High) at the audited commit.** Flight outcomes became public
(oracle `Landed`/`Cancelled`) before their financial effect reached
`TotalManagedAssets`, so an informed LP could redeem at the stale pre-loss price
(or deposit ahead of known premium income), shifting pending PnL onto passive
LPs.

**Fix (landed in `e4a4a17`, verified here):** a settlement barrier keyed on the
oracle's public state. OracleAggregator maintains a `PendingOutcomes` counter —
incremented the moment an outcome first becomes public (`set_landed` /
`set_cancelled`), decremented on financial settlement (`set_settled`) — exposed
via `has_pending_outcomes()`. RiskVault reverts `deposit`, `mint`, `withdraw`,
and `redeem` with `SettlementPending` while any outcome is
public-but-unsettled, and `process_withdrawal_queue` is a no-op during that
window, so queued exits are priced only after settlement. This closes both
directions the report identifies: no pre-loss exit and no pre-income entry.

Verification against this report's recommendation list:

- `deposit` / `mint` / `withdraw` / `redeem` — guarded
  (`risk_vault/src/vault_ops.rs`, `risk_vault/src/auth.rs`).
- Queued-withdrawal pricing — the queue accepts requests during the window
  (shares are escrowed, no price locked) but drains only post-settlement, so no
  queued exit is ever priced at the stale rate (`risk_vault/src/capital.rs`).
- Preview and conversion methods — intentionally left as pure rate views, per
  the ERC-4626 convention that previews reflect the current exchange rate.
  They cannot be exploited: every executable path that would transact at that
  rate reverts during the window, and the `max_*` views (the "can this execute"
  signal) report zero (see L-02 below).
- Regression tests — `lp_cannot_transact_at_stale_price_during_pending_outcome`
  proves direct exit and entry both revert while an outcome is public and
  succeed only after settlement recognizes the PnL, i.e. LP ownership of
  pending gains/losses cannot change after an outcome becomes public;
  `withdrawal_queue_stays_open_during_pending_outcome` proves the queued path
  stays available and prices only post-settlement
  (`integration_tests/src/tests/group2_capital.rs`).

### L-01 — Snapshot pricing counts liabilities excluded by executable pricing
**Confirmed (Low) at the audited commit.** `snapshot()` priced on
`Vault::total_assets(e)` — the raw token balance, which includes
processed-but-uncollected withdrawal claims and donations — while executable
conversions price on `TotalManagedAssets`, so published snapshots overstated
the executable share price (analytics-only impact).

**Fix (landed in `e4a4a17`, verified here):** `snapshot()` prices on
`Self::get_total_managed_assets(e)`, the exact basis used by
`managed_convert_to_shares` / `managed_convert_to_assets`, matching the
report's recommended diff (`risk_vault/src/snapshot.rs`).
*Test:* `test_snapshot_uses_managed_assets_not_physical_balance` leaves an
uncollected claimable balance so the physical balance exceeds managed assets,
then asserts the recorded price equals `TMA * scale / total_supply` — the
invariant the report asks for (snapshot price ≡ executable conversion rate).

---

## Fixed in this pass

### L-02 — Maximum-withdrawal views report amounts that active queues make unexecutable
**Confirmed (Low).** Direct `withdraw`/`redeem` revert with
`WithdrawalQueueActive` whenever any withdrawal request is queued, but
`max_withdraw()`/`max_redeem()` only accounted for the pause switch, balances,
and free capital — so integrations could read a positive limit and submit a
direct exit guaranteed to fail.

**Fix:** the `max_*` views now mirror **every** global gate of their executable
counterparts, generalizing the report's recommendation to the settlement
barrier that H-01's fix added after the audited commit:

- `max_withdraw` / `max_redeem` return 0 while the withdrawal queue is
  non-empty (the report's recommended condition), while paused, or while a
  settlement is pending — the three conditions under which direct exits revert.
- `max_deposit` / `max_mint` return 0 while paused or while a settlement is
  pending — the two conditions under which entries revert. (The queue does not
  block deposits, so it does not affect these views.)

*Files:* `risk_vault/src/vault_ops.rs`.
*Tests (the conformance tests the report asks for — every max view reports zero
whenever the corresponding operation is globally disabled):*

- `test_max_views_return_zero_while_queue_active` — queuing a request by one LP
  drops `max_withdraw`/`max_redeem` to 0 for all LPs (deposit views unaffected);
  draining the queue restores positive values (`risk_vault/src/test.rs`).
- `test_max_views_return_zero_when_paused` — pre-existing pause conformance
  test (`risk_vault/src/test.rs`).
- `lp_cannot_transact_at_stale_price_during_pending_outcome` — extended to
  assert all four max views report 0 during a public-but-unsettled outcome and
  recover after settlement (`integration_tests/src/tests/group2_capital.rs`).

---

## Files changed in this pass

Source: `risk_vault/src/vault_ops.rs` (L-02).
Tests: `risk_vault/src/test.rs`,
`integration_tests/src/tests/group2_capital.rs`.
