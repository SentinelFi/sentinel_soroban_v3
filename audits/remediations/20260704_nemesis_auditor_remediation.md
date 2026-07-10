# Nemesis AI Auditor Report (2026-07-04) — Remediation Summary

**Source report:** [`20260704_nemesis_auditor_report.md`](../20260704_nemesis_auditor_report.md)
**Remediation date:** 2026-07-08
**Scope:** 5 production contracts + `sentinel_types`.
**Test status:** full workspace suite green — **332 tests pass**
(`cd contracts && cargo test`); `cargo clippy --all-targets -- -D warnings`
clean; `cargo fmt --all --check` clean.

This is a fresh review of the post-remediation code. It confirms the earlier
25 June findings are fixed (day-aligned identity, TMA-basis executable pricing,
aggregate solvency, bounded keeper batches, route-index TTL, long-dated storage
TTL) and raises three new/remaining items.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| NM-001 | High | Confirmed | ✅ Fixed (settlement barrier — no entry/exit while PnL unrecognized) |
| NM-002 | Medium | Confirmed | ✅ Interim mitigation applied (retention shortened); architectural fix deferred |
| NM-003 | Low | Confirmed | ✅ Fixed (snapshot prices on managed assets) |

---

## Fixed

### NM-003 — Snapshot pricing includes liabilities excluded from executable pricing
**Confirmed (Low).** The executable deposit/redeem conversions were moved to the
managed-asset basis in the prior pass, but the daily `snapshot()` path still
computed its price from `Vault::total_assets(e)` — the vault's raw token balance.
After withdrawal-queue processing the raw balance equals managed assets **plus**
processed-but-uncollected claimable withdrawals (and any direct token donation),
so the published `SharePriceSnapshot` over-stated the share price relative to the
price real deposits/redeems execute at.

**Fix:** `snapshot()` now prices on `Self::get_total_managed_assets(e)`, the same
basis as the executable conversions, so the recorded/emitted price matches what
LPs actually transact at. No on-chain financial operation consumes snapshots, so
the impact was analytics-only, but the two bases are now consistent.
*Files:* `risk_vault/src/snapshot.rs`.
*Test:* `test_snapshot_uses_managed_assets_not_physical_balance` — processes a
withdrawal to leave an uncollected claimable balance (making physical balance >
TMA), takes a snapshot, and asserts the recorded price equals `TMA * scale /
total_supply` and is strictly below the physical-balance price.

---

## Interim mitigation applied

### NM-002 — Global active-list caps can halt all new policy admission
**Confirmed (Medium).** OracleAggregator and FlightPoolManager each store all
active flights in one instance-storage `Vec`, capped at 1,000 to stay under
Soroban's 65,536-byte contract-data entry limit. Because a first purchase must
register the flight in both contracts, once either list is full every new-flight
`buy_insurance` reverts. The caps (added to fix the earlier monolithic-vector
findings) prevent storage corruption but convert the limit into a protocol-wide
admission ceiling. The oracle list is the binding constraint: it retained settled
flights for 30 days, so ordinary settled-flight volume alone could consume the
capacity (~34 settled-flight-days/day fills 1,000 over 30 days).

**Interim mitigation applied (the report's recommended "shorten settled-flight
retention"):** the oracle's settled-flight retention was reduced from 30 days to
**7 days**. Settled flights become prunable — and thus stop consuming list
capacity — 4× sooner, raising the settled-flight throughput the cap tolerates
from ~33/day to ~142/day. Every settlement already emits an event, so off-chain
indexers/analytics do not depend on the on-chain retention window; 7 days remains
ample for direct on-chain queries. FlightPoolManager already removes flights from
its list on settlement, so its list is bounded by concurrent unsettled flights.
*Files:* `oracle_aggregator/src/constants.rs` (`SETTLED_RETENTION_DAYS` 30 → 7),
with the corresponding test-window updates.

> **Deferred (documented):** the architectural fix — replacing each monolithic
> `Vec` with individually-keyed active-flight records (count + head/tail metadata,
> a reverse index for O(1) removal, paginated reads, and a migration path) — is
> the shared monolithic-vector migration deferred across the prior findings
> (AA-OA-02, AA-FPM-02, AA-CT-02). The caps remain the hard safeguard; the
> shortened retention reduces how readily the cap is reached under normal volume.
> Additional operator-side measures the report suggests (capacity metrics/alerts,
> early pruning near the cap, throttling new route activation as capacity fills)
> are operational and can be layered on without contract changes.

---

## Fixed — settlement barrier

### NM-001 — Public flight outcomes give LPs a free option before settlement
**Confirmed (High).** A flight's outcome becomes publicly observable when the
oracle records `Landed`/`Cancelled`, but its financial effect on RiskVault is
only recognized later, in a separate Controller settlement transaction. During
that window the vault still priced `deposit`/`mint`/`withdraw`/`redeem` at the
pre-outcome share price. An informed LP could redeem after a cancellation (or a
qualifying delay, computable from the public actual-arrival data) but before
settlement, taking the pre-loss price and leaving passive LPs to absorb the loss;
the inverse let a depositor enter after a public on-time outcome and capture
premium income for risk it never underwrote.

**Fix — a settlement barrier tied to the oracle's public state.** The chosen
design (settlement epochs) is realized as: entry and exit only execute when the
vault has *no unrecognized PnL* — i.e. no flight outcome is public-but-unsettled.
Concretely:

- **OracleAggregator** now tracks a `PendingOutcomes` counter: incremented when a
  flight's outcome first becomes public (`set_landed` / `set_cancelled`) and
  decremented when it is financially settled (`set_settled`). It equals the number
  of flights in `Landed`/`Cancelled`/`ToBeSettled*` — exactly the
  outcome-public-but-not-yet-settled set — and is exposed via
  `has_pending_outcomes()`. The forward-only state machine keeps it balanced;
  decrement saturates so it can never underflow.
- **RiskVault** stores the oracle address (owner-set via `set_oracle`) and, on
  every `deposit`/`mint`/`withdraw`/`redeem`, reverts with `SettlementPending`
  while `has_pending_outcomes()` is true. `process_withdrawal_queue` is likewise a
  no-op while pending, so **queued** exits are priced only after settlement, never
  at the stale rate.
- The exit path is not frozen: `request_withdrawal` stays open during a pending
  window (it locks no price — shares are escrowed and priced when the keeper
  drains the queue post-settlement). Deposits during a pending window are
  rejected and simply retried once settlement completes (typically the next
  keeper cycle).

This closes **both** directions the report requires: no pre-loss exit and no
pre-income deposit. Since the barrier is keyed on the oracle's public-outcome
counter (which flips the moment `set_landed`/`set_cancelled` runs), it covers the
full window from first public disclosure through settlement — not just the
classification→settlement sub-window. The gate is inactive until `set_oracle` is
wired, so deployment must call it (the integration test suite wires it and
exercises the production configuration).

*Files:* `oracle_aggregator/src/{storage,lifecycle,queries}.rs`,
`risk_vault/src/{storage,error,auth,admin,queries,interfaces,vault_ops,capital,lib}.rs`.
*Tests:* `lp_cannot_transact_at_stale_price_during_pending_outcome` (direct
redeem and deposit both revert while an outcome is unsettled, then succeed after
settlement) and `withdrawal_queue_stays_open_during_pending_outcome` (the queued
exit path remains available during the window and drains only post-settlement).

> **Trade-off (documented):** while an outcome is public-but-unsettled, direct
> deposits/redeems are unavailable and LPs use the queue (exits) or retry
> (deposits). Under continuous flight volume, pending windows recur between keeper
> cycles; a future full epoch model with a dedicated *deposit* queue (so deposits
> are merely delayed rather than rejected) would improve entry availability, but
> is not required to close the security gap.

---

## Files changed

Source: `risk_vault/src/snapshot.rs` (NM-003);
`oracle_aggregator/src/constants.rs` (NM-002);
`oracle_aggregator/src/{storage,lifecycle,queries}.rs` and
`risk_vault/src/{storage,error,auth,admin,queries,interfaces,vault_ops,capital,lib}.rs`
(NM-001 settlement barrier).
Tests: `risk_vault/src/test.rs`, `oracle_aggregator/src/test.rs`,
`integration_tests/src/tests/{setup,group2_capital,group5_edge_cases}.rs`.
