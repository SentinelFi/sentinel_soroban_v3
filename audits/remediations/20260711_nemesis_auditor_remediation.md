# Nemesis AI Auditor Report (2026-07-11) — Remediation Summary

**Source report:** [`20260711_nemesis_auditor_report.md`](../20260711_nemesis_auditor_report.md)
**Audited commit:** `cdac8a8` (main)
**Remediation date:** 2026-07-11
**Test status:** full workspace suite green — **406 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.
Executor (TypeScript) changes verified by review — the executor is not part
of the CI test suite.

Both findings were validated as genuine at the audited commit and at current
`main` before fixing.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| NM-001 | Medium | Confirmed | ✅ Fixed (active-flight lists migrated to paginated keyed storage — no more protocol-wide 1,000-flight admission ceiling) |
| NM-002 | Medium | Confirmed | ✅ Fixed (withdrawal-queue head partial fill — an oversized request can no longer pin all underwriter exits) |

---

## Fixed

### NM-001 — Global active-flight list caps can halt new policy admission

**Confirmed (Medium).** OracleAggregator and FlightPoolManager each kept
their active flights in a single instance-storage `Vec<(Symbol, u64)>`. The
contract-instance ledger entry is bounded to 65,536 bytes, so both vectors
were capped at 1,000 entries — and either contract hitting its cap made
`register_flight` reject, aborting **every first purchase of a new flight
protocol-wide** until entries were settled, pruned, or manually evicted.
Reachable through ordinary growth, executor downtime, or pruning gaps; no
privileged access required.

**Fix — the report's recommended storage migration, implemented as a shared
paginated set (`sentinel_types::active_set`) used by both contracts:**

- **Individually keyed pages** (`ActivePage(u32)`, persistent): chunks of at
  most 100 `(flight_id, date)` tuples. Capacity scales with pages instead of
  competing with the instance entry; the remaining
  `MAX_ACTIVE_FLIGHTS = 100,000` cap (100× the old ceiling) is a pure
  operational sanity bound, no longer a storage-entry limit.
- **Count metadata** (`ActiveCount`, instance): O(1) length for the cap gate
  and the operators' saturation gauge.
- **Reverse index** (`ActiveIdx(flight_id, date)`, persistent): the entry's
  global slot, giving constant-time swap-removal (the same unordered-set
  semantics the old vectors used, so the existing rotating cursors remain
  valid). Removal re-validates the index against page contents and falls
  back to a page scan if the index archived.
- **Paginated read methods**: `get_active_flights_page(offset, limit)` on
  both contracts (a window touches at most two page entries),
  `get_active_flight_count()` now O(1), and oracle-side
  `is_flight_listed(flight_id, date)` — an exact membership view the
  controller's `settle_evicted_flight` gate uses instead of fetching the
  whole list.
- **Bounded keeper scans over pages**: `classify_flights` and
  `execute_settlements` now fetch only their batch window via the paged
  view (previously they pulled the entire vector cross-contract on every
  call); `prune_settled` sweeps its cursor window the same way. Batch sizes
  are unchanged, so keeper footprints stay within Soroban's transaction
  limits.
- **Migration path**: owner-only, batched `migrate_active_list()` on both
  contracts drains the legacy instance vector into the paginated set
  (40 entries/call, `sentinel.list_migrated` event reports progress,
  legacy key deleted when empty, idempotent afterwards). Until drained,
  un-migrated entries are simply invisible to keeper enumeration — as safe
  as a paused keeper, nothing is lost.
- **TTL layering** (pages and index are persistent, hence archivable):
  pages are re-extended on every write *and* every paged read — the
  keeper's rotating scans sweep all pages every few hours — and index
  entries are extended to the flight date (+ buffer) at write, shadowing
  the `FlightData`/`FlightConfig` rows themselves. An archived page
  degrades availability, never integrity: enumeration skips it and emits
  `sentinel.page_miss(page)` so operators restore it (standard ledger
  restoration); an archived index falls back to a page scan.

The report's interim mitigations (occupancy monitoring, aggressive pruning,
owner eviction) remain available and unchanged.

*Files:* `sentinel_types/src/{active_set.rs (new),lib.rs,interfaces.rs}`,
`oracle_aggregator/src/{constants,lifecycle,admin,queries,storage,events}.rs`,
`flight_pool_manager/src/{constants,lifecycle,admin,queries,storage,events}.rs`,
`controller/src/settle.rs`,
`executor/centralized_cron/src/{flight_data_fetcher,soroban_client}.ts`.
*Tests:* oracle — `test_get_active_flights_page_windows_and_bounds`,
`test_is_flight_listed_tracks_membership`,
`test_active_set_spans_pages_and_swap_removes_across_them` (105 flights,
cross-page swap-remove via eviction),
`test_migrate_active_list_moves_legacy_entries_in_batches`, and the
re-based cap test `test_register_flight_rejects_when_active_list_full`;
pool — `test_active_set_spans_pages_and_swap_removes_across_them` (101
buckets, cross-page removal via settlement),
`test_migrate_active_list_moves_legacy_entries_in_batches`, re-based cap
test. Every existing prune / evict / settle / lifecycle test (including the
full integration suite and the executor-simulation group) passes unchanged
on the new structure.

### NM-002 — Large head withdrawal requests can pin all underwriter exits

**Confirmed (Medium).** `process_withdrawal_queue` was strict FIFO with a
hard stop: when the head request's priced value exceeded current free
capital, the processor kept the head **and every request behind it**
untouched. Because direct `withdraw`/`redeem` revert while the queue is
non-empty, one oversized request froze every underwriter exit — including
smaller requests that current free capital could have covered — until
enough collateral unlocked to fund the head in full. The report's PoC
(A queues an unfundable full-position exit ahead of B's small fundable one;
B gets nothing and cannot redeem directly) reproduced exactly.

**Fix — head partial fill (the report's recommendation 1):** when the head
request prices above `remaining_free`, the processor now converts the free
capital to a share slice (floor-rounded both ways, so the credit can never
exceed free capital), burns that slice from escrow, credits its asset value
to the owner's `ClaimableBalance`, and keeps the remainder — always ≥ 1
share, by the rounding direction — at the head. Requests behind the head
stay deferred, exactly as before.

Why option 1 over the report's alternatives 2–4: partial fill is the only
variant that fixes liveness while keeping **strict FIFO fairness intact** —
free capital always flows to the oldest request first, so no later request
(and no direct exit) can consume capital ahead of an earlier one, which is
the invariant the queue-gates-direct-exits design exists to protect. A
per-request size cap (option 2) merely reshapes the pin into several
requests; a delayed direct-exit escape hatch (option 3) reintroduces
queue-jumping; a paged queue with a starvation rule (option 4) buys the
same liveness at much higher complexity. The queue now makes progress on
every processing pass in which any free capital exists, and the "pin the
queue" grief costs the attacker their own exit: their escrowed shares are
progressively burned and paid out.

The report's constraint on any fix — queued requests must still be priced
only after pending public outcomes settle — is preserved untouched: the
partial fill lives inside `process_withdrawal_queue`, which remains a no-op
while `settlement_pending` and continues to price against the running TMA.
The zero-value-request drop path and the per-call batch bound are also
unchanged. Observability: each partial pass emits the regular `Credited`
plus a new `RequestPartiallyFilled(owner, request_id, shares_filled,
shares_remaining)` event (`sentinel.wd_partial`), so indexers can
distinguish a partial fill from a completed request.

Residual (by design): if free capital is zero, nothing can be paid and the
queue waits — that is a capital-availability fact, not a liveness defect;
progress resumes with the next collateral release. The 250-slot queue cap
and the per-address / minimum-value admission floors flagged in the
report's verification section are unchanged — with the head no longer able
to pin the queue, saturation drains at processing speed.

*Files:* `risk_vault/src/{capital,vault_ops,events}.rs`.
*Tests:* `test_oversized_head_request_partial_fills_instead_of_pinning_queue`
— reproduces the report's PoC (A: 1,000 deposited and queued in full; B:
100 deposited, half queued; 1,000 locked leaving 100 free) and proves the
head is filled up to free capital, B keeps its FIFO place with no credit,
the head remainder stays escrowed, and the queue drains fully in order once
collateral unlocks (`risk_vault/src/test.rs`). Pre-existing queue tests
(all-capital-locked no-op, zero-value drop, queue caps, settlement-pending
gating, max-view conformance) pass unchanged.

---

## Interface changes in this pass

- `OracleAggregator` — new views `get_active_flights_page(offset, limit)`,
  `is_flight_listed(flight_id, date)`; `get_active_flight_count` now O(1);
  new owner entry `migrate_active_list()`; new events
  `ActiveListMigrated` (`sentinel.list_migrated`) and — from the shared
  set — `ActivePageMissing` (`sentinel.page_miss`). `get_active_flights`
  keeps its signature (now an off-chain convenience whose footprint grows
  with the page count).
- `FlightPoolManager` — same additions: `get_active_flights_page`, O(1)
  `get_active_flight_count`, owner `migrate_active_list()`, the two new
  events.
- `RiskVault` — new event `RequestPartiallyFilled` (`sentinel.wd_partial`).
  No entry-point signature changes; `WithdrawalRequest` layout unchanged.
- `sentinel_types` — new `active_set` module (`ActiveSetKey` storage enum,
  page size 100); shared `OracleInterface` gains the three new views.
- Executor — `FlightDataFetcher` reads the active set via
  `get_active_flight_count` + paged `get_active_flights_page` loops instead
  of one whole-list read.
- **Deployment note:** after upgrading existing deployments, the owner must
  run `migrate_active_list()` on the oracle AND the pool repeatedly until
  each `sentinel.list_migrated` event reports `remaining = 0` (≤ 25 calls
  per contract at the old 1,000 cap). Until drained, un-migrated flights
  are invisible to keeper enumeration — settlement pauses for them, nothing
  is lost. Fresh deployments need nothing.

## Documentation updated

`spec/architecture.md` (vault queue semantics + events, oracle/pool storage
layouts and tier rationale, function references, keeper/executor flows,
owner runbook), `spec/simple_architecture.md` (queue fairness and active-set
gotchas), `sequence_diagrams.md` (classify/settle paged fetch), docs site
pages `contracts/risk-vault.md`, `contracts/oracle-aggregator.md`,
`contracts/flight-pool-manager.md`, `guides/provide-liquidity.md`.
