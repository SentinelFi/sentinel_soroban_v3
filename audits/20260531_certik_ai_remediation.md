# CertiK AI Report — Remediation Summary

**Source report:** [`20260531_certik_ai_report.md`](20260531_certik_ai_report.md)
**Remediation date:** 2026-06-14
**Scope:** 6 production contracts + `sentinel_types` (per the original report).
**Test status:** full workspace suite green after changes — **299 tests pass**
(`cd contracts && cargo test --workspace`), `cargo clippy --workspace
--all-targets` clean.

Each finding below was first **validated against the source**, then either fixed,
mitigated, or documented-as-deferred with rationale.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| VF-01 | High | Confirmed | ✅ Fixed (bounded batch + cursor) |
| VF-02 | High | Confirmed | ✅ Fixed (batch cap) |
| VF-03 | High | Confirmed | ✅ Fixed (claims allowed during pause) |
| VF-04 | High | Confirmed | ✅ Fixed (reject/skip zero-preview) |
| VF-05 | Medium | Confirmed | ✅ Fixed (TTL refresh on read) |
| VF-06 | Medium | Confirmed | ✅ Fixed (bounded batch + cursor) |
| VF-07 | Medium | Confirmed | ✅ Fixed (accept early arrivals) |
| VF-08 | Medium | Confirmed | 🟡 Deferred (documented, default-safe) |
| VF-09 | Medium | Confirmed | 🟡 Partially mitigated + documented |
| VF-10 | Low | Confirmed | ✅ Fixed (TTL bump + on-read refresh) |
| VF-11 | Low | Confirmed | 🟡 Deferred (documented) |
| VF-12 | Low | Confirmed | ✅ Fixed (TTL sized to lifecycle) |
| VF-13 | Low | Confirmed | ✅ Fixed (graceful skip + diagnostic) |
| VF-14 | Low | Confirmed | ✅ Fixed (swap-remove) |
| VF-15 | Low | Confirmed | ✅ Fixed (diagnostic, evict retained) |
| VF-16 | Low | Confirmed | ✅ Fixed (TTL refresh on partial) |
| VF-17 | Info | Confirmed | ✅ Fixed (paused `max_*` → 0) |

---

## Fixed

### VF-01 — Unbounded settlement/classification scans
`classify_flights` and `execute_settlements` now process at most
`MAX_SETTLE_BATCH` (100) entries per call, starting from a persisted rotating
cursor (`CtrlKey::ClassifyCursor` / `SettleCursor`). Per-call resource cost is
bounded regardless of active-list size; both passes are idempotent on
already-handled flights, so rotating across keeper calls guarantees full
coverage. Normal volumes still complete in one call.
*Files:* `controller/src/settle.rs`, `controller/src/storage.rs`.

### VF-02 — Unbounded withdrawal-queue drain
`process_withdrawal_queue` now examines at most `MAX_QUEUE_BATCH` (50) requests
per call; entries beyond the window are carried over untouched and drained on a
later call. Prevents the drain from exceeding transaction limits and reverting
before any entry is processed.
*Files:* `risk_vault/src/capital.rs`, `risk_vault/src/storage.rs`.

### VF-03 — Pause can expire active claims
`claim` is no longer `#[when_not_paused]`. Claim windows run on the ledger
clock, which advances during a pause; gating claims would let an emergency pause
permanently expire valid, already-funded payouts. Claiming only moves funds
already earmarked to the rightful policy holder (full auth + status + window +
double-claim checks remain), so it is safe to keep open. `sweep_expired` stays
paused-gated.
*Files:* `flight_pool_manager/src/claim.rs`. *Test:* `test_claim_succeeds_while_paused`.

### VF-04 — Zero-preview request starves the queue
Two-part fix: (1) `request_withdrawal` rejects any request whose
`preview_redeem(shares)` is zero, so dust can never enter the queue; (2) the
drain loop *skips* a zero-preview entry (keeping it queued so the owner can
`cancel_withdrawal` to recover escrowed shares) instead of `break`ing on it. The
strict-FIFO `assets > remaining_free` stop is preserved.
*Files:* `risk_vault/src/claims.rs`, `risk_vault/src/capital.rs`. *Tests:*
`test_request_withdrawal_rejects_zero_preview`, `test_zero_preview_request_does_not_block_queue`.

### VF-05 — Approved routes can expire and become unsellable
`route_status` now refreshes the route key's TTL on read. The controller's
`buy_insurance` calls it on a committing transaction, so an actively-traded
route is kept alive without relying solely on the off-chain TTL cron. Read-only
simulations don't persist the extension, so frontend queries are unaffected.
*Files:* `governance_module/src/lib.rs`.

### VF-06 — Oracle active-list pruning is unbounded
`prune_settled` now inspects only a bounded window `[cursor, cursor+MAX_PRUNE_BATCH)`
(100) per call, doing the expensive per-entry persistent lookup only inside the
window; out-of-window entries are carried over without a lookup. A rotating
`OracleKey::PruneCursor` sweeps the whole list over repeated (permissionless,
idempotent) calls.
*Files:* `oracle_aggregator/src/lib.rs`, `oracle_aggregator/src/storage.rs`.

### VF-07 — Early arrivals rejected, leaving flights stuck `Active`
`set_landed` no longer rejects `actual_arrival_time < estimated_arrival_time`.
Early arrival is a legitimate outcome; the authorized oracle is trusted, and the
downstream delay computation already saturates a negative delay to zero
(classifying it on-time). Removing the assert prevents early flights from being
stuck `Active` forever with collateral locked.
*Files:* `oracle_aggregator/src/lib.rs`. *Test:* `test_set_landed_accepts_early_arrival`
(replaces the prior reject test).

### VF-10 — Buyer-whitelist entries can silently expire
Whitelist-entry TTL raised to 180 days (shared `TRAVELER_FLIGHTS_TTL_LEDGERS`,
see VF-12) and refreshed on read inside the `buy_insurance` gate
(`touch_buyer_whitelisted`), so an actively-buying approved address keeps its
own approval alive. Default-off feature, so this is defense in depth.
*Files:* `controller/src/storage.rs`, `controller/src/purchase.rs`.

### VF-12 — Traveler index TTL shorter than policy lifecycle
`TRAVELER_FLIGHTS_TTL_LEDGERS` raised from 60 → 180 days to cover the maximum
claim-expiry window, so the per-traveler "My Policies" index can't archive while
a referenced policy is still active/claimable.
*Files:* `controller/src/storage.rs`.

### VF-13 — Archived `FlightConfig` makes flights unclassifiable
`classify_flights` and `execute_settlements` previously `.expect()`-panicked on a
missing pool config, which would block the entire keeper loop. They now skip the
flight and emit a `FlightConfigMissing` diagnostic, so one inconsistent flight
can't halt settlement of all others.
*Files:* `controller/src/settle.rs`, `controller/src/events.rs`.

### VF-14 — Linear prune inside the settlement loop
`prune_active_list` now swap-removes (move tail into the gap, `pop_back`) instead
of `Vec::remove`, which shifted every trailing element. The active list is an
unordered set, so order needn't be preserved; this avoids compounding shift cost
when many flights settle in one call.
*Files:* `flight_pool_manager/src/storage.rs`.

### VF-15 — Missing `FlightData` pruned as aged-out
The prior evict-on-missing behavior is **retained** (it was the deliberate fix
for audit H-02 — a missing entry is unrecoverable on-chain and would otherwise
block pruning forever). It is no longer silent: `prune_settled` emits a
`MissingFlightDataPruned` diagnostic when it evicts a missing entry, so
off-chain monitoring can detect a flight that vanished without being explicitly
settled.
*Files:* `oracle_aggregator/src/lib.rs`, `oracle_aggregator/src/events.rs`.

### VF-16 — Partial transfer recovery doesn't refresh TTL
`recover_uncollected` (Transfer mode) now extends the `ClaimableBalance` key's
TTL whenever a nonzero remainder is written back, so the remainder can't archive
sooner than a freshly-credited entry.
*Files:* `risk_vault/src/claims.rs`.

### VF-17 — `max_*` views ignore paused state
`max_deposit`, `max_mint`, `max_withdraw`, and `max_redeem` now return `0` while
the vault is paused, matching the paused-gated executable paths so integrations
don't submit transactions that revert.
*Files:* `risk_vault/src/vault_ops.rs`. *Test:* `test_max_views_return_zero_when_paused`.

---

## Deferred / partially mitigated (with rationale)

### VF-08 — Locked capital doesn't preserve the solvency ratio — 🟡 Deferred
**Validated as real.** `buy_insurance` checks `free_capital >= payoff * ratio /
100` but locks only `payoff`, so a ratio above 100% is enforced at purchase but
not held as an ongoing reserve.

**Why deferred:** the default and minimum `solvency_ratio` is **100**
(`MIN_SOLVENCY_RATIO = 100`), where `locked == payoff == full exposure` — fully
solvent, no gap. The issue only manifests if the owner sets a ratio above 100.
A correct fix requires tracking the locked amount (or ratio) **per flight** so
settlement unlocks exactly what each purchase locked; otherwise, if the owner
changes the ratio between buy and settle, the aggregate `LockedCapital` decrement
won't match the increment and can underflow. That needs a `FlightConfig` schema
change (shared `sentinel_types`) and is too invasive to bundle safely with this
pass.
**Recommended fix:** store the per-flight locked amount in `FlightConfig` at
registration and unlock that exact amount at settlement; or lock
`payoff * ratio / 100` and have withdrawal limits reserve the buffer.

### VF-09 — Share pricing can use raw balance instead of managed assets — 🟡 Partially mitigated + documented
**Validated as real** against the OpenZeppelin source: `Vault::total_assets()`
returns `token.balance(contract)` (raw balance), and the internal
`convert_to_shares/assets` helpers call that same function. RiskVault tracks its
own `TotalManagedAssets` (TMA) but delegates conversion to OZ, so during the
window between `process_withdrawal_queue` (which decrements TMA but leaves the
USDC in the vault as a `ClaimableBalance`) and `collect` (which transfers it
out), raw balance = TMA + uncollected-claimable, inflating OZ's NAV.

**Mitigating factor (verified):** withdraw/redeem are capped by
`get_free_capital()`, which is **TMA-based** (`TMA − locked`). After all free
capital is withdrawn, the residual vault USDC is `claimable + locked ≥ claimable`
— so the claimable obligations are **structurally protected** and cannot be
drained. The residual issue is transient *pricing unfairness* during the
uncollected window (new depositors slightly overpay; exiting holders get a
marginally better rate), not protocol insolvency.

**Why a full fix is deferred:** OZ's `deposit/mint/withdraw/redeem` compute mint
and burn amounts via `Vault::total_assets` *internally* — overriding our trait's
`total_assets` does not change them. A correct fix means reimplementing the full
ERC-4626 conversion (rounding directions + inflation/decimals-offset protection)
in RiskVault instead of delegating to the audited OZ implementation, which is a
high-risk vault rewrite that should be its own reviewed change.
**Recommended fix:** reimplement share conversion on TMA as the single NAV
source, excluding uncollected `ClaimableBalance` from NAV; cover with dedicated
inflation/rounding tests before adopting.

### VF-11 — Per-traveler flight index is unbounded — 🟡 Deferred
**Validated as real.** Each purchase reads/appends/rewrites the full
`TravelerFlights(addr)` `Vec`, so a very frequent traveler can eventually hit a
size/cost ceiling.

**Why deferred:** this index is a **frontend convenience** ("My Policies"), not
a protocol-liveness or fund-safety structure — canonical policy state lives in
`FlightPoolManager`. A proper fix (sharded per-index keys with a counter +
paginated reads) is a larger refactor disproportionate to a Low finding, and is
consistent with the project's prior decision to defer unbounded-growth items of
this class (`spec/audit.md` M-01).
**Recommended fix:** shard traveler entries under `TravelerFlights(addr, page)`
with a head counter and add paginated reads with explicit per-page limits.

---

## Files changed
Source (17): `controller/src/{events,purchase,settle,storage}.rs`,
`flight_pool_manager/src/{claim,storage,test}.rs`,
`governance_module/src/lib.rs`,
`oracle_aggregator/src/{events,lib,storage,test}.rs`,
`risk_vault/src/{capital,claims,storage,test,vault_ops}.rs`.
Plus auto-regenerated `test_snapshots/**` fixtures reflecting the new
storage-key / event footprint.
