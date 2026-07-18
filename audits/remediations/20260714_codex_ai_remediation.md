# Codex AI Report (2026-07-14) — Remediation Summary

**Source report:** [`20260714_codex_ai_report.md`](../20260714_codex_ai_report.md)
**Audited commit:** `d7e6521` (main)
**Remediation date:** 2026-07-18
**Test status:** full workspace suite green — **466 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.
Executor (TypeScript) changes verified by review — the executor is not part
of the CI test suite.

All five findings were validated as genuine against the current sources and
fixed.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| C57-H01 | High | Confirmed | ✅ Executor revocation ordering fixed; the bounded contract-level window remains the previously documented accepted residual |
| C57-H02 | High | Confirmed | ✅ Fixed (two-phase delayed LP pricing — the report's primary recommendation) |
| C57-M01 | Medium | Confirmed | ✅ Fixed (exact-tuple classify/settle entry points + executor targeting + settler drain loop) |
| C57-M02 | Medium | Confirmed | ✅ Fixed (per-signer submission serialization + sequence-conflict retry) |
| C57-M03 | Medium | Confirmed | ✅ Fixed (loopback bind, bearer-token auth, rate limit, overlap guard) |

---

## Fixed

### C57-H01 — Live sale authorizations preserve a post-cancellation purchase window

**Confirmed (High).** The shipped SaleAuthorizer called only the pause-gated
`set_cancelled` when it observed a cancellation. During an oracle pause that
write fails, leaving the live sale authorization purchasable after unpause —
the executor-side extension of the known revocation-latency window.

**Fix:** on an observed cancellation the authorizer now submits the
pause-exempt `close_sale` **first** (revoking the live window even while the
oracle contract is paused), then attempts the `set_cancelled` tombstone. A
failed tombstone write no longer leaves a purchasable window behind. The
contract-level residual (revocation latency bounded by authorization
validity) is unchanged and remains the explicitly documented accepted risk
from the original CAI-H01 remediation; C57-H02's pricing delay independently
removes the LP-side profit from the same interval.

*Files:* `executor/centralized_cron/src/sale_authorizer.ts`.

### C57-H02 — Off-chain-public outcomes let informed LPs trade at stale NAV

**Confirmed (High;** independently reported with a PoC in the parallel
cosminmarian53 report**).** The vault's settlement barrier keys off
`PendingOutcomes`, which only increments when the oracle *writes* an outcome
— strictly after it becomes publicly knowable. Immediate
deposit/mint/withdraw/redeem therefore priced at a stale NAV in that window.

**Fix — all LP entry and exit converted to two-phase delayed pricing** (the
report's recommendation 1):

- The four immediate operations are permanently disabled
  (`DirectEntryDisabled` 727 / `DirectExitDisabled` 728); the `max_*` views
  return zero; `preview_*` remain as explicit current-price quotes. The
  ERC-4626 surface is retained in the asynchronous-vault convention
  (ERC-7540 style).
- New entry queue: `request_deposit` escrows the assets immediately
  (excluded from TMA — the conservation identity becomes
  `balance = TMA + Σclaimable + Σdeposit escrow`, and the
  `recover_uncollected` surplus bound now subtracts the escrow);
  `cancel_deposit` returns it; controller-only `process_deposit_queue` mints
  matured requests at the then-current price and returns zero-share requests
  (`dep_dropped`).
- Both queues price a request only once it outlives
  `LP_PRICING_DELAY_SECS = 6 h` (sized above the oracle pipeline's ~3 h
  worst-case observation-to-write latency plus a missed-cycle margin) and
  never while a written outcome is unsettled. By pricing time, everything
  knowable at commitment is settled into the price or barrier-held; request
  cancellation carries no pricing optionality.
- `WithdrawalRequest` gains the load-bearing `requested_at` field;
  `run_queue_maintenance` processes deposits before withdrawals.

**Residuals (documented in `spec/architecture.md`):** an oracle outage longer
than the pricing delay reopens the window — the operational requirement is to
pause the vault; and void-path income, being predictable arbitrarily far in
advance, is not closed by any delay (exposure remains bounded by the voided
premiums, as before).

*Files:* `risk_vault/src/{vault_ops,claims,capital,storage,constants,error,events,queries,auth,lib}.rs`,
`controller/src/{settle,interfaces}.rs`.
*Tests:* vault suite reworked around the two-phase flow (78 tests), including
the attack scenarios `test_informed_exit_cannot_dodge_a_pending_loss` and
`test_informed_entry_cannot_capture_a_pending_gain`; property/invariant
machine extended with request/cancel/process ops, time advancement, and the
new conservation identity; fuzz target updated; controller, pool, and
integration harnesses converted to the request → mature → process flow.

### C57-M01 — Mixed active-flight enumeration can hold the settlement barrier

**Confirmed (Medium).** Both keeper passes consumed only rotating windows
(25/10 slots) over the mixed active set, so outcome-to-settlement latency —
and with it the vault-wide barrier duration — grew linearly with total
occupancy.

**Fix — the report's recommendation 2, plus its interim recommendation 4:**

- New keeper-gated exact-tuple entry points `classify_flight(keeper,
  flight_id, date) -> bool` and `settle_flight(...) -> bool`, sharing the
  sweep loops' extracted logic so the paths cannot drift. Both require the
  flight to be active-listed (`FlightNotListed` 321 — tombstones and evicted
  flights unreachable) and are idempotent on state.
- The executor drives every outcome it writes straight through classify →
  settle (fetcher and sale authorizer), so the barrier releases within
  seconds regardless of active-set size; the sweeps remain repair backstops.
- The settler cron now drains: it loops classify + settle passes while
  `PendingOutcomes > 0` (bounded per run, early-out when stalled) and submits
  nothing when nothing is pending.

*Files:* `controller/src/{settle,error}.rs`,
`executor/centralized_cron/src/{targeted_settlement,flight_data_fetcher,sale_authorizer,settlement_executor}.ts`.
*Tests:* nine controller unit tests (targeted lifecycle, idempotency,
not-listed and auth gates) and the integration test
`targeted_classify_and_settle_bypasses_sweep_rotation` (barrier releases
while unrelated flights sit unclassified in the set).

### C57-M02 — Colliding keeper crons can race one account sequence

**Confirmed (Medium).** Same-key jobs independently fetched the source
account and could build two transactions on one sequence, with no retry.

**Fix:** a module-global per-signer lock now serializes the entire
getAccount → build → simulate → sign → submit → poll lifecycle across every
client instance (cron and HTTP alike), with a bounded retry on `txBadSeq`
that refetches the account and rebuilds from scratch. Every job additionally
runs single-flight (an overlapping tick or trigger is skipped/rejected), and
the hourly classifier moved off the shared `:00` tick as defense-in-depth.

*Files:* `executor/centralized_cron/src/{soroban_client,job_lock,index}.ts`.

### C57-M03 — Unauthenticated executor triggers expose signer-backed jobs

**Confirmed (Medium; deployment-conditional).** The Express server exposed
six signer-backed POST triggers with no authentication, no rate limit, no
overlap guard, wildcard CORS, and an all-interfaces default bind.

**Fix:** the server binds `127.0.0.1` unless `HOST` is set explicitly; every
trigger requires an `EXECUTOR_API_TOKEN` bearer token (timing-safe compare,
**triggers disabled entirely when unset** — crons unaffected, fail closed),
is rate-limited (30/min), and answers 409 while the same job is in flight;
CORS headers are emitted only for an explicitly configured
`CORS_ALLOWED_ORIGIN`. The read-only health/log endpoints stay open.

*Files:* `executor/centralized_cron/src/server.ts`.

---

## Interface changes in this pass

- `RiskVault` — `deposit`/`mint`/`withdraw`/`redeem` now revert
  (`DirectEntryDisabled` 727 / `DirectExitDisabled` 728) and `max_*` return
  zero; new entries `request_deposit`, `cancel_deposit`,
  `process_deposit_queue` (controller-only), views `get_deposit_queue`,
  `get_deposit_queue_len`; new type `DepositRequest`; `WithdrawalRequest`
  gains `requested_at`; new storage variant `VaultKey::DepositQueue`; new
  events `dep_req`, `dep_cancel`, `dep_minted`, `dep_dropped`; new error
  `DepositQueueFull` (729); withdrawal-queue cap reduced 250 → 150 (shared
  instance-entry budget with the new queue).
- `Controller` — new keeper entries `classify_flight` / `settle_flight`; new
  error `FlightNotListed` (321); `run_queue_maintenance` additionally calls
  `process_deposit_queue`.
- Executor — new env vars `HOST`, `EXECUTOR_API_TOKEN`, `CORS_ALLOWED_ORIGIN`;
  classifier cron at `:01`.
- **Deployment notes:** upgrading an existing vault requires the withdrawal
  queue to be **empty** at upgrade (`requested_at` changes the stored
  layout); the `frontend/` and `frontend2/` dApps still call the removed
  immediate operations and need binding regeneration plus a request/cancel
  UI at redeploy (the playground is already updated); operators must set
  `EXECUTOR_API_TOKEN` to keep manual triggers usable.

## Documentation updated

`spec/architecture.md` (two-phase entry/exit, storage layout + upgrade
runbook, exact-tuple entry points, settler drain loop, known limitations),
`spec/simple_architecture.md`, `sequence_diagrams.md` (underwriter flow,
targeted settlement note), docs site pages `contracts/risk-vault.md`,
`contracts/controller.md`, `concepts/solvency-and-safety.md`,
`guides/provide-liquidity.md`, `developers/executor.md`,
`playground/lib/registry.ts`, `playground/app/account/page.tsx`.
