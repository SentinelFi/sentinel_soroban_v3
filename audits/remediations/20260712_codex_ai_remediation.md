# Codex AI Missed-Issue Review (2026-07-12) — Remediation Summary

**Source report:** [`20260712_codex_ai_report.md`](../20260712_codex_ai_report.md)
**Audited commit:** `fcde5aa` (main)
**Remediation date:** 2026-07-13
**Test status:** full workspace suite green — **428 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.
Executor (TypeScript) comment updates verified by review — the executor is
not part of the CI test suite.

All four findings were validated as genuine at the audited commit. C56-M01
and C56-M02 share their root causes with NM-001/NM-002 of the
[Nemesis 2026-07-12 report](20260712_nemesis_auditor_remediation.md) and were
fixed earlier in this same remediation branch; this pass verified those fixes
against this report's specific recommendations. C56-L03 and C56-M04 are new
and were fixed in this pass.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| C56-M01 | Medium | Confirmed | ✅ Fixed on this branch (reserve-aware withdrawable capital); verified against this report |
| C56-M02 | Medium | Confirmed | ✅ Fixed on this branch (snapshot terms re-validated vs current limits); verified against this report |
| C56-L03 | Low | Confirmed | ✅ Fixed in this pass (explicit approval deadline replaces TTL-as-expiry) |
| C56-M04 | Medium | Confirmed | ✅ Fixed in this pass (settlement window resized + operator-bounded variant) |

---

## Previously fixed on this branch — verified against this report

### C56-M01 — Vault exits can remove the configured solvency reserve

**Confirmed (Medium).** Identical root cause to Nemesis NM-001: the ratio was
enforced only at policy admission, while every exit gated on the nominal
`TMA − locked`. Fixed earlier on this branch — see the
[Nemesis remediation](20260712_nemesis_auditor_remediation.md) for the full
description.

Verification against this report's recommendation list:

- *One canonical required-reserve calculation* —
  `RiskVault::get_withdrawable_capital()` implements exactly the report's
  `max(TMA − ceil(locked × ratio / 100), 0)` and gates direct `withdraw` /
  `redeem`, the `max_withdraw` / `max_redeem` views, and
  `process_withdrawal_queue`.
- *"The vault must know the applicable ratio, either by storing a
  controller-set value…"* — implemented as the controller-set value:
  `Controller::set_solvency_ratio` mirrors the ratio into the vault
  atomically via a controller-only vault setter (a read-back is impossible —
  the controller invokes queue processing, and a vault→controller call
  during it would be reentrant).
- *Invariant tests across purchase, direct withdrawal, redeem, queue
  processing* — added with the fix
  (`test_solvency_reserve_gates_direct_exit`,
  `test_redeem_into_solvency_reserve_panics`,
  `test_queue_processing_holds_back_solvency_reserve`,
  `lp_exit_cannot_drain_solvency_reserve`). The report's observation that
  `solvency_ratio_enforced_on_aggregate_liabilities` never exercised an exit
  is correct — the new integration test performs exactly the missing
  post-purchase exit and asserts the ratio survives it.

### C56-M02 — Cached flight terms bypass newly lowered governance limits

**Confirmed (Medium).** Identical root cause to Nemesis NM-002. Fixed earlier
on this branch: the report's design option 1 was implemented —
`GovernanceModule::terms_valid(ResolvedTerms)` (the requested
"`terms_within_current_limits`" check, delegating to the same predicate
`route_status` uses so the two can never drift) is required by
`Controller::buy_insurance` on the pool-snapshot terms **before any premium
is collected or collateral locked**, failing with `SnapshotTermsExceedLimits`.
Price immutability inside a bucket is preserved for existing policies; only
admission of new buyers is judged against the current limits — exactly the
report's "do not conflate price immutability with authorization to continue
selling."

The integration test the report asks for exists verbatim:
`test_buy_insurance_rejects_snapshot_above_lowered_term_limits` registers a
bucket, lowers the limits, updates the route to compliant current terms, and
proves the second purchase is blocked; the companion
`test_lowered_term_limits_leave_new_buckets_sellable` proves fresh dates
still sell and the closed bucket's stored terms and buyer count stay intact.

---

## Fixed in this pass

### C56-L03 — Archived whitelist approvals restore instead of expiring

**Confirmed (Low).** The whitelist stored a bare `bool` in Persistent storage
and documented its ~180-day TTL as the approval lifetime ("the archived entry
reads as not-whitelisted"). That model cannot work on the target protocol:
an expired Persistent entry is archived, not deleted — on next access it is
restored with its original value before the contract runs (or the invocation
fails pre-execution), so a dormant `true` approval could never lapse. The
documented re-attestation policy was unenforced; only explicit revocation
worked.

**Fix — the report's preferred design (explicit deadline, option 1):**

- Approvals now store an explicit expiry timestamp
  (`CtrlKey::BuyerApprovalExpiry(Address)` → u64): `add_whitelisted_buyer`
  writes `now + 180 days`, the purchase gate and `is_whitelisted` require
  `now < expires_at`, and `remove_whitelisted_buyer` overwrites the deadline
  with 0 — so a later archival restore brings back a revocation or a dated
  approval, never a fresh authorization. Business authorization lifetime is
  now fully separated from network storage lifetime.
- The sliding-renewal intent is preserved: each gated purchase rewrites the
  deadline to `now + 180 days` (not merely the TTL), so an actively-buying
  address never needs re-approval while a dormant one lapses by the ledger
  clock. The renewal refuses to slide an expired or revoked deadline — a
  maintenance write must never become a re-approval no admin signed.
- The old `BuyerWhitelisted(Address)` key is retired (documented in the key
  enum, not reused). Legacy `bool` entries are deliberately ignored by the
  new gate: previously approved buyers read as not-approved until an admin
  re-attests them — the fail-closed direction, and precisely the
  re-attestation the old model promised but couldn't deliver.
- Stale claims in code comments and query docs ("archived entry reads as
  not-whitelisted") were corrected everywhere they appeared.

*Files:* `controller/src/{constants,storage,whitelist,queries}.rs`.
*Tests:* `dormant_approval_expires_even_though_entry_persists` — the test the
report asks for: the stored entry survives (exactly the state a restoration
produces) while the ledger clock passes the deadline, and the purchase gate
fails closed; re-approval restores purchasability.
`active_buyer_approval_slides_forward_on_each_purchase` — a purchase just
before the original deadline keeps the buyer valid past it
(`integration_tests/src/tests/group9_whitelist.rs`). All pre-existing
whitelist unit and integration tests pass unchanged.

### C56-M04 — Fixed 25-flight settlement batch exceeds transaction limits

**Confirmed (Medium).** The 25-flight batch was sized when a settled flight
touched ~2 persistent entries (oracle `FlightData` + pool `FlightConfig`).
The later active-set pagination added per-flight swap-removal writes on the
pool side (removed entry's index, its page, the moved tail entry's index,
the tail page, the shared count), which the old estimate never included. Per
the report's measurement, a worst-case 25-flight all-cancelled window writes
~83 ledger entries and emits ~18 KB of events — past the ~50-write and 16 KB
per-transaction budgets — and because invocation failure is atomic, the
fixed-size window would revert without advancing its cursor and every retry
would fail identically, freezing settlement (and, through the pending-outcome
barrier, LP entry/exit) exactly during a correlated cancellation event.

**Fix — both halves of the report's recommendation:**

- **Separately sized windows.** `MAX_CLASSIFY_BATCH = 25` (classification
  rewrites at most one oracle status per flight) and `MAX_SETTLE_BATCH = 10`
  for settlement. At ~3.3 writes and ~724 event bytes per settled flight
  plus shared overhead, a 10-flight worst case lands near ~40 writes and
  ~7 KB of events — inside the budgets with margin for accounting drift.
  The rotating cursor is unchanged, so larger backlogs drain across
  successive keeper runs (the 5-minute cadence still clears 120 flights/hour).
- **Keeper-retryable sub-windows.** New entry point
  `execute_settlements_bounded(keeper, limit)` (limit clamped to
  `[1, MAX_SETTLE_BATCH]`) shares the same settlement pass, so an operator
  can always shrink a stuck window — down to a single flight — and keep the
  cursor advancing. `execute_settlements` keeps its signature (the executor
  cron needs no change) and delegates to the same bounded pass at the
  default size.
- Considered and not taken: decoupling active-set pruning from financial
  settlement (the report's "preferable" variant). Deferring removals would
  leave settled buckets occupying the pool's capacity gate and enumeration
  windows until a second permissionless sweep ran, adding a new liveness
  dependency to fix a footprint problem the resized window already bounds;
  with the bounded variant available down to one flight, the added
  complexity buys no remaining failure mode.

*Files:* `controller/src/{constants,settle}.rs`,
`executor/centralized_cron/src/settlement_executor.ts` (comment only —
signature unchanged).
*Tests:* `saturated_cancelled_window_settles_across_bounded_batches` — 12
publicly cancelled insured flights (more than one window): the first
settlement call processes exactly one full window and leaves the barrier up,
the second drains the rest and the barrier lifts
(`integration_tests/src/tests/group5_edge_cases.rs`);
`test_execute_settlements_bounded_clamps_and_advances` — limit 0 clamps to 1,
each call settles a sub-window and advances the cursor, an oversized limit
clamps to the contract maximum (`controller/src/test.rs`). Native tests
cannot enforce the network's entry-count/event-size limits (the report's
measurement used a disabled-enforcement host); these tests pin the batching
and liveness behavior the resized constants rely on.

---

## Interface changes in this pass

- `Controller` — new keeper entry point
  `execute_settlements_bounded(keeper, limit)`; `execute_settlements` and
  `classify_flights` keep their signatures (settlement now processes at most
  10 per call, classification 25). New persistent key
  `BuyerApprovalExpiry(Address)`; `BuyerWhitelisted(Address)` retired.
  `is_whitelisted` keeps its signature (semantics: valid = unexpired).
- No vault, pool, oracle, or governance changes in this pass; no error-code
  changes.
- **Deployment notes for existing deployments:** (1) whitelist — legacy
  approvals are ignored after upgrade; if the whitelist toggle is on,
  re-approve current buyers (one admin call each; the feature ships
  default-off). The off-chain TTL cron may drop `BuyerWhitelisted` keys from
  its footprint; extending `BuyerApprovalExpiry` entries is optional, since
  an archived entry restores with its deadline intact. (2) settlement —
  throughput per keeper call drops 25 → 10; at the standard 5-minute cadence
  that is still 120 flights/hour, so no cron change is needed.

## Documentation updated

`spec/architecture.md` (whitelist lifetime model, controller storage layout,
keeper entry points incl. the bounded variant, batch-size rationale in the
operational-limits section), `docs/docs/contracts/controller.md` (whitelist
expiry, settlement windows), `executor/centralized_cron/src/settlement_executor.ts`
header comment, `playground/lib/registry.ts` (bounded entry point,
`is_whitelisted` description).
