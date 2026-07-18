# cosminmarian53 Soroban Auditor Report (2026-07-14) — Remediation Summary

**Source report:** [`20260714_cosminmarian53_soroban_auditor_report.md`](../20260714_cosminmarian53_soroban_auditor_report.md)
**Audited commit:** `d7e6521` (main)
**Remediation date:** 2026-07-18
**Test status:** full workspace suite green — **466 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.

The report's single finding was validated as genuine and fixed.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| H-01 | High | Confirmed | ✅ Fixed (two-phase delayed LP pricing) |

> **Note — shared finding.** H-01 is the same issue independently reported as
> **C57-H02** in the Codex AI report of the same date. It was fixed once, by
> the two-phase LP-pricing redesign; both remediation summaries describe that
> single change. See
> [`20260714_codex_ai_remediation.md`](20260714_codex_ai_remediation.md) for
> the companion write-up.

---

## Fixed

### H-01 — Oracle reporting latency permits outcome-informed LPs to trade at stale NAV

**Confirmed (High).** The RiskVault settlement barrier keys off the oracle's
on-chain `PendingOutcomes` counter, which increments only when `set_landed` /
`set_cancelled` *writes* an outcome — strictly after that outcome becomes
publicly knowable off-chain (airline/AeroAPI/airport feeds), and only on the
executor's periodic cadence. In that gap the counter reads zero while the
result is already public, so the immediate `deposit` / `mint` / `withdraw` /
`redeem` paths priced shares at a stale NAV. The report's PoC demonstrated
both directions: an informed LP redeeming ahead of a known cancellation to
shift its loss to a passive LP, and an informed newcomer depositing ahead of
a known on-time result to dilute the incumbent's premium income.

**Fix — all LP entry and exit converted to two-phase delayed pricing**, the
report's recommended epoch/queue model whose price finalizes only after a
delay exceeding the oracle reporting-and-settlement window:

- The four immediate operations are permanently disabled
  (`DirectEntryDisabled` 727 / `DirectExitDisabled` 728); the `max_*` views
  return zero, and `preview_*` remain as explicit current-price quotes. The
  ERC-4626 surface is retained in the asynchronous-vault convention
  (ERC-7540 style) so stale callers get a typed revert naming the
  replacement path rather than a missing-function trap.
- LPs now commit through queues instead: `request_deposit` escrows the
  assets immediately (held outside `TotalManagedAssets`, backing no shares
  yet) and `request_withdrawal` escrows the shares. `cancel_deposit` /
  `cancel_withdrawal` return the escrow; cancellation carries no pricing
  optionality because a queued request always prices post-outcome.
- Queue processing (`process_deposit_queue` / `process_withdrawal_queue`,
  driven by the keeper's `run_queue_maintenance`) prices a request **only
  once it is older than `LP_PRICING_DELAY_SECS = 6 h`** — sized above the
  oracle pipeline's worst-case observation-to-write latency (fetcher every
  2 h, landed resolution waits ETA + 1 h, plus submission) with a
  missed-cycle margin — and **never while a written outcome is unsettled**
  (the original `PendingOutcomes` barrier still applies to the queue pass).
  By pricing time, every outcome knowable when the request was committed is
  on-chain: settled into the share price, or barrier-held until settlement.

The freshness signal is therefore no longer the posted counter alone but the
combination of a request-maturity delay (covering the pre-write window the
counter cannot see) and the existing pending-outcome barrier (covering the
post-write window) — exactly the layered guarantee the report asked for.

**Residuals (documented in `spec/architecture.md`):** an oracle-pipeline
outage lasting longer than the pricing delay reopens the window, for which
the operational requirement is to pause the vault (queue processing stops
with it) — the sale authorizer's fail-closed windows halt new exposure in the
same outage. Void-path premium income, being deterministically predictable
arbitrarily far ahead of its on-chain recognition, is not closed by any delay
and remains an accepted, premium-bounded exposure.

*Files:* `risk_vault/src/{vault_ops,claims,capital,storage,constants,error,events,queries,auth,lib}.rs`,
`controller/src/{settle,interfaces}.rs`.

*Tests:* the vault suite was reworked around the two-phase flow (78 tests).
Two tests directly reproduce the report's PoC directions and assert the
attack no longer pays:

- `test_informed_exit_cannot_dodge_a_pending_loss` — an LP that commits an
  exit before a cancellation is written still prices post-loss (its queued
  request only matures and processes after settlement recognizes the loss),
  ending at the same per-share value as the passive LP;
- `test_informed_entry_cannot_capture_a_pending_gain` — an entrant that
  commits before an on-time premium is recognized is minted only after the
  income is in TMA, so it cannot dilute the incumbent.

The stateful property/invariant machine was extended with the request /
cancel / process operations, ledger-time advancement across the delay, and
the widened conservation identity
(`balance = TMA + Σclaimable + Σdeposit escrow`); the fuzz target and the
controller/pool/integration harnesses were converted to the
request → mature → process flow. The report's temporary
`x_ray_poc.rs` was already removed by the auditor and is not present in the
tree.

---

## Interface changes in this pass

(Identical to the C57-H02 remediation — one shared change.)

- `RiskVault` — `deposit` / `mint` / `withdraw` / `redeem` now revert
  (`DirectEntryDisabled` 727 / `DirectExitDisabled` 728) and `max_*` return
  zero; new entries `request_deposit`, `cancel_deposit`,
  `process_deposit_queue` (controller-only); new views `get_deposit_queue`,
  `get_deposit_queue_len`; new type `DepositRequest`; `WithdrawalRequest`
  gains `requested_at`; new storage variant `VaultKey::DepositQueue`; new
  events `dep_req`, `dep_cancel`, `dep_minted`, `dep_dropped`; new error
  `DepositQueueFull` (729); withdrawal-queue cap reduced 250 → 150 (shared
  instance-entry budget with the new queue).
- `Controller` — `run_queue_maintenance` additionally calls
  `process_deposit_queue` (deposits first, so fresh entries can fund matured
  exits in the same pass).
- **Deployment notes:** upgrading an existing vault requires the withdrawal
  queue to be **empty** at upgrade (`requested_at` changes the stored
  layout); the `frontend/` and `frontend2/` dApps still call the removed
  immediate operations and need binding regeneration plus a request/cancel UI
  at redeploy (the playground is already updated).

## Documentation updated

`spec/architecture.md`, `spec/simple_architecture.md`,
`sequence_diagrams.md`, docs site pages `contracts/risk-vault.md`,
`concepts/solvency-and-safety.md`, `guides/provide-liquidity.md`,
`playground/lib/registry.ts`, `playground/app/account/page.tsx`.
