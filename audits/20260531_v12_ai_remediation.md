# V12 AI Report — Remediation Summary

**Source report:** [`20260531_v12_ai_report.md`](20260531_v12_ai_report.md)
**Remediation date:** 2026-06-14
**Scope:** 6 production contracts + `sentinel_types` (per the original report).
**Test status:** full workspace suite green after changes — **309 tests pass**
(`cd contracts && cargo test --workspace`); `cargo clippy --workspace
--all-targets` clean; dev + release builds clean.

Each finding was validated against source, then fixed. A test was added for every
fix.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| V12-CF-01 | Critical | Confirmed | ✅ Fixed (oracle-status purchase gate) |
| V12-CF-02 | High | Confirmed | ✅ Fixed (TTL extension threshold) |
| V12-CF-03 | High | Confirmed | ✅ Fixed (config TTL covers flight date) |
| V12-CF-04 | High | Confirmed | ✅ Already fixed by CertiK VF-01/06 + test added |
| V12-CF-05 | Medium | Confirmed | ✅ Fixed (one route per flight_id) |
| V12-CF-06 | Medium | Confirmed | ✅ Fixed (payoff > premium at registration) |

---

### V12-CF-01 — Post-cancellation purchases can drain vault payouts
**Confirmed (Critical).** `buy_insurance` never read the oracle status.
`oracle.register_flight` is idempotent (returns silently on an existing row) and
`add_buyer` only checks the pool's own `FlightConfig.status`, so a buyer could
purchase *after* the oracle marked a flight `Cancelled`/`Landed` but *before* the
keeper settled — then claim a guaranteed payoff and drain vault capital.

**Fix:** `buy_insurance` now reads `oracle.get_flight_data(flight_id, date).status`
and rejects anything other than `NotInitiated` (no data / not yet registered) or
`Active` (in-flight, pre-outcome). This closes the window for buying into a known
outcome (`"flight no longer open for purchase"`).
*Files:* `controller/src/purchase.rs`.
*Test:* `test_buy_insurance_rejected_after_oracle_cancellation`.

### V12-CF-02 — Claim-window TTL extension can no-op
**Confirmed (High).** `extend_flight_ttl_to` called `extend_ttl(key,
PERSISTENT_TTL_THRESHOLD (~7d), extend_to)`. Soroban only applies an extension
when the current TTL is *below* the threshold, so a flight settled soon after
purchase (config still holding ~31 days of TTL) skipped the extension entirely —
the config could then archive before the claim window closed, making valid claims
panic on the missing config.

**Fix:** pass `extend_to` as **both** the threshold and the target, forcing the
extension whenever the current TTL is short of the required lifetime. The target
is also clamped to the network's maximum persistent TTL so `extend_ttl` can't
panic.
*Files:* `flight_pool_manager/src/storage.rs`.
*Test:* `test_config_survives_claim_window_after_quick_settle`.

### V12-CF-03 — Long-dated policies outlive pool config / buyer-proof TTLs
**Confirmed (High).** `register_flight`/`add_buyer` extended the `FlightConfig`
TTL by a flat ~31 days, shorter than a far-booked flight's pre-settlement life.
Combined with the (now-fixed, ASF-01) lack of a booking horizon, a config could
archive before settlement — reverting keeper loops and stranding the policy.

**Fix:** `register_flight` and `add_buyer` now extend the config TTL to cover the
**flight date + buffer** (via the fixed `extend_flight_ttl_to`), instead of a flat
31 days. Together with ASF-01's 90-day max booking horizon (already on `main`) and
the 180-day buyer-key TTL, the full lifecycle is covered. The off-chain TTL cron
and the graceful missing-config handling (CertiK VF-13) remain as backstops, and
oracle `FlightData` longevity for long bookings still relies on the cron +
`TtlMiss` diagnostic.
*Files:* `flight_pool_manager/src/lifecycle.rs`, `flight_pool_manager/src/storage.rs`.
*Test:* `test_config_survives_until_far_future_flight`.

### V12-CF-04 — Unbounded registrations and active-list scans
**Confirmed (High) — already remediated.** This is the same class as CertiK
VF-01/VF-06, fixed earlier on `main`: `classify_flights`/`execute_settlements`
process a bounded window from a rotating cursor (`MAX_SETTLE_BATCH`), and
`prune_settled` is bounded by `MAX_PRUNE_BATCH`; `prune_active_list` uses
swap-remove (VF-14). No further code change was required.

**Added coverage:** a multi-flight test that buys three distinct flights and
confirms a single classify + settle pass settles all of them, exercising the
bounded cursor loop over multiple entries.
*Test:* `test_classify_and_settle_multiple_flights_in_one_batch`.

> Note: unbounded *growth* of the active lists (vs. unbounded *scans*) remains the
> deferred operational item from `spec/audit.md` M-01 / CertiK VF-11 — bounded
> processing makes it safe, full sharding is out of scope.

### V12-CF-05 — Route identity drops origin/destination
**Confirmed (Medium).** Governance keys routes by `(flight_id, origin, dest)` but
the pool and oracle key state by `(flight_id, date)`. Two approved routes sharing
a `flight_id` would collide their downstream state.

**Fix (governance-level uniqueness — the report's recommended alternative):** a
new `DataKey::FlightRoute(flight_id) → (origin, dest)` index. `whitelist_route`
rejects a second route that reuses a `flight_id` with a different `(origin, dest)`
(`"flight_id already mapped to a different route"`); re-whitelisting the same
route is unaffected; `remove_route` frees the mapping. A flight number on a date
is one physical flight, so this is the semantically correct constraint and avoids
an invasive key change across pool/oracle/controller.
*Files:* `governance_module/src/storage.rs`, `governance_module/src/lib.rs`.
*Tests:* `test_whitelist_route_rejects_conflicting_flight_id`,
`test_remove_route_frees_flight_id_mapping`.

### V12-CF-06 — Mutable defaults can invalidate route economics
**Confirmed (Medium).** Routes may store `None` for terms, resolved against
**mutable** governance defaults at read time. A later `set_defaults` can make an
existing partially-defaulted route resolve to `payoff <= premium` without
revalidation; pool registration only checked positivity, and delayed/cancelled
settlement computes `payoff - premium`, which underflows and reverts — bricking
the flight.

**Fix:** `register_flight` now asserts `payoff > premium` (`"payoff must exceed
premium"`). A mis-resolved route can no longer be registered, so the purchase
reverts up front rather than allowing a flight that can never settle. (Governance
already enforces `payoff > premium` on route writes; this is the defense-in-depth
check the report requested at the pool boundary.)
*Files:* `flight_pool_manager/src/lifecycle.rs`.
*Test:* `test_register_flight_payoff_not_above_premium_fails`.

> Deeper option not taken: revalidating every existing route on `set_defaults`
> (or storing fully-resolved immutable terms). Both require route enumeration
> (no index today); the pool-boundary check deterministically prevents the harm
> (settlement underflow / bricked claims), which is the concrete risk.
