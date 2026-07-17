# cosminmarian53 Soroban Auditor Report (2026-07-12) — Remediation Summary

**Source report:** [`20260712_cosminmarian53_soroban_auditor_report.md`](../20260712_cosminmarian53_soroban_auditor_report.md)
**Audited commit:** `fcde5aa` (main)
**Remediation date:** 2026-07-13
**Test status:** full workspace suite green — **424 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean; `stellar contract build` succeeds.

The report contains **no validated findings** (all six specialist passes and
the verification/exploit-chaining/defender gates returned empty). It retains
one **downgraded lead** from the original review as an unscored hardening
note. This pass validated that lead against the sources and implemented the
hardening in a cost-aware form.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| — (lead) | Unscored | Asymmetry confirmed; exploit path confirmed unreachable | ✅ Hardened (bounded page-scan backstop in `active_set::add`) |

---

## Hardened

### Lead — Active-set append only checks the reverse index before adding

**Validated.** The asymmetry the report describes is real:
`sentinel_types::active_set::add` rejected duplicates only via a `has` check
on the `ActiveIdx(flight_id, date)` reverse index, while `contains` and
`remove` fall back to scanning the live pages when that index has archived.
An entry stranded on a live page without its index could therefore be
appended a second time, corrupting the count and the swap-remove
bookkeeping.

**Reachability — confirmed unreachable through production paths, on stronger
grounds than the report's.** The report declined to promote the lead because
the purchase path fails closed without a live oracle sale authorization. The
validation here found an arithmetic refutation that holds even if that gate
were bypassed: `add` extends the index TTL to the **flight date plus a
~30-day buffer** (`deadline_extension_ledgers`, floored at ~31 days, and —
at the maximum 90-day booking horizon — well under the 180-day network
clamp). A `(flight_id, date)` that is still purchasable necessarily has a
future date, so its index provably cannot have expired yet; and a past-date
entry whose index *has* archived can never reach `add` again, because
`buy_insurance` rejects past dates (`DepartureTooSoon`) and both `add`
callers (`oracle.register_flight`, `pool.register_flight`) are
controller-gated behind that purchase flow. The duplicate scenario would
additionally require the flight's own `FlightData`/`FlightConfig` row to be
archived while the sale authorization and page survive.

**Why the fix deviates from the report's literal recommendation.** The
report suggests changing `add` to call `contains` (or to scan pages whenever
`ActiveIdx` is missing). Implemented literally, that is a regression: a
legitimately NEW entry never has an index entry, so the scan fallback would
run on **every** append — i.e., on the first purchase of every flight — and
its cost grows with the set (one ledger-entry read per page, up to 1,000
pages at the 100,000-entry cap). Well before the cap, first purchases would
exceed Soroban's per-transaction footprint limits and revert protocol-wide —
re-creating the exact registration-freeze failure (the 2026-07-11 report's
Medium) that the paginated set was built to eliminate.

**Fix — the recommended symmetry, bounded where it is free:**

- `add` now falls back to the same page scan `contains` and `remove` use,
  but only while the set holds at most `ACTIVE_SET_ADD_SCAN_MAX = 1,000`
  entries (10 page reads — cheap next to the entries a purchase already
  touches, and several times the realistic steady-state set size). Within
  the bound, the duplicate backstop is exact even when the reverse index has
  archived; above it, behavior is exactly as before (index check plus the
  caller-side registration gates and the deadline-sized index TTLs).
- The backstop **fails closed** (panics) rather than healing the index and
  returning: reaching it means the caller believed the flight was new while
  the set says it is present — inconsistent state (the flight's own row
  archived while its set entry survived) that operators should restore, not
  state to silently sell policies against. This matches the existing
  archived-tail-page behavior of `add`.
- Beyond its defense-in-depth value for the current code, the bounded
  backstop guards a latent parameter hazard: if `MAX_BOOK_AHEAD_SECS` were
  ever raised past ~150 days, the 180-day network TTL clamp would silently
  break the arithmetic refutation above (an index could then expire before
  its flight date). The scan makes small-set deployments robust to that
  drift by construction.

*Files:* `sentinel_types/src/active_set.rs` (constant, `add` fallback,
module docs).
*Tests:* `test_active_set_add_rejects_duplicate_when_index_archived` —
registers a flight, deletes its `ActiveIdx` entry in place (simulating index
archival while the page survives), and asserts a re-`add` panics instead of
appending a duplicate (`oracle_aggregator/src/test.rs`); the pre-existing
backstop tests (`test_active_set_add_rejects_duplicate_entry`,
`test_active_set_add_fails_closed_on_archived_tail_page`) and all
pagination/swap-remove/migration tests pass unchanged.

---

## Interface changes in this pass

None. `active_set::add` keeps its signature; the new
`ACTIVE_SET_ADD_SCAN_MAX` constant is exported for documentation and tests.
No storage layout, event, or error-code changes, so no migration or
deployment action is required.
