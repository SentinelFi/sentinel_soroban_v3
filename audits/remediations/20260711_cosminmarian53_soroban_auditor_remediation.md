# cosminmarian53 Soroban Auditor Report (2026-07-11) — Remediation Summary

**Source report:** [`20260711_cosminmarian53_soroban_auditor_report.md`](../20260711_cosminmarian53_soroban_auditor_report.md)
**Audited commit:** `cdac8a8` (main)
**Remediation date:** 2026-07-11
**Test status:** full workspace suite green — **399 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

The report identified **no validated findings** (0 Critical / High / Medium /
Low). Three investigative leads were opened and rejected by the auditor as
non-issues. This pass independently re-verified each rejection rationale and
the mitigations the report's executive summary credits, at current `main`
(which includes the post-audit commit `25b367b`). **No code changes were
required.**

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| — | — | No validated findings | ✅ Nothing to fix; report claims verified |

---

## Rejected leads — rejection rationale verified

### Shared upgrade helper is intentionally ungated

**Verified as correctly rejected.** `sentinel_types::upgrade::upgrade` is not
access-gated, but it is a library function, not a contract entry point — it
only becomes reachable through a contract's exported `upgrade` wrapper. Every
production wrapper (`controller`, `flight_pool_manager`, `governance_module`,
`oracle_aggregator`, `risk_vault` — and the out-of-scope `mock_usdc`) gates the
call with `#[only_owner]` before delegating (`<contract>/src/upgrade.rs`). The
helper's doc comment states the caller-gated contract explicitly. This is the
standard shared-helper pattern; no exposure exists.

### Controller whitelist toggle is owner-gated

**Verified as correctly rejected.** `set_whitelist_enabled` carries
`#[only_owner]` (`controller/src/whitelist.rs`). Toggling purchase
availability is a trusted-role administration action by design.
*Tests:* `test_non_owner_set_whitelist_enabled_panics` proves a stranger
cannot flip the toggle without owner auth;
`test_whitelist_enabled_blocks_non_whitelisted_buyer` and
`test_whitelist_toggle_round_trip` cover the enforcement semantics
(`controller/src/test.rs`).

### Evicted-flight settlement is an owner recovery path

**Verified as correctly rejected.** `settle_evicted_flight` carries
`#[only_owner]` (`controller/src/settle.rs`) and refuses to run unless the
flight is genuinely stranded outside the normal keeper pipeline: it reverts
while the oracle `FlightData` row still exists (#316 — restorable flights must
go through restore-and-settle), while the flight is still keeper-enumerable
(#317), and for flights that were never purchased (#318). Settlement is
void-style only (premiums become vault income, never a payout), so the path
cannot be used to force a claim.
*Tests:* `test_settle_evicted_flight_unauthorized`,
`test_settle_evicted_flight_refuses_while_data_present`,
`test_settle_evicted_flight_refuses_while_still_listed`,
`test_settle_evicted_flight_refuses_unknown_flight`, and the happy-path
reconciliation test (`controller/src/test.rs`).

---

## Executive-summary mitigations — spot-checked at current `main`

The report credits five mitigations for the prior (July 4) issue classes; all
five are present:

- **Direct entry/exit blocked while settlement is pending** —
  `deposit`/`mint`/`withdraw`/`redeem` call `assert_no_settlement_pending`
  (`risk_vault/src/vault_ops.rs`, `risk_vault/src/auth.rs`); the barrier
  fails closed if the oracle is unwired.
- **Queue processing defers while settlement is pending** —
  `process_withdrawal_queue` is a no-op during the window
  (`risk_vault/src/capital.rs`), so queued exits are priced only
  post-settlement.
- **Snapshots price on managed assets** — `snapshot()` uses
  `get_total_managed_assets`, the same basis as executable conversions
  (`risk_vault/src/snapshot.rs`).
- **Max views mirror the executable gates** — `max_deposit`/`max_mint` return
  0 while paused or settlement-pending; `max_withdraw`/`max_redeem`
  additionally return 0 while the withdrawal queue is non-empty
  (`risk_vault/src/vault_ops.rs`).
- **Purchase-flow hardening** — `buy_insurance` enforces day-aligned dates
  (`DateNotDayAligned`), requires a live oracle sale authorization
  (`SaleNotOpen`), transacts at locked per-flight terms, and checks solvency
  against aggregate liabilities (`controller/src/purchase.rs`).

---

## Files changed in this pass

None — verification only.
