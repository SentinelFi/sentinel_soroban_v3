# Soroban Contract Audit

> Read-only review of all 6 Soroban contracts (~2,900 LOC). No architecture or
> function-name changes proposed. Focus: security, correctness, anti-patterns,
> duplication, and readability.
>
> Scope: `mock_usdc`, `governance_module`, `risk_vault`, `oracle_aggregator`,
> `flight_pool_manager`, `controller`.

---

## Summary

| Category | Count |
|---|---|
| Security / correctness | 8 (S1–S8) |
| Soroban anti-patterns | 10 (A1–A10) |
| Repeated code | 7 (D1–D7) |
| Readability / simplicity | 11 (R1–R11) |
| Cleanup (mechanical) | 4 (C1–C4) |

**Highest-leverage fixes:** S1, S2, S3 (`recover_uncollected` has three
independent footguns), S4 (`prune_settled` fragility), S5 (withdrawal queue
head-of-line block), A5 / A6 (FPM TTL inconsistency on settle / sweep), and
C1 / C2 (free wins).

---

## Security / correctness

### S1. `risk_vault::recover_uncollected` Recredit mode SETs balance
`risk_vault/src/lib.rs:469-478`

If a user's `ClaimableBalance` already has a non-zero entry (not yet archived),
Recredit overwrites it. Owner could accidentally credit `50` to a user already
owed `100`, silently losing `50`. Doc comment notes the SET semantics, but the
function name "recover" implies additive.

### S2. `risk_vault::recover_uncollected` Transfer mode has no upper-bound check
`risk_vault/src/lib.rs:479-482`

Direct USDC transfer with no compare against TMA, free capital, or a per-user
owed amount. Owner can drain vault USDC reserves below the locked-collateral
floor, breaking the solvency invariant. Even an honest owner has no on-chain
guard against typos.

### S3. `risk_vault::recover_uncollected` Transfer doesn't decrement TMA
`risk_vault/src/lib.rs:479-482`

For users whose original credit *was* already deducted via
`process_withdrawal_queue`, this is correct. But if Transfer is used for a user
who never had a `ClaimableBalance` deducted from TMA, vault USDC drops while
TMA stays the same — share price silently inflates. No invariant enforces the
precondition.

### S4. `oracle_aggregator::prune_settled` panics on any missing FlightData
`oracle_aggregator/src/lib.rs:387-391`

`.expect("flight data missing")` bricks the entire prune loop if a single
FlightData entry archived (Persistent storage tier; `ActiveFlightList` is
Instance — they have independent lifetimes). One stale entry stops all
pruning. Skip-on-missing would be more robust.

### S5. `risk_vault::process_withdrawal_queue` head-of-line block on `assets == 0`
`risk_vault/src/lib.rs:326-328`

`if assets > remaining_free || assets == 0 { break; }` exits the loop entirely
on a zero-asset preview. If a low-shares entry sits at queue head and rounds
to zero, every subsequent (valid) request stalls until that entry is
cancelled. Skip-and-continue would be safer.

### S6. `risk_vault::send_payout` checks `amount <= tma`, not `amount <= free_capital`
`risk_vault/src/lib.rs:290-302`

Relies on caller (controller) having previously locked the right amount. If
caller logic ever drifts (or a future caller is added), this guards too
loosely. The redeem / withdraw paths correctly check `free_capital`.

### S7. `mock_usdc::mint` and `faucet` are permissionless
`mock_usdc/src/lib.rs:22-29`

Anyone can mint to anyone for any amount. Intentional for testnet, but the
contract sets an owner that does nothing — false sense of access control.
Risk: same WASM accidentally deployed to mainnet would let anyone mint USDC.
Consider an explicit `#[cfg(...)]` gate or owner-only mint.

### S8. Solvency check in `controller::buy_insurance` is read-then-write, no atomic lock
`controller/src/lib.rs:384-401`

`vault.get_free_capital()` is read at step 5; `vault.increase_locked()` at
step 7. In Soroban this is fine — transactions are sequenced and storage
writes commit between transactions — but worth a one-line comment confirming
the invariant.

---

## Soroban anti-patterns / not recommended

### A1. `OracleError` enum is dead code
`oracle_aggregator/src/lib.rs:45-54`

Codebase uses `assert!(cond, "msg")` per the established pattern; the enum is
defined and never referenced. Same crate uses string-message assertions
throughout.

### A2. Unused `MuxedAddress` imports
`risk_vault/src/lib.rs:3`, `mock_usdc/src/lib.rs:2`

Imported, never used. Compiler warning waiting to happen.

### A3. `.unwrap()` on storage reads instead of `.expect("msg")`
`controller/src/lib.rs:339-347, 359, 388, 411, 414, 422`,
`flight_pool_manager/src/lib.rs:219, 349, 350, 483, 603, 604, 607`

On a missing key the panic message is empty. The codebase generally uses
`.expect("...")` (oracle and vault helpers) — controller and FPM are
inconsistent.

### A4. `mock_usdc` owner state is dead
`mock_usdc/src/lib.rs:11-19`

`ownable::set_owner` is called, `Ownable` trait is implemented, but no
owner-only method exists. Either gate `mint` with `#[only_owner]` or drop the
ownable plumbing.

### A5. `flight_pool_manager::settle_on_time` does not extend flight TTL on write
`flight_pool_manager/src/lib.rs:329-369`

`settle_with_claim_window` (delayed / cancelled) extends TTL;
`settle_on_time` does not. SettledOnTime entries have no claim flow but are
still read by the indexer / `get_flight_config`. Inconsistency reads as
forgotten line.

### A6. `flight_pool_manager::sweep_expired` does not extend flight TTL on write
`flight_pool_manager/src/lib.rs:500-545`

Updates `cfg.claimed_count` and writes back, but no `extend_flight_ttl`. Once
swept, the flight could drift to archive while still being a valid historical
record.

### A7. Controller `__constructor` magic number `100u32`
`controller/src/lib.rs:281`

Hardcoded default solvency ratio. Promote to
`const DEFAULT_SOLVENCY_RATIO_PCT: u32 = 100;`.

### A8. Magic number `10_000_000i128` in `risk_vault::snapshot`
`risk_vault/src/lib.rs:510-512`

Default share price for empty-vault case. Promote to
`const DEFAULT_SHARE_PRICE: i128 = 10_000_000;` with a comment explaining the
7-decimal unit choice.

### A9. `Vault::set_decimals_offset(e, 3)` magic number
`risk_vault/src/lib.rs:129`

The `3` (decimals offset for share inflation defense) deserves a named
constant or comment.

### A10. `risk_vault::redeem` runs preview twice
`risk_vault/src/lib.rs:184-193`

`Vault::preview_redeem` is called, then `Vault::redeem` recomputes preview
internally. Minor budget cost. Either compute once and call a non-checking
variant, or accept the cost and document.

---

## Repeated code (duplication)

### D1. `require_controller` is reimplemented in 3 contracts
`risk_vault/src/lib.rs:108-116`, `oracle_aggregator/src/lib.rs:85-93`,
`flight_pool_manager/src/lib.rs:68-76`

Identical pattern, identical 3 lines. Soroban contracts can't share code, so
unavoidable, but worth noting as the largest single duplicated helper.

### D2. TTL constants duplicated across 5 contracts
`INSTANCE_TTL_THRESHOLD = 120_960`, `INSTANCE_TTL_EXTEND = 535_680` appear in
every contract. Inevitable in Soroban (no workspace `const` import path that
compiles to WASM cleanly), but worth a single reference comment in each
cross-linking the others.

### D3. `extend_instance_ttl` helper is duplicated across 4 contracts
Same code, same constants. Same constraint as D2.

### D4. `ActiveFlightList: Vec<(Symbol, u64)>` is duplicated
`oracle_aggregator` and `flight_pool_manager` both maintain a list, both have
linear search / remove. Duplication of intent, not just code.

### D5. Controller mirror types duplicate 3 contracts' types
`controller/src/lib.rs:42-155`

`RouteStatus` / `ResolvedTerms`, `FlightStatus` / `FlightData`,
`SettlementStatus` / `FlightConfig`. Pattern B trade-off (documented), but it
*is* duplication and bears a maintenance tax (Pattern B lockstep mirror
discipline, paid 3 times so far). Mention in a top-of-file comment that this
is intentional.

### D6. Repeated `e.storage().instance().get(...).unwrap()` pattern for config reads
Common in controller. Could be one helper `fn instance_get<T>(e, key) -> T`.
Soroban storage API forces these long chains; common workaround is short
module-level read helpers (`fn governance_addr(e) -> Address`).

### D7. `usdc.transfer(&e.current_contract_address(), &to, &amount)` repeated
`risk_vault` (3x), `flight_pool_manager` (2x). One helper per contract would
clean this up.

---

## Readability / simplicity

### R1. Controller `buy_insurance` is 107 lines, 10 steps
`controller/src/lib.rs:329-435`

Numbered comments help, but extracting `validate_route_and_resolve_terms`,
`register_if_first_buy`, `enforce_solvency`, `update_aggregate_counters`
would each be a 5–15 line helper.

### R2. Controller `execute_settlements` has a deep nested match
`controller/src/lib.rs:526-626`

Two large arms could be `fn settle_on_time_path(...)` /
`fn settle_payout_path(...)`.

### R3. `controller::get_stats` returns `(u64, i128, i128)` tuple
`controller/src/lib.rs:647-664`

Caller must remember position. A `pub struct Stats { sold, collected,
distributed }` reads better at the call site.

### R4. Inconsistent section header style
Governance uses `// --- Section ---` (3 dashes), controller uses
`// ─── Section ───` (Unicode), vault mixes both. Cosmetic, but a
workspace-wide style would help.

### R5. Inconsistent error message tone
`"not controller"` vs `"not authorized controller"` vs
`"not authorized keeper"` vs `"not owner or admin"`. Pick one form
("not authorized: <role>" or "<role> auth required") and apply uniformly.

### R6. Mirror-struct lockstep warning is only on one type
`controller/src/lib.rs:88` documents that `FlightData` field order must match
the oracle's struct. Other mirror types (`RouteStatus`, `FlightConfig`) lack
the same warning. Add the same comment to all three.

### R7. `flight_pool_manager::prune_active_list` is O(n) linear search
`flight_pool_manager/src/lib.rs:91-111`

Active list is bounded in practice but still scans on every settle. A
different storage layout (list of `(flight_id, date)` keyed by index, with
index lookup) would amortize, but adds complexity. Leave as-is unless
profiling shows it matters.

### R8. `oracle::get_flights_by_status` does N storage reads
`oracle_aggregator/src/lib.rs:439-453`

One read per active flight to filter. With 30-day retention, that's
potentially many. Consider an off-chain indexer for status filtering rather
than on-chain iteration.

### R9. `risk_vault::process_withdrawal_queue` rebuilds the queue with a fresh `Vec`
`risk_vault/src/lib.rs:360-371`

For long queues this is O(n) per call. `queue.slice(processed..)` may exist
on `soroban_sdk::Vec` and would be cheaper.

### R10. `vault_addr` local binding is good — keep
`risk_vault/src/lib.rs:320`

`let vault_addr = e.current_contract_address();` outside the loop is the
right pattern. Just noting it as a positive example for consistency
elsewhere.

### R11. `controller::buy_insurance` step 4 atomic registration is undocumented
`controller/src/lib.rs:370-381`

Registers flight with oracle and pool atomically. If `oracle.register_flight`
panics, pool registration rolls back atomically — correct behavior, but the
comment doesn't say so. Add a one-line note.

---

## Cleanup (low-risk, mechanical)

### C1. Remove unused `MuxedAddress` imports
`risk_vault/src/lib.rs:3`, `mock_usdc/src/lib.rs:2`

### C2. Remove `OracleError` enum
`oracle_aggregator/src/lib.rs:45-54` — unused.

### C3. Replace controller and FPM `.unwrap()` storage reads with `.expect("...")`
For consistency with vault, oracle, and governance.

### C4. Promote magic numbers to named constants
`100` (controller solvency default), `10_000_000` (vault default share price),
`3` (vault decimals offset).

---

## Out of scope (per audit constraints)

- Architecture changes (contract topology, storage tiers, cross-contract patterns).
- Function renames.
- Removing or adding public functions.
- Changing event shapes.

These constraints were set by the audit request. If any of the above findings
land, they should be implemented as in-place edits that preserve external
behavior.
