# Nethermind AuditAgent RiskVault Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_auditagent_ai_risk_vault_report.md`](../20260704_auditagent_ai_risk_vault_report.md)
**Audited commit:** `6b0db9e` (main)
**Remediation date:** 2026-07-10
**Test status:** full workspace suite green — **345 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| AA-RV-01 | Medium | Confirmed | ✅ Mitigations applied (request-value floor + saturation observability); keyed-entry queue migration deferred |
| AA-RV-02 | Low | Confirmed at audited commit | ✅ Already fixed in this remediation series; verified |
| AA-RV-03 | Low | Confirmed | ✅ Fixed (zero-result conversions rejected on all four paths) |
| AA-RV-04 | Informational | Confirmed at audited commit | ✅ Basis already fixed; divergence-from-previews now documented |

---

## Mitigated (architectural fix deferred)

### AA-RV-01 — Sybil addresses can monopolize the bounded withdrawal queue
**Confirmed (Medium).** The queue caps 250 total requests and 20 per address,
but the per-address cap binds to an address, not an economic actor: one
participant can split shares across ~13 addresses and occupy every slot with
requests that only need to preview above zero. While the queue is non-empty,
direct `withdraw`/`redeem` revert, so later underwriters lose both exit paths
until the keeper drains slots or the occupier cancels.

**Mitigations applied** (the report's recommendations 1 and 5):

- **Owner-configurable minimum request value.** New owner-only
  `set_min_withdrawal_request(min_assets)` (with `get_min_withdrawal_request`
  view); `request_withdrawal` rejects any request whose asset preview is below
  the floor with `RequestBelowMinimum`. Each of the 250 slots now costs real
  escrowed capital — with a floor of *M*, saturating the queue escrows
  `250 × M` in the vault for the duration of the occupation, instead of ~zero.
  The floor is a deployment parameter (the vault is asset-agnostic, so a
  hardcoded constant can't be right across decimals/denominations); zero — the
  default — disables it, and deployment/ops must set a value meaningfully
  above dust but well below typical LP position sizes so small underwriters
  can still queue exits. Raising it is also the operator's response lever if
  occupation is observed. The step is recorded in the deployment runbook
  (`spec/architecture.md`, post-deployment wiring) and scripted in the
  `deploy-testnet` target of `contracts/Makefile`. Consistent with the
  project's bounded-owner-setter convention, enforcement is clamped at
  request time to `TMA / 2500`: no configured value — mistaken or hostile —
  can exclude a position above 0.04% of the vault from the queue, while
  filling all 250 slots at the clamped floor still escrows ~10% of managed
  assets.
- **Saturation observability.** New `get_withdrawal_queue_len()` view and a
  `WithdrawalRequested` event (`["sentinel","wd_req"]`) emitted on every
  accepted request carrying the post-push queue occupancy. Operators can
  alert as occupancy approaches the cap and react (drain more frequently,
  raise the floor) before new exit requests start being rejected.

Existing dynamics already bound the attack's duration: whenever free capital
exists the keeper's FIFO drain converts the occupier's head requests into
claimable balances (burning their shares — occupation consumes the attacker's
own vault position), and requests that decay to zero value are evicted rather
than pinned.

> **Deferred (documented):** the structural fix — the report's option 3,
> individually keyed request entries with head/tail metadata and paginated
> processing, so a bounded shared vector is no longer the scarce resource —
> is the same monolithic-vector migration already deferred for the oracle and
> pool active-flight lists (see the
> [Nemesis 2026-07-04 remediation](20260704_nemesis_auditor_remediation.md),
> NM-002). Options 2 (admission fees) and 4 (stake-weighted admission) were
> considered and not adopted: fees destroy honest-user value, and share-based
> weighting is itself Sybil-splittable.

*Files:* `risk_vault/src/{admin,claims,queries,events,storage,error}.rs`.
*Tests:* `test_min_withdrawal_request_floor_enforced` (floor off by default,
enforced when set, large requests pass, negative floor rejected),
`test_queue_len_query_and_request_event`.

---

## Fixed

### AA-RV-03 — Zero-result conversions can donate user value
**Confirmed (Low).** `deposit` passed floor-rounded conversion results straight
into the OZ vault plumbing: a positive deposit small enough to floor to zero
shares transferred the assets in, increased `TotalManagedAssets`, and minted
nothing — silently donating the caller's value to existing holders. A dust
`redeem` symmetrically burned shares and returned zero assets (its zero
output also passed the free-capital check trivially). `withdraw` and `mint`
accepted non-positive inputs as no-ops.

**Fix:** all four executable paths now validate inputs and reject zero-result
conversions, per the report's recommendation:

- `deposit` — rejects `assets <= 0` (`AmountMustBePositive`) and a conversion
  that floors to zero shares (new `AssetsConvertToZeroShares`);
- `redeem` — rejects `shares <= 0` (`SharesMustBePositive`) and a conversion
  that floors to zero assets (reusing `SharesRedeemToZeroAssets`, the same
  error the queue path already used for dust requests);
- `withdraw` — rejects `assets <= 0`; its share conversion rounds Ceil, so a
  positive input can never burn zero shares;
- `mint` — rejects `shares <= 0`; its asset conversion rounds Ceil, so a
  positive mint can never pull zero assets.

*Files:* `risk_vault/src/vault_ops.rs`, `risk_vault/src/error.rs`.
*Tests:* `test_deposit_rejects_nonpositive_and_zero_share_amounts` (inflates
the share price via premium income until a 1-stroop deposit previews to zero
shares, then asserts rejection), `test_redeem_rejects_nonpositive_and_zero_asset_dust`,
`test_withdraw_and_mint_reject_nonpositive_inputs`.

---

## Previously fixed — verified against this report

### AA-RV-02 — `max_withdraw` and `max_redeem` ignore active withdrawal queue
**Confirmed (Low) at the audited commit; already fixed in this remediation
series** (same finding as L-02 of the
[cosminmarian53 2026-07-04 remediation](20260704_cosminmarian53_soroban_auditor_remediation.md)).
`max_withdraw`/`max_redeem` return 0 whenever direct exits are globally
disabled — queue active, paused, or settlement pending — and
`max_deposit`/`max_mint` return 0 whenever entries are disabled. The
conformance tests the report asks for exist:
`test_max_views_return_zero_while_queue_active`,
`test_max_views_return_zero_when_paused`, plus the pending-outcome assertions
in `lp_cannot_transact_at_stale_price_during_pending_outcome`.
*Files:* `risk_vault/src/vault_ops.rs` (no further change needed this pass).

### AA-RV-04 — Share-price snapshots use raw token balance instead of managed assets
**Confirmed (Informational) at the audited commit; the pricing basis was
already fixed** in commit `e4a4a17` (NM-003 of the
[Nemesis remediation](20260704_nemesis_auditor_remediation.md)): `snapshot()`
prices on `get_total_managed_assets`, excluding uncollected claimable
liabilities and donations, with regression test
`test_snapshot_uses_managed_assets_not_physical_balance`.

This pass addresses the report's remaining documentation point: the snapshot
formula deliberately omits the virtual-offset terms (+1 / +10^offset) that the
conversion helpers add as an inflation-attack defense. The code now documents
that the recorded price is the exact net-backing-per-share ratio
(`TMA * scale / supply`) — the vault's NAV per share, not an executable
preview quote — which can diverge from `preview_*` only at near-zero supply.
*Files:* `risk_vault/src/snapshot.rs` (documentation).

---

## Files changed in this pass

Source: `risk_vault/src/{vault_ops,claims,admin,queries,events,storage,error}.rs`
(AA-RV-01 mitigations, AA-RV-03 guards); `risk_vault/src/snapshot.rs`
(AA-RV-04 documentation).
Tests: `risk_vault/src/test.rs`.
