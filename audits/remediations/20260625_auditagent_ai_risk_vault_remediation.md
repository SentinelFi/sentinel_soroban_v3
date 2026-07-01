# Nethermind AuditAgent AI — RiskVault Report — Remediation Summary

**Source report:** [`20260625_auditagent_ai_risk_vault_report.md`](../20260625_auditagent_ai_risk_vault_report.md)
**Remediation date:** 2026-07-01
**Scope:** `contracts/risk_vault` (+ its `stellar-tokens` vault dependency and the
Controller settlement integration for cross-checking).
**Test status:** full workspace suite green — **325 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

Each finding was validated against source, then fixed. AA-RV-01 is the
share-pricing accounting flaw that earlier passes (Nemesis NM-002, cosminmarian
H-01, Codex "claimable liabilities") deferred as an architectural rewrite; it is
**fixed here**, which closes that finding across all four reports.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-RV-01 | High | Confirmed | ✅ Fixed (share pricing on managed-asset basis) |
| AA-RV-02 | Medium | Confirmed | ✅ Fixed (zero-value requests returned, not pinned) |
| AA-RV-03 | Medium | Confirmed | ✅ Fixed / mitigated (queue length + per-address caps) |

---

## Fixed

### AA-RV-01 — Claimable withdrawal liabilities inflate the asset basis used for share pricing
**Confirmed (High).** `process_withdrawal_queue` burns the escrowed shares,
reduces `TotalManagedAssets` (TMA), and credits a `ClaimableBalance`, but leaves
the owed tokens physically in the vault until `collect`. The OpenZeppelin `Vault`
conversion math prices shares off the vault's **raw token balance**, which still
includes those owed-but-uncollected assets. Existing shareholders could therefore
extract value from a later depositor whose deposit was priced against the
inflated balance (auditor PoC: a victim's ~500 deposit captured almost entirely).

**Root-cause insight that made the fix contained:** the two figures differ by
exactly the uncollected claimable amount — `raw_balance == TMA + uncollected_claimable`
— so **TMA is precisely the net backing basis** the vault should price on, and it
is already tracked exactly.

**Fix:** RiskVault now computes every share/asset conversion on TMA rather than
the raw balance, while reusing the audited OZ share-mint/burn + transfer plumbing:
- Added `managed_convert_to_shares` / `managed_convert_to_assets` helpers that
  mirror the OZ formula `shares = assets · (total_supply + 10^offset) / (TMA + 1)`
  (and its inverse), preserving the virtual-offset inflation-attack defense and
  the directional rounding, but reading TMA instead of `Vault::total_assets`.
- `deposit` / `mint` / `withdraw` / `redeem` now derive the share/asset amounts
  from those helpers and call OZ's public `Vault::deposit_internal` /
  `Vault::withdraw_internal` + `emit_deposit` / `emit_withdraw` for the actual
  transfer, mint/burn, allowance handling, and events (instead of delegating to
  `Vault::deposit`/`redeem`, which convert against the raw balance).
- `total_assets` now returns TMA; `convert_to_*`, all `preview_*`, and
  `max_withdraw` / `max_redeem` route through the managed-asset helpers.
- `process_withdrawal_queue` and `request_withdrawal` value shares via the same
  managed basis, so queue previews and the dust-rejection check are consistent.

*Files:* `risk_vault/src/{vault_ops,capital,claims}.rs`.
*Tests:* `test_claimable_liabilities_do_not_inflate_shares` reproduces the
auditor's exploit (A queues+processes a withdrawal, a victim deposits, B redeems)
and asserts B cannot seize more than its ~500 fair share, the victim's stake is
preserved, and A's claimable is intact; the existing deposit/redeem/queue tests
continue to pass unchanged (equivalent behavior when there is no uncollected
claimable).

### AA-RV-02 — Requests that become zero-valued can permanently pin the withdrawal batch
**Confirmed (Medium).** A request valid at submission can round to zero assets
after an insurance payout reduces the share price. The drain loop previously
*kept* zero-value entries; a full `MAX_QUEUE_BATCH` window of them left `processed
== 0`, so the queue was never rewritten and later valid requests (and, because
the queue is non-empty, direct exits) were starved.

**Fix:** when a queued request previews to zero assets during processing, the
vault now **returns the escrowed shares to the owner and drops the request**
(instead of keeping it), and rewrites the queue whenever anything was returned or
processed. The owner keeps their shares and may re-request; the queue always
advances, so a batch of decayed-to-zero dust can no longer pin the head.
*Files:* `risk_vault/src/capital.rs`.
*Test:* `test_zero_value_request_returned_not_pinned` (a dust request at the head
decays to zero after a payout; processing returns its shares, drops it, and still
services the valid request behind it).

### AA-RV-03 — Monolithic withdrawal queue imposes a hard request-capacity ceiling
**Confirmed (Medium).** The whole queue is one `Vec` in the contract-instance
entry, which Soroban bounds to 65,536 bytes (~385 requests in the assessed
layout). An unbounded queue could grow until that entry became unwritable,
freezing all queue operations, and a single underwriter could fill it to starve
others.

**Fix (bounded mitigation):** two caps enforced at `request_withdrawal`:
- **Global length cap** `MAX_WITHDRAWAL_QUEUE_LEN = 250` — keeps the queue well
  below the entry-size limit with headroom for other instance state, turning the
  ungraceful 64KB failure into a clean early `WithdrawalQueueFull` rejection.
- **Per-address cap** `MAX_ACTIVE_REQUESTS_PER_ADDRESS = 20` — a single address
  cannot monopolize the shared capacity (`TooManyActiveRequests`). Enforced by
  counting the caller's live entries in the already-loaded queue (no extra
  storage key or decrement bookkeeping — cancel/process naturally reduce it).

*Files:* `risk_vault/src/{constants,error,claims}.rs`.
*Tests:* `test_per_address_active_request_cap` (21st request rejected) and
`test_withdrawal_queue_global_length_cap` (251st request across distinct
addresses rejected).

> **Deferred (documented):** the auditor's primary recommendation — replacing the
> monolithic vector with individually-keyed requests and head/tail pointers — is
> a storage-layout migration that belongs with the broader monolithic-collection
> sharding work (Nemesis NM-006 / AuditAgent ActiveFlightList findings) and is
> not included here. The length + per-address caps make the current design safe
> in the interim: the entry can no longer reach the size limit, and no single
> actor can monopolize the queue.

---

## Files changed

Source (5): `risk_vault/src/{vault_ops,capital,claims,constants,error}.rs`.
Tests (1): `risk_vault/src/test.rs`.
