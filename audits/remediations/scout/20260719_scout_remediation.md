# Scout Report (2026-07-19) — Remediation Summary

**Source report:** [`20260719_scout_report.md`](../../scout/20260719_scout_report.md)
**Audited commit:** `c2dc747` (main)
**Remediation date:** 2026-07-19
**Tool:** CoinFabrik Scout (static analyzer)

Scout flagged **45 findings** across 8 detectors. Every finding was validated
against the current sources. **One** (Soroban Version) is actionable and was
addressed to the maximum the dependency graph allows; the remaining **44 are
false positives or accepted-by-design residuals** — Scout's detectors are
heuristics that fire on syntactic patterns (`unwrap`/`expect`/`assert!`,
equal `extend_ttl` arguments, `Vec` in storage, divide-before-multiply) that
this codebase uses deliberately and safely.

| Detector | Impact | Count | Verdict | Disposition |
|----------|--------|-------|---------|-------------|
| Soroban Version | Enhancement | 7 | Actionable | ✅ SDK bumped `25.3.1` → `26.1.0` (max OZ-compatible); `27.x` blocked by OpenZeppelin |
| Ineffective Extend Ttl | Medium | 10 | False positive | 📝 Intentional equal-arg pattern (deadline-anchored / fixed-lifetime), write-path only |
| Dynamic Storage | Enhancement | 2 | Accepted | 📝 Bounded `Vec`s in *persistent* storage, by design |
| Instance Storage Per User Key | Enhancement | 2 | Accepted | 📝 Governance-bounded admin set; cheap hot-path auth read |
| Divide Before Multiply | Medium | 2 | False positive | 📝 Reorder would bypass the `.max()` clamp; threshold precision immaterial |
| Assert Violation | Enhancement | 2 | False positive | 📝 Compile-time `const` assertions — cannot panic on-chain |
| Unsafe Unwrap | Medium | 17 | False positive | 📝 Construction-set keys / loop-bounded indexing — provably `Some` |
| Unsafe Expect | Medium | 3 | False positive | 📝 Nonzero-const division / deliberate defensive overflow panic |

---

## Actioned

### Soroban Version (IDs 1, 6, 7, 14, 22, 25, 41)

**Actionable — addressed as far as the dependency graph permits.** Scout
recommends the newest Soroban SDK. The workspace was on `soroban-sdk 25.3.1`;
it is now pinned to **`26.1.0`**, the latest release compatible with the
OpenZeppelin Stellar crates (`stellar-*` `0.7.2`), which require
`soroban-sdk = "^26.1.0"` (`>=26.1.0, <27.0.0`).

**`27.x` cannot be adopted yet.** No OpenZeppelin Stellar release targets
`soroban-sdk 27` (latest is `0.7.2`, 2026-06-09, still on `^26.1.0`). Forcing
the workspace to `27.0.0` makes Cargo resolve *two* copies of `soroban_sdk`
(26.1.0 for the OZ crates, 27.0.0 for our contracts), producing the build
break. Revisit when OpenZeppelin ships a `27`-compatible release.

*File:* [`contracts/Cargo.toml`](../../../contracts/Cargo.toml) (`[workspace.dependencies]`).

---

## False positives

### Ineffective Extend Ttl (IDs 3, 9, 13, 15, 16, 23, 24, 38, 39, 40)

**False positive — the equal threshold/target is intentional and effective.**
Scout flags `extend_ttl(key, X, X)` because equal arguments can re-run the
extension on every access. Two deliberate variants are in play, both
documented in-code:

- **Moving deadline-anchored targets** — `active_set::extend_idx_ttl`,
  `oracle_aggregator` `extend_flight_ttl_to` / `extend_sale_auth_ttl`. The
  target is a computed deadline that *shrinks* as the flight/expiry
  approaches, so a fixed lower threshold is not meaningful; equal args are the
  correct way to guarantee "the entry lives at least until the deadline."
- **Fixed-lifetime targets** — `TravelerFlights`, `FlightRoute` and its index,
  `Buyer`/`Claimed` (`TRAVELER_FLIGHTS_TTL_LEDGERS`, `ROUTE_TTL_LEDGERS`,
  `BUYER_TTL_LEDGERS`). Equal args keep the entry at its full target lifetime
  on each touch.

Every flagged site is on a **write/mutation path** (not a read path), and
writes to any single key are infrequent, so the "runs on every access" cost
the detector warns of does not materialize. The flat-scheme extensions that
*are* read-triggered (`extend_page_ttl`) already use distinct
`PERSISTENT_TTL_THRESHOLD` < `PERSISTENT_TTL_EXTEND` and were not flagged.

### Divide Before Multiply (IDs 42, 43)

**False positive — the ordering is structurally required.** Both sites compute
the anti-squatting queue floor in [`risk_vault/src/claims.rs`](../../../contracts/risk_vault/src/claims.rs):

```
floor_cap      = (TMA / MIN_REQUEST_FLOOR_DIVISOR).max(MIN_REQUEST_FLOOR_CAP_ABS)
occupancy_floor = floor_cap * queue.len() / MAX_*_QUEUE_LEN
```

`floor_cap` is a deliberately-clamped intermediate: the
`.max(MIN_REQUEST_FLOOR_CAP_ABS)` absolute floor (added in the 2026-07-18
CF5C-L02 remediation) must apply *before* the multiply. Reordering to
`TMA * queue.len() / (DIVISOR * MAX)` would bypass that clamp and re-open the
near-zero-TMA squatting hole it exists to close. The result is a
minimum-request *threshold*; the sub-unit precision lost to the early divide
(< `DIVISOR` units) only makes the floor marginally more permissive and never
touches value-transfer or solvency math.

### Assert Violation (IDs 0, 5)

**False positive — compile-time assertions.** Both sites are
`const _: () = assert!(...)`:

- [`sentinel_types/src/lib.rs:125`](../../../contracts/sentinel_types/src/lib.rs#L125) — buyer-proof TTL agrees in seconds and
  ledgers at the assumed cadence.
- [`controller/src/constants.rs:122`](../../../contracts/controller/src/constants.rs#L122) — book-ahead + claim-deadline cap ≤ buyer
  proof lifetime.

`const` assertions are evaluated at compile time; a violated invariant fails
the build, so neither can panic on-chain. This is the recommended way to
enforce cross-crate constant invariants. A sweep confirmed **no other
non-test runtime `assert!` exists in contract code** — all remaining matches
are `assert_eq!` in `*/test.rs`, plus one in [`oracle_aggregator/fuzz`](../../../contracts/oracle_aggregator/fuzz) (a fuzz
harness excluded from the workspace, never compiled into wasm).

### Unsafe Unwrap (IDs 4, 8, 10, 11, 12, 17, 18, 19, 26, 27, 28, 32, 33, 34, 35, 36, 44)

**False positive — every flagged `unwrap` is provably `Some`.** Two patterns:

- **Construction-set instance keys** — `get(&Key).unwrap()` on keys written in
  `__constructor` and never removed: controller `AuthorizedKeeper`,
  `SolvencyRatio`, `FlightPoolManager`, `Oracle`, `RiskVault`; pool
  `AssetToken`, `RiskVault`; governance `DefaultPremium`/`Payoff`/`DelayHours`;
  vault `Controller`. On any live contract these are always present, and
  instance storage shares the contract-instance TTL (it does not independently
  archive). A panic requires an unconstructed contract, which cannot occur
  after deployment. (These are query getters; panicking on a genuinely
  uninitialized contract is acceptable behavior.)
- **Loop-bounded indexing** — `collection.get(i).unwrap()` where `i` is bounded
  by the enclosing loop against `collection.len()` (`active_set::get_range`,
  vault queue scans). The index is provably in range.

### Unsafe Expect (IDs 29, 30, 31)

**False positive — deliberate or provably-safe.** In [`controller/src/settle.rs`](../../../contracts/controller/src/settle.rs):

- ID 29: `checked_div(SECONDS_PER_HOUR).expect("division by zero")` — the
  divisor is a nonzero constant, so `checked_div` is always `Some`.
- IDs 30, 31: `checked_add(...).expect("addition overflow")` on
  timeout/claim-expiry sums — a **deliberate defensive panic** on genuine
  overflow. Failing loudly (vs silent wraparound) is the correct, recommended
  pattern for these invariant-critical timestamp computations.

---

## Accepted residuals (by design)

### Dynamic Storage (IDs 2, 37)

**Accepted.** `active_set::ActivePage` (`Vec<(Symbol, u64)>`, capped at
`ACTIVE_SET_PAGE_SIZE = 100` entries/page) and controller `TravelerFlights`
(`Vec<(Symbol, u64)>`, capped at `MAX_TRAVELER_FLIGHTS`, oldest-evicting) are
both **bounded** and live in **persistent** storage — not the always-loaded
instance map the detector's growth concern targets. The paginated active-set
design exists precisely to keep this data out of a single unbounded entry
(see the `active_set` module doc). No change.

### Instance Storage Per User Key (IDs 20, 21)

**Accepted.** `governance_module` `DataKey::Admin(Address)` is instance-scoped
and keyed per address ([`auth.rs:16`](../../../contracts/governance_module/src/auth.rs#L16), [`queries.rs:124`](../../../contracts/governance_module/src/queries.rs#L124)). The admin set is a
small, **owner-granted privileged set** (a handful of keys), not a
permissionless per-user map, so the unbounded-growth cost the detector warns
of does not arise. Keeping it in instance storage makes the
`require_owner_or_admin` authorization check a single cheap read with no TTL/
archival edge cases; moving it to persistent storage would add restoration
concerns to an auth gate for no practical benefit. No change.

---

## Net changes in this pass

- [`contracts/Cargo.toml`](../../../contracts/Cargo.toml) — `soroban-sdk` `25.3.1` → `26.1.0` (the newest
  release the OpenZeppelin Stellar `0.7.2` crates permit).
  **`Cargo.lock` regeneration required** to drop the stale `soroban-sdk 27.0.0`
  entry.
- No contract-source edits — all 44 non-version findings are false positives
  or accepted-by-design residuals, documented above.
- No ABI, storage-layout, or wire-format changes; no deployment action beyond
  a rebuild on the realigned SDK.
