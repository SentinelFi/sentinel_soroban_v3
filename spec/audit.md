# Soroban Contract Audit

> Read-only security review of the 6 Soroban contracts (~3,000 LOC of
> production code) deployed by the Sentinel Protocol. No code changes
> proposed in this document — findings are intended to drive a follow-on
> remediation PR and to inform a third-party audit scope.
>
> **Scope:** `mock_usdc`, `governance_module`, `risk_vault`,
> `oracle_aggregator`, `flight_pool_manager`, `controller`. Integration
> tests reviewed for coverage but not audited.
>
> **Toolchain:** `soroban-sdk 25.3.1`, `stellar-tokens 0.7.1`,
> `stellar-access 0.7.1`, `stellar-macros 0.7.1`, `stellar-contract-utils 0.7.1`.
> Built with `rustc 1.94.0` targeting `wasm32v1-none`. Release profile sets
> `overflow-checks = true`, `panic = "abort"`, `lto = true`.
>
> **Test corpus:** 228 unit + integration tests (`cargo test --workspace`).

---

## Contents

1. [Executive summary](#executive-summary)
2. [Trust model & roles](#trust-model--roles)
3. [Findings index](#findings-index)
4. [Critical findings](#critical-findings)
5. [High findings](#high-findings)
6. [Medium findings](#medium-findings)
7. [Low findings](#low-findings)
8. [Informational findings](#informational-findings)
9. [Positive findings (defense-in-depth that works)](#positive-findings-defense-in-depth-that-works)
10. [Recommendations](#recommendations)
11. [Out-of-scope / deferred](#out-of-scope--deferred)

---

## Executive summary

| Severity | Count |
|---|---|
| Critical | 3 |
| High | 7 |
| Medium | 6 |
| Low | 9 |
| Informational | 7 |
| Positive | 11 |

**Headline risks before mainnet:**

- **C-01** ⚠ Default `claim_expiry_window` (60d) exceeds `PERSISTENT_TTL_EXTEND` (31d) in `flight_pool_manager`. Buyers can be locked out of payouts if the off-chain TTL cron is absent.
- **C-02** ⚠ `risk_vault::recover_uncollected` Transfer mode has no upper-bound check and does not decrement TMA. Owner can silently break the solvency invariant or drain USDC.
- **C-03** ⚠ `mock_usdc` is permissionless mint. Deploying it to mainnet would let anyone print supply. Must be replaced by Circle USDC (SAC) on mainnet.
- **H-03** ⚠ No emergency-stop / pause across any contract. A discovered exploit cannot be halted.
- **H-04** ⚠ Governance admins can set `delay_hours = 0` or `payoff < premium`, which respectively drains the vault or panics every settlement.

**Overall posture:** the contracts use defensive Rust idioms (checked arithmetic, OZ Vault decimals offset, forward-only state machine, one-time controller write, overflow checks at the profile level). The remaining surface is concentrated in *operational* concerns — TTL coordination, owner privilege scope, and resource-bounded list iteration — rather than core arithmetic correctness.

---

## Trust model & roles

| Role | Held by | Powers (selected) |
|---|---|---|
| Owner | One Address per contract (single-key by default) | Set keeper, solvency ratio, lead time, claim window; rotate oracle; recover uncollected balances; add/remove governance admins; set defaults |
| Governance admin | Address(es) added by owner | Whitelist / disable / enable / remove / update routes |
| Authorized keeper | Set by controller owner | Call `classify_flights`, `execute_settlements` |
| Authorized oracle | Set by oracle owner | Write `estimated_arrival_time`, `actual_arrival_time`, `set_cancelled` |
| Controller | Set once on each downstream contract (oracle, vault, pool) | Cross-contract orchestrator; only address allowed to mutate vault locked capital, pool flight lifecycle, oracle settlement state |
| Underwriter | Any wallet | Deposit, withdraw (direct or queued), collect claimable, cancel queue request |
| Traveler | Any wallet | Buy insurance, claim payoff |

**Trust assumptions baked into the design:**

1. Owner is honest and key-secure (single Address, no multisig requirement enforced on-chain).
2. Authorized oracle reports truthful flight data; there is no on-chain plausibility check.
3. Off-chain TTL-extender cron runs reliably to keep `ClaimableBalance(addr)`, `Route(...)`, `FlightConfig(...)`, and `FlightData(...)` keys alive past their on-write TTL.
4. The configured USDC contract is the Stellar Asset Contract (SAC) and has no transfer hooks (no reentrancy surface on `usdc.transfer`).
5. Owner does not call `recover_uncollected` on users who never had a credit (would silently inflate share price).

---

## Findings index

| ID | Title | Severity | Area |
|---|---|---|---|
| C-01 | Flight TTL < claim window — buyers can lose payout | Critical | `flight_pool_manager` |
| C-02 | `recover_uncollected` Transfer breaks TMA & has no bounds | Critical | `risk_vault` |
| C-03 | `mock_usdc` permissionless mint must not reach mainnet | Critical | Deployment |
| H-01 | `recover_uncollected` Recredit SETs (not adds) — silent underpay | High | `risk_vault` |
| H-02 | `prune_settled` panics on any archived `FlightData` | High | `oracle_aggregator` |
| H-03 | No pause / emergency-stop on any contract | High | All |
| H-04 | Admin can set `delay_hours = 0` or `payoff < premium` | High | `governance_module` |
| H-05 | INTERACT-then-EFFECT in `collect`, `send_payout`, `withdraw_recovered` | High | `risk_vault`, `flight_pool_manager` |
| H-06 | `process_withdrawal_queue` price drift across iterations | High | `risk_vault` |
| H-07 | Owner can brick protocol by setting `claim_expiry_window = 0` | High | `controller` |
| M-01 | Unbounded growth: `ActiveFlightList`, `WithdrawalQueue`, `TravelerFlights` | Medium | `flight_pool_manager`, `oracle_aggregator`, `risk_vault`, `controller` |
| M-02 | No bounds on `solvency_ratio`, `min_lead_time`, `claim_expiry_window` | Medium | `controller` |
| M-03 | `process_withdrawal_queue` blocked by gas if active-flight loop is large | Medium | `controller`, `risk_vault` |
| M-04 | `cancel_withdrawal` uses queue index — wrong-request risk after reorder | Medium | `risk_vault` |
| M-05 | First-buyer race condition on a new (flight_id, date) route | Medium | `controller` |
| M-06 | `record_premium_income` does not verify USDC arrived | Medium | `risk_vault` |
| L-01 | `NotInitiated → Cancelled` is not a valid transition | Low | `oracle_aggregator` |
| L-02 | No validation that `actual_arrival_time > estimated_arrival_time` | Low | `oracle_aggregator` |
| L-03 | Generic event topic prefixes (`ctrl`, `settle`, `claim`…) | Low | All |
| L-04 | Snapshot price scaling hardcoded for 7-decimal USDC | Low | `risk_vault` |
| L-05 | `snapshot()` emits no event | Low | `risk_vault` |
| L-06 | No upper bound on `buyer_count` per flight | Low | `flight_pool_manager` |
| L-07 | Admin can front-run a buyer by disabling the route | Low | `governance_module` |
| L-08 | `InsuranceBought` event omits flight_id / date | Low | `controller` |
| L-09 | `extend_ttl` (no auth) is callable by anyone | Low | All |
| I-01 | clippy pedantic surfaces digit-grouping and fn-arity nits | Info | All |
| I-02 | Single-key owner; consider multisig governance | Info | All |
| I-03 | No upgrade path (intentional) | Info | All |
| I-04 | `TtlMiss` diagnostic is good observability | Info | `controller` |
| I-05 | Cross-contract mirror types in `controller/interfaces.rs` rely on byte-level layout | Info | `controller` |
| I-06 | No `cargo audit` advisory check in CI | Info | Tooling |
| I-07 | Test snapshots are SDK-version-specific | Info | Tooling |

---

## Critical findings

### C-01. Flight config TTL is shorter than the claim window — buyers can lose access to their payout

**Files:** `flight_pool_manager/src/storage.rs:42-43`, `flight_pool_manager/src/settle.rs:107` (extend), `controller/src/admin.rs:85-90` (claim_expiry_window setter), default value in `integration_tests/src/tests/setup.rs:11` (60 days).

`PERSISTENT_TTL_EXTEND = 535_680 ledgers ≈ 31 days`. On `settle_delayed` / `settle_cancelled` the pool calls `extend_flight_ttl` which raises `FlightConfig(flight_id, date)`'s TTL to ~31 days from settle time. The default `claim_expiry_window` is **60 days**.

Between **day 31 and day 60 post-settle**, if no buyer has called `claim()` (which would itself extend the TTL on each call), the persistent entry for `FlightConfig(flight_id, date)` can be archived. Calling `claim()` after archival fails with `"flight not registered"` because `.expect("flight not registered")` panics on `None`.

The off-chain TTL-extender cron is designed to bump these keys, but the architecture explicitly accepts that cron failure (downtime, bug, mis-funded operator) is possible. There is no on-chain fallback for travelers; the `recover_uncollected` mechanism is vault-side only.

**Impact.** Travelers with valid delayed/cancelled claims permanently lose access to their payoff if (a) they don't claim in the first 31 days post-settle, and (b) the off-chain cron is absent during that window.

**Recommendation.** Either:
- Raise `PERSISTENT_TTL_EXTEND` to ≥ `claim_expiry_window + buffer` (e.g., 90 days), **or**
- In `settle_with_claim_window`, extend `FlightConfig` TTL to `(claim_expiry - now) + buffer` ledgers explicitly, **or**
- Add an owner-callable "force-extend flight TTL" recovery on the pool analogous to `recover_uncollected`.

---

### C-02. `risk_vault::recover_uncollected` Transfer mode breaks the solvency invariant and has no upper bound

**File:** `risk_vault/src/claims.rs:98-129`.

```rust
RecoveryMode::Transfer => {
    let usdc = token::Client::new(e, &Vault::query_asset(e));
    usdc.transfer(&e.current_contract_address(), &user, &amount);
}
```

Three independent problems:

1. **No upper-bound check.** `amount` is only constrained to `> 0`. Owner can transfer up to the vault's full USDC balance to any address.
2. **Does not decrement TMA.** Vault USDC leaves but `TotalManagedAssets` stays unchanged. Subsequent `get_free_capital()` returns an inflated number. Subsequent `withdraw()` will see free capital that is no longer actually backed by USDC, and the underlying token transfer may revert mid-execution — but only after some state writes have already happened.
3. **Does not check that the user had a prior `ClaimableBalance` credit.** The docstring says "for archived ClaimableBalance entries", but the code does not enforce this. Owner can transfer to anyone, breaking the TMA invariant if they do.

**Impact.** Owner with a typo (or a compromised owner key) can silently destroy the share-price accounting for all underwriters. With an upper bound + TMA decrement enforced, Recover-Transfer would be a fully-checked operation; without them it is godmode.

**Recommendation.**
- For Transfer mode: require `amount <= claimable_persisted_or_zero(user)`, decrement TMA by `amount`, and assert `amount <= get_free_capital(e)` (or alternatively assert against a stored "owed" ledger reconstructed off-chain).
- Optionally split into two functions (`recredit_archived` / `transfer_to_user`) so the trust surface is named explicitly.

---

### C-03. `mock_usdc` permissionless mint must never reach mainnet

**File:** `mock_usdc/src/lib.rs:22-29`.

```rust
pub fn mint(e: &Env, to: Address, amount: i128) { Base::mint(e, &to, amount); }
pub fn faucet(e: &Env, to: Address) { Base::mint(e, &to, 10_000_0000000); }
```

Neither function requires auth. Anyone can mint arbitrary supply to any address. This is explicit in the doc comment ("Permissionless mint") and intentional for testnet.

**Impact.** If accidentally deployed to mainnet or wired into the controller in place of real USDC, an attacker mints unlimited USDC, deposits to RiskVault, withdraws real underlying USDC (if pooled), drains everything.

**Recommendation.**
- Add a `cfg(...)` or build-flag gate so this crate cannot be built for `wasm32v1-none` without `--features testnet`.
- Document in deployment runbook that mainnet uses Circle USDC SAC address (not `mock_usdc`).
- CI step that fails if `mock_usdc` appears in a mainnet deploy manifest.

---

## High findings

### H-01. `recover_uncollected` Recredit mode SETs the balance (not adds) — silent underpayment risk

**File:** `risk_vault/src/claims.rs:107-115`.

```rust
RecoveryMode::Recredit => {
    let key = VaultKey::ClaimableBalance(user.clone());
    e.storage().persistent().set(&key, &amount);  // SET, not ADD
    ...
}
```

Function name "recover" reads as additive. The docstring explains the SET semantic, but only for the "archived entry" path. If a user has a *current* non-zero `ClaimableBalance` (e.g., processed but not yet collected) and the owner Recredits with a smaller value, the user loses the difference silently.

**Impact.** Owner mistake → user underpaid; no audit trail beyond the emitted `Recovered` event amount.

**Recommendation.**
- Either rename `Recredit → Replace` (truth-in-naming), **or**
- Read existing balance and `assert!(amount >= existing, "would underpay")`.

---

### H-02. `oracle_aggregator::prune_settled` panics on any archived `FlightData`

**File:** `oracle_aggregator/src/lib.rs:258-264`.

```rust
for i in 0..list.len() {
    let (flight_id, date) = list.get(i).unwrap();
    let data: FlightData = e.storage().persistent()
        .get(&OracleKey::FlightData(flight_id.clone(), date))
        .expect("flight data missing");   // <-- panics
    ...
}
```

`ActiveFlightList` lives in **instance** storage (auto-extended with contract instance TTL), but each `FlightData(flight_id, date)` lives in **persistent** storage. If a single FlightData entry archives (off-chain TTL cron failure), the entire `prune_settled` loop panics. The active list cannot be trimmed, so it grows unbounded, eventually breaking the iteration in `classify_flights` and `execute_settlements` via gas exhaustion or instance-storage size limits.

**Impact.** Single archived entry → permanent inability to prune → cascading list growth → eventual settlement DOS.

**Recommendation.** Treat missing FlightData as "drop from list" (the entry is dead anyway):
```rust
let aged_out = match e.storage().persistent().get(...) {
    None => true,                              // archived → evict
    Some(data) => data.status == FlightStatus::Settled
                  && data.settled_at != 0
                  && age_seconds >= SETTLED_RETENTION_DAYS * SECONDS_PER_DAY,
};
```

---

### H-03. No pause / emergency-stop on any contract

**Files:** all 5 production contracts.

There is no `Pausable` trait wired in, no admin "halt" function, no circuit breaker. The OZ `stellar-pausable` crate is available but not used.

**Impact.** A discovered exploit in any of `buy_insurance`, `claim`, `withdraw`, `process_withdrawal_queue`, `send_payout`, or `recover_uncollected` cannot be halted by the owner. Funds remain extractable until a code change is deployed — and there is no upgrade path (I-03), so a fork + redeploy is the only remediation.

**Recommendation.**
- Add `Pausable` (from `stellar-pausable`) to each contract with `#[when_not_paused]` on every state-mutating entry point.
- Pause is owner-only. Unpause is owner-only (or timelock-gated).
- Pausing one contract should naturally cascade because cross-contract calls would fail (`controller` calls `vault.send_payout` → vault pauses → tx reverts).

---

### H-04. Governance admin can set `delay_hours = 0` or `payoff < premium` and drain (or brick) settlement

**Files:** `governance_module/src/lib.rs:86-117, 204-251`. Trust model: admin is added by owner (`#[only_owner] add_admin`) but admins are not bonded.

`whitelist_route` and `update_route_terms` accept arbitrary `Option<i128>` premium / `Option<i128>` payoff / `Option<u32>` delay_hours. There is no on-chain assertion that:
- `payoff > premium` (required by `execute_settlements` ToBeSettledDelayed/Cancelled branch, which computes `(payoff - premium) * count` via `checked_sub` — panics on inversion).
- `delay_hours > 0` (with `0`, every flight that lands at all classifies as Delayed via `delay_hours_actual >= 0`, triggering a payout for any landing).
- `premium > 0` and `payoff > 0` (pool's `register_flight` asserts at lock time, but a route can sit with `Some(0)` until first purchase).

**Impact scenarios** (malicious or careless admin):
- `delay_hours = 0`: vault drained on every flight settlement.
- `payoff < premium`: every delayed/cancelled settlement of that route panics → flights stuck in `ToBeSettled*` forever → vault collateral locked indefinitely.
- `premium = 0, payoff = large`: free insurance, full vault drain.

Existing routes are not affected by later term changes (terms are locked at `pool.register_flight` time), so the blast radius is limited to *new* purchases after the bad update. But because purchases keep coming, the damage compounds.

**Recommendation.** Add asserts in `whitelist_route` and `update_route_terms`:
```rust
if let Some(d) = delay_hours { assert!(d > 0); }
match (premium, payoff) {
    (Some(p), Some(o)) => assert!(o > p, "payoff must exceed premium"),
    (Some(p), None)    => assert!(read_defaults(e).1 > p, "payoff must exceed premium"),
    (None, Some(o))    => assert!(o > read_defaults(e).0, "payoff must exceed premium"),
    _ => {}
}
```
Plus the same checks in `set_defaults`. Optionally, raise the bar so admin can only *propose* a route change that owner then approves (timelock or two-step).

---

### H-05. INTERACT-then-EFFECT ordering in three USDC-transferring functions

**Files:**
- `risk_vault/src/claims.rs:60-79` (`collect`): `usdc.transfer` → `persistent.remove` → emit.
- `risk_vault/src/capital.rs:48-61` (`send_payout`): `usdc.transfer` → TMA decrement.
- `flight_pool_manager/src/admin.rs:53-60` (`withdraw_recovered`): `usdc.transfer` → `RecoveredBalance` decrement.

The interaction (USDC transfer to a user-controlled or contract-controlled address) happens *before* the corresponding state update. This is the textbook CEI (checks-effects-interactions) anti-pattern.

**Why this is currently safe (and why it should still be fixed):**

The standard Stellar Asset Contract (SAC) used for real USDC has no transfer hooks — `usdc.transfer` does not call back into the recipient or into the vault. So no reentrancy surface exists *today*. However:

1. The vault's `asset` is set in `__constructor` and never validated to be a SAC. If a deployment misconfiguration points it at a custom Soroban token with hooks, reentrancy becomes exploitable. `collect()` could be called recursively to drain `ClaimableBalance` multiple times against a single credit.
2. Defensive coding is cheap here — move the storage write above the transfer.

**Recommendation.** Reorder all three to write state first, then transfer. For `collect`:
```rust
e.storage().persistent().remove(&key);
Collected { user: caller, amount: claimable }.publish(e);
let usdc = token::Client::new(e, &Vault::query_asset(e));
usdc.transfer(&e.current_contract_address(), &caller, &claimable);
```

For `flight_pool_manager::claim` (claim.rs:47-61), the order is already correct (`claimed_key = true` before transfer). Use that as the template.

---

### H-06. `process_withdrawal_queue` share price drifts across loop iterations

**File:** `risk_vault/src/capital.rs:81-118`.

The loop processes withdrawal requests one at a time. Each iteration:

1. Computes `assets = Vault::preview_redeem(e, request.shares)` based on **current** storage state.
2. Burns `request.shares` via `Base::update` — this decreases `total_supply` in storage immediately.
3. Updates the local `tma` variable but does **not** write it back to storage until after the loop.

Because OZ's `Vault::total_assets(e)` reads stored TMA (not actual USDC balance), and `preview_redeem` uses `total_assets / (total_supply + virtual_shares)`, the price seen by iteration N depends on the cumulative `total_supply` reduction from iterations 0..N-1 *without* the corresponding TMA reduction being reflected in storage.

Concretely: each subsequent request in the queue gets MORE assets per share than the requests ahead of it. The order in the queue determines payout efficiency.

**Impact.**
- Fairness: queue position affects effective price. FIFO ordering means latecomers benefit, not the equity ordering one would expect.
- Not directly exploitable because users cannot reorder themselves — the controller calls `process_withdrawal_queue` and the queue is processed in submission order.
- Could be combined with M-04 (cancel-and-resubmit) to drift toward end-of-queue intentionally.

**Recommendation.** Write TMA back to storage inside each iteration (`e.storage().instance().set(&VaultKey::TotalManagedAssets, &tma)`), or refactor to compute all `preview_redeem` values upfront before any `Base::update` burns.

---

### H-07. Owner can brick the protocol by setting `claim_expiry_window = 0`

**File:** `controller/src/admin.rs:85-90`.

```rust
#[only_owner]
pub fn set_claim_expiry_window(e: &Env, seconds: u64) {
    e.storage().instance().set(&CtrlKey::ClaimExpiryWindow, &seconds);
    ...
}
```

No bound on `seconds`. If owner (or compromised owner key) sets to `0`:
- `execute_settlements` computes `claim_expiry = timestamp + 0 = timestamp`.
- `pool.settle_delayed` / `settle_cancelled` asserts `claim_expiry > timestamp` (`flight_pool_manager/src/settle.rs:100`) → panics.
- All future delayed/cancelled settlements fail.
- Locked collateral stays locked.
- Underwriters cannot redeem because `decrease_locked` is gated behind successful settlement.
- **Protocol effectively dead.**

Similar concern: `set_min_lead_time = u64::MAX` blocks all purchases; `set_solvency_ratio = u32::MAX` makes every purchase fail solvency check.

**Recommendation.** Add lower/upper bounds on the four owner setters:
```rust
assert!(seconds >= MIN_CLAIM_WINDOW && seconds <= MAX_CLAIM_WINDOW);
assert!(ratio >= 100 && ratio <= MAX_SOLVENCY_RATIO);   // 100% minimum
```

---

## Medium findings

### M-01. Unbounded list growth

| Location | List | Growth driver | Mitigation present |
|---|---|---|---|
| `flight_pool_manager` instance storage | `ActiveFlightList: Vec<(Symbol, u64)>` | `register_flight` (one per route + date) | Trimmed in `prune_active_list` on settle |
| `oracle_aggregator` instance storage | `ActiveFlightList: Vec<(Symbol, u64)>` | `register_flight` | Trimmed in `prune_settled` (30d retention) |
| `risk_vault` instance storage | `WithdrawalQueue: Vec<WithdrawalRequest>` | `request_withdrawal` (one per call) | Drained in `process_withdrawal_queue` |
| `controller` persistent storage | `TravelerFlights(addr): Vec<(Symbol, u64)>` | `append_traveler_flight` on every buy | None — append-only |

**Specific concerns:**
- Soroban instance storage has a tight size limit (single ledger entry, ~64KB total). Hundreds of active flights can fill it.
- `TravelerFlights(addr)` is per-user but append-only with no cap. A whale with thousands of policies eventually hits the per-entry size limit and cannot buy more insurance.
- `WithdrawalQueue` can be spammed with `shares = 1` requests (M-X below).

**Recommendation.** Cap list sizes (e.g., max 1000 active flights system-wide; max 100 policies per traveler — older entries can be archived to off-chain index since events carry the same data). Or migrate to keyed multi-row patterns (`PoolKey::ActiveFlight(idx)` enumerable maps).

### M-02. Owner setters have no bounds (related to H-07)

Already covered for `claim_expiry_window` in H-07. Same applies to `solvency_ratio`, `min_lead_time`, and oracle's `set_oracle` (no zero-address check — but Stellar has no zero address concept, so this is mostly nominal).

### M-03. `process_withdrawal_queue` blocked by `execute_settlements` gas exhaustion

**File:** `controller/src/settle.rs:96-214`.

`execute_settlements` loops the active flight list, then calls `vault.process_withdrawal_queue(&controller_addr)`. If the flights loop exhausts the Soroban resource budget (CPU instructions, ledger reads), the tx reverts before reaching the queue drain. Underwriters wait indefinitely.

**Recommendation.** Move `process_withdrawal_queue` and `snapshot` to a separate keeper entry point (`controller::run_queue_maintenance`) so they can be invoked independently when settlements are too heavy.

### M-04. `cancel_withdrawal` uses a queue index — wrong-request risk

**File:** `risk_vault/src/claims.rs:39-58`.

```rust
pub fn cancel_withdrawal(e: &Env, caller: Address, queue_index: u32) {
    ...
    let request = queue.get(queue_index).expect("invalid queue index");
    assert!(request.owner == caller, "not your request");
    ...
}
```

If `execute_settlements` processes earlier requests between a user's submission and their cancel, the indices shift left. A user passing the index they observed at submission time will hit either a different request (caught by owner assert) or the wrong one of *their own* requests if they have multiple in the queue.

**Recommendation.** Identify requests by submission timestamp or by a request-id, not by current queue position.

### M-05. First-buyer race condition on a new (flight_id, date)

**File:** `controller/src/purchase.rs:53-65`.

Two travelers submitting `buy_insurance` for the same new route in the same ledger: only one's tx succeeds the `pool.register_flight` (the other panics on "flight already registered"). The losing traveler must retry.

**Impact.** UX/availability. Not a fund-loss bug, but spammy.

**Recommendation.** Handle the duplicate-registration case gracefully (read after attempted register, or check + retry the `is_none` branch).

### M-06. `record_premium_income` accepts caller's stated amount without verifying USDC arrived

**File:** `risk_vault/src/capital.rs:38-46`.

```rust
pub fn record_premium_income(e: &Env, controller: Address, amount: i128) {
    require_controller(e, &controller);
    assert!(amount > 0, "amount must be positive");
    let tma = Self::get_total_managed_assets(e);
    e.storage().instance().set(&VaultKey::TotalManagedAssets,
        &tma.checked_add(amount).expect("addition overflow"));
}
```

The vault credits TMA based on `amount` passed by the caller (controller), trusting that the pool actually transferred USDC for that amount immediately before. The check is structural (only controller can call) but not balance-based.

**Risk model.** If the controller is compromised or buggy, the vault's accounting drifts upward; subsequent withdrawals draw against ghost capital.

**Recommendation.** Either (a) verify vault USDC balance increased by ≥ `amount` since prior recorded balance, or (b) accept the trust assumption and document explicitly that vault TMA correctness is contingent on controller correctness.

---

## Low findings

### L-01. `NotInitiated → Cancelled` is not in `is_valid_transition`

**File:** `oracle_aggregator/src/storage.rs:55-68`.

The accepted edges are `NotInitiated → Active`, `Active → Cancelled`. If a flight is cancelled before the oracle ever fetches estimated arrival, the oracle cannot record the cancellation (would have to `set_estimated_arrival` first, then `set_cancelled`). Real-world edge case for short-notice cancellations.

**Recommendation.** Add `(NotInitiated, Cancelled)` to the accepted edges.

### L-02. `actual_arrival_time` not validated against `estimated_arrival_time`

**File:** `oracle_aggregator/src/lib.rs:90-117`.

The oracle could `set_landed` with `actual_arrival_time < estimated_arrival_time`. In `classify_flights` (controller), `saturating_sub` handles the underflow but classifies as on-time. So an honest oracle is fine, a buggy/compromised one could mark every flight as on-time (no payouts → underwriters profit, travelers harmed).

**Recommendation.** Either assert `actual >= estimated` in `set_landed`, or accept this as part of the oracle trust model and document.

### L-03. Generic event topic prefixes

**Files:** all event modules.

Topics like `["ctrl"]`, `["settle"]`, `["claim"]`, `["register"]`, `["sweep"]`, `["withdraw"]` are short generic words likely to collide with topics from unrelated Soroban contracts indexed by the same off-chain tool.

**Recommendation.** Namespace under the protocol (e.g., `["sentinel", "settle"]`).

### L-04. Snapshot price scaling factor is hardcoded for 7-decimal USDC

**File:** `risk_vault/src/snapshot.rs:30`.

```rust
.checked_mul(10_000_000i128)  // 10^7, matches USDC decimals
```

If the underlying asset is changed to anything other than 7-decimal USDC (e.g., 6-decimal USDC on other chains, or a 18-decimal stablecoin), the price metric becomes meaningless.

**Recommendation.** Derive scaling from `Vault::query_asset` and the asset's `decimals()`.

### L-05. `snapshot()` emits no event

**File:** `risk_vault/src/snapshot.rs:10-52`.

Snapshot writes to temporary storage but emits no event. Off-chain analytics tools cannot subscribe to share-price updates; they must poll.

**Recommendation.** Emit a `SharePriceSnapshot { day, price }` event.

### L-06. No upper bound on `buyer_count` per flight

**File:** `flight_pool_manager/src/lifecycle.rs:63-105`.

`buyer_count` is a u32, capped by checked_add at 2^32. Practical limit hit much earlier when `total_payoff = payoff * buyer_count` overflows i128 (extremely unlikely for realistic payoffs). Not exploitable, but no design intent to cap.

### L-07. Admin can disable a route between traveler submission and inclusion

Standard timing-attack surface: admin sees a buy tx in mempool, front-runs with `disable_route`, traveler's tx reverts. Limited to griefing; admin gains nothing.

### L-08. `InsuranceBought` event omits flight_id and date

**File:** `controller/src/events.rs:5-10`.

```rust
#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct InsuranceBought {
    #[topic] pub(crate) traveler: Address,
    pub(crate) premium: i128,
}
```

Asymmetric with `FlightClassified` and `FlightSettledEvent` which both carry flight_id+date as topics. Indexer needs to cross-reference `BuyerAdded` from the pool to know which flight the traveler bought.

**Recommendation.** Add `flight_id` and `date` as topics (intentional or oversight?).

### L-09. `extend_ttl` is callable by anyone on every contract

All 5 contracts expose `pub fn extend_ttl(e: &Env)` with no auth, intended for cron use. This is generally fine — extending TTL is permissionless housekeeping — but a griefer could call it every block to spike storage costs. The Soroban fee model makes this self-paying so it's economically pointless; flag only.

---

## Informational findings

### I-01. clippy pedantic surfaces ~280 warnings

`cargo clippy --workspace --all-targets -- -W clippy::pedantic` reports:
- 117 `digit groups should be smaller` / 46 `digits grouped inconsistently` — token-amount literals like `10_0000000` mix 4- and 7-digit groupings. Project convention; consider `#![allow(clippy::inconsistent_digit_grouping, clippy::unreadable_literal)]` at workspace level to silence.
- 44 `method could have a #[must_use] attribute` — getters returning values; idiomatic but noisy.
- 40 `docs for function which may panic missing # Panics section` — Soroban contracts use `.unwrap()` / `.expect()` liberally as the panic-is-revert pattern; documenting each is unwieldy.
- 6 `casts from u32 to i128 can be expressed infallibly using From` — minor stylistic improvements available.
- 4–8 `function has too many arguments` — Soroban entry points have many params by necessity.

None are security issues; CI can be tuned to enforce or ignore.

### I-02. Single-key owner across all contracts

Each contract's `Owner` is one Address. No on-chain multisig or timelock requirement. Recommendation: deploy with owner set to a Stellar account that is itself a multisig (m-of-n signers via the standard `set_options`), or use an upgradable contract pattern with a timelock. Document the owner key management plan in the deployment runbook.

### I-03. No upgrade path

Contracts use `#[contract]` without an upgrade mechanism. **This is a positive** — no upgrade key risk — but **bugs cannot be fixed without a migration to new contract addresses**. The architecture should document the migration strategy (re-deploy + run a one-shot indexer to transition state).

### I-04. `TtlMiss` diagnostic is good observability

`controller/src/events.rs:34-39` and `controller/src/settle.rs:67-71` — when classify_flights sees a flight in the oracle's active list but with archived FlightData, it emits a `["warn", "ttl_miss"]` event without breaking the loop. This is excellent defensive observability and should be replicated for other "should-not-happen" branches.

### I-05. Cross-contract mirror types in `controller/interfaces.rs` rely on byte-level XDR layout matching

`FlightStatus`, `FlightData`, `FlightConfig`, `RouteStatus`, `ResolvedTerms`, `SettlementStatus` are duplicated in the controller crate with `#[contracttype]` and must match the upstream contract's field order exactly. The doc comment notes this. If the upstream contract reorders fields, the controller deserializes garbage at runtime.

**Recommendation.** Extract the shared types into a tiny `sentinel-types` crate that controller, pool, vault, oracle all depend on. Single source of truth, no drift possible.

### I-06. No `cargo audit` advisory check in CI

`cargo-audit` is not installed locally and (presumably) not in CI. Recommended to add `cargo install cargo-audit && cargo audit` as a CI gate to catch advisories in `soroban-sdk`, `stellar-tokens`, and their transitive deps.

### I-07. Test snapshots are SDK-version-specific

The 200+ JSON files under `contracts/*/test_snapshots/` are regenerated whenever `soroban-sdk` version changes (we saw the entire set rewrite on the 23 → 25.3.1 bump). Worth noting that the snapshot diff is not meaningful as a code review surface; reviewers should `.gitignore` the snapshot directory in code-review tooling or use a custom diff strategy.

---

## Positive findings (defense-in-depth that works)

1. **`checked_*` arithmetic everywhere on i128 / u64 / u32 in production code.** Every `+`, `-`, `*`, `/` on protocol-managed values goes through `checked_*().expect(...)`. Belt and suspenders with `overflow-checks = true` in the release profile.

2. **OZ Vault `decimals_offset = 3`** (`risk_vault/src/admin.rs:22`). Adds ~10³ virtual shares, neutralizing the ERC-4626 first-depositor share-price inflation attack at realistic vault sizes.

3. **One-time controller write protection.** Each downstream contract (`risk_vault::set_controller`, `flight_pool_manager::set_controller`, `oracle_aggregator::set_controller`) asserts the slot is empty before writing. Owner cannot rug-pull the controller after deployment.

4. **Forward-only flight state machine** (`oracle_aggregator/src/storage.rs:55-68`). Explicit `matches!` table of accepted edges; no retrograde transitions; no state corruption via misordered oracle calls.

5. **`saturating_sub` for delay computation** (`controller/src/settle.rs:47-49`). Buggy or adversarial oracle reporting `actual < estimated` gracefully gives `delay = 0` (classified on-time) instead of panic or underflow.

6. **`prune_settled` and `sweep_expired` are permissionless.** Housekeeping is not admin-gated, so a malicious admin cannot block normal operation by withholding cron access.

7. **Controller-address-comparison auth on vault / pool / oracle.** `require_controller` stores the controller address explicitly and asserts `caller == stored`. Cannot be spoofed by setting `caller = e.current_contract_address()` from a different contract.

8. **TTL extension on every persistent write.** `extend_flight_ttl`, `extend_route_ttl`, `CLAIMABLE_TTL_LEDGERS` extension on `process_withdrawal_queue` credit. Combined with the off-chain cron, gives layered defense against archival.

9. **`#[only_owner]` macro from `stellar-macros`** correctly applied to all owner-only setters. Auth is enforced at the macro-expansion level, not by hand-rolled checks (which would be miss-prone).

10. **Constructor arg lists are explicit.** No default values; every cross-contract address and parameter is passed at deploy time. Reduces "forgot to set X" risk.

11. **Test coverage is broad.** 228 tests across unit (per-contract) and integration (cross-contract) suites. Notable test groups: `group6_authorization` (auth panic guards), `group8_events` (event chain assertions), `group3_withdrawal` (recover_uncollected paths).

---

## Recommendations

**Pre-mainnet checklist (in priority order):**

1. [ ] Fix **C-01** (flight TTL ≥ claim window) — single-line constant change.
2. [ ] Fix **C-02** (bound `recover_uncollected` Transfer, decrement TMA, check claimable prior).
3. [ ] Gate **C-03** (`mock_usdc` cannot ship to mainnet) at build / deploy level.
4. [ ] Decide on **H-03** (pausable) — add `Pausable` to all 5 contracts.
5. [ ] Fix **H-04** (governance validation on `delay_hours > 0` and `payoff > premium`).
6. [ ] Reorder CEI in **H-05** (`collect`, `send_payout`, `withdraw_recovered`).
7. [ ] Fix **H-07** (bounds on owner setters).
8. [ ] Fix **H-02** (treat missing FlightData as evictable, not panic).
9. [ ] Fix **H-01** (rename to `Replace` or assert ≥ existing).
10. [ ] Fix **H-06** (write TMA inside loop).
11. [ ] Address **M-01** to **M-06** as time allows.
12. [ ] Extract shared types into `sentinel-types` crate (**I-05**).
13. [ ] Add `cargo audit` to CI (**I-06**).
14. [ ] Engage a third-party Soroban auditor (Trail of Bits, Halborn, Runtime Verification, OtterSec) for the contracts pre-mainnet. The findings here are based on manual review and should be cross-checked.

**Operational recommendations:**

- Deploy with a **multisig owner** on each contract.
- Run the **off-chain TTL cron** on at least two independent operators with alerting if any cron lapse exceeds a 7-day moving window.
- Document the **deployment runbook** with mainnet USDC SAC address, contract address pinning, and post-deploy verification (call `get_keeper`, `get_controller`, etc. and verify expected values).
- Set up a **mainnet bug bounty** (Immunefi or similar) before any real-money exposure.
- Maintain a **post-deploy state diff dashboard** (TMA vs. actual USDC balance, locked vs. free, queue length) for invariant monitoring.

---

## Out-of-scope / deferred

- **Off-chain executor (Phase 11+).** Cron jobs that drive `set_estimated_arrival`, `classify_flights`, `execute_settlements`, `extend_ttl` are out of scope here. Audit them separately when implemented.
- **Frontend (dApp).** No frontend code was reviewed.
- **Deploy scripts.** Not reviewed; recommend a separate review of the deploy workflow once written.
- **`stellar-tokens` / `stellar-access` 0.7.1 source.** Treated as trusted dependency. The OZ Stellar Contracts library has had public audits; verify the deployed version matches an audited release.
- **`soroban-sdk` 25.3.1 itself.** Out of scope; we trust the Stellar SDF release.
- **Integration test correctness.** Tests reviewed for *coverage signal* only — that the right paths are exercised — not for tightness of assertions. A focused review of `integration_tests/src/tests/group*.rs` would be worthwhile pre-mainnet.

---

*Audit prepared by automated assistant. This document is not a substitute for a third-party security audit by a specialized Soroban / Stellar auditor.*
