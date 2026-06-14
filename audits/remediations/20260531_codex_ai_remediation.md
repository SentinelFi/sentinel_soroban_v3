# Codex AI Report — Remediation Summary

**Source report:** [`20260531_codex_ai_report.md`](../20260531_codex_ai_report.md)
**Remediation date:** 2026-06-14
**Scope:** 6 production contracts + `sentinel_types` (per the original report).
**Test status:** full workspace suite green after changes — **302 tests pass**
(`cd contracts && cargo test --workspace`); `cargo clippy --workspace
--all-targets` clean; dev + release builds clean; `mock_usdc` also builds with
`--no-default-features`.

Each finding was validated against source, then fixed.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| ASF-01 | High | Confirmed | ✅ Fixed (max booking horizon + lifecycle invariant) |
| ASF-02 | Medium | Confirmed | ✅ Fixed (direct exits defer to queue) |
| ASF-03 | Deployment Critical | Confirmed | ✅ Fixed (feature-gate + warning) |

---

### ASF-01 — Future-dated purchases can outlive buyer policy keys
**Confirmed.** `buy_insurance` enforced only a *minimum* lead time, so a buyer
could insure a flight further out than the buyer policy key's fixed 180-day TTL
(`PoolKey::Buyer`, written at `add_buyer`, never re-extended). The key could
archive before settlement, making `claim` fail with `no policy` while
`sweep_expired` later moved the unclaimed payoff into `RecoveredBalance` —
a real user-fund-loss path.

**Fix:**
- Added `MAX_BOOK_AHEAD_SECS` (90 days) and enforce `date <= now +
  MAX_BOOK_AHEAD_SECS` in `buy_insurance` (step 3b).
- Reduced `MAX_CLAIM_EXPIRY_WINDOW_SECS` from 180 → 60 days so the full policy
  lifecycle fits inside the buyer-key TTL. (180 days is Stellar's maximum
  persistent TTL, so the key cannot simply be given a longer life, and it is not
  re-extended after purchase.)
- Added a **compile-time invariant**: `MAX_BOOK_AHEAD_SECS +
  MAX_CLAIM_EXPIRY_WINDOW_SECS <= BUYER_KEY_TTL_SECS` (90d + 60d ≤ 180d), so a
  policy bought at the furthest horizon and settled into the longest claim window
  is *guaranteed* to still have a live buyer key at the claim deadline. Future
  tuning of any bound that breaks this fails the build.

This makes claimability an **on-chain guarantee** rather than a dependency on the
off-chain TTL cron.
*Files:* `controller/src/storage.rs`, `controller/src/purchase.rs`.
*Test:* `test_buy_insurance_panics_on_far_future_booking`.

> Note: this complements CertiK VF-12 (traveler-index TTL raised to 180 days) and
> closes the on-chain side of V12-CF-03. Keeping `FlightConfig`/`FlightData`
> alive across a long book-ahead still relies on the off-chain TTL cron + the
> graceful missing-config handling added for CertiK VF-13.

### ASF-02 — Direct withdraw/redeem bypasses the withdrawal queue
**Confirmed.** The vault exposes both a queued exit
(`request_withdrawal → process_withdrawal_queue → collect`) and direct
ERC-4626 `withdraw`/`redeem`, the latter capped only by free capital. After
settlement freed capital, a direct redeemer could consume it ahead of LPs
already waiting in the FIFO queue — defeating the queue's ordering guarantee.

**Fix:** direct `withdraw` and `redeem` now revert when `WithdrawalQueue` is
non-empty (`"withdrawal queue active; use request_withdrawal"`). The queue
becomes the single canonical exit path whenever anyone is waiting; the direct
fast path remains open when the queue is empty (the common, unconstrained case).
*Files:* `risk_vault/src/vault_ops.rs`. *Tests:*
`test_direct_redeem_blocked_while_queue_active`,
`test_direct_redeem_allowed_when_queue_empty`.

### ASF-03 — `mock_usdc` has permissionless minting
**Confirmed.** `mint` and `faucet` let anyone mint arbitrary balances —
acceptable on testnet, catastrophic if `mock_usdc` ever backs a live deployment
of `RiskVault`/`Controller`/`FlightPoolManager`.

**Fix (defense in depth):**
- Permissionless `mint`/`faucet` are now gated behind a **default-on `testnet`
  Cargo feature**. Normal testnet builds keep them; a production build must opt
  out with `--no-default-features`, turning an accidental mainnet deployment of a
  permissionless-mint token into a deliberate act. Verified that
  `cargo build -p mock_usdc --no-default-features` compiles with the entrypoints
  omitted.
- Added a prominent `//!` module-level **TESTNET ONLY** warning documenting the
  risk and that production must use the real USDC Stellar Asset Contract (SAC).

This keeps the original auditors' accepted stance (testnet-only; mainnet uses
real USDC) while adding a build-level guardrail and an explicit in-code warning.
*Files:* `mock_usdc/Cargo.toml`, `mock_usdc/src/lib.rs`.

---

## Files changed
Source (5): `controller/src/{purchase,storage,test}.rs`,
`risk_vault/src/{test,vault_ops}.rs`, `mock_usdc/src/lib.rs`,
`mock_usdc/Cargo.toml`. Plus auto-regenerated `test_snapshots/**` fixtures
(now git-ignored).
