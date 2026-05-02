# Improvements

> Deferred improvements to revisit after the core protocol is complete and validated.

---

## 1. Dynamic Premium Pricing

Premium may increase based on demand — e.g. how many policies are bought for a specific airport, flight, or route. Not implemented yet; current premiums are static per-route via GovernanceModule.

## 2. AI Agent for Route Whitelisting & Pricing

An AI agent will handle whitelisting routes and calculating starting premium/payoff values, replacing manual admin configuration.

## 3. Unlocked Vault — Stop Yield on Claim/Withdraw

Currently, underwriter shares continue generating yield even after a claim or withdrawal is initiated. May need an unlocked vault variant where hitting claim or withdraw stops yield accrual for that position.

## 4. MockUSDC Faucet UI

Build a simple frontend faucet for MockUSDC so testnet users can self-serve tokens without needing admin CLI access.

## 5. OracleAggregator: ActiveFlightList Grows Unbounded

**Problem:** `ActiveFlightList` is a single `Vec<(Symbol, u64)>` that every purchased flight is appended to, but flights are **never removed** — even after settlement. Individual `FlightData` entries self-clean via TTL (settled flights stop renewing TTL and expire in ~7–31 days), but the list itself keeps growing because its TTL is renewed on every new registration. The executor's `FlightDataFetcher` iterates the full list every 2 hours, reading each entry's `FlightData` only to skip settled/expired ones.

**Fix options (pick one):**

1. **Prune on settlement:** Remove the entry from the vector inside `set_settled()`. Simple but O(n) per settlement (scan + shift).

2. **Sweep function:** Add an admin/keeper-callable `sweep_active_list()` that removes all `Settled` entries in one batch. Amortizes the cost.

3. **Per-status lists:** Maintain separate vectors per `FlightStatus`. Move entries between lists on each transition. Executor crons only read the list they care about (O(1) lookup by status). More storage keys; requires read-modify-write on two lists per transition.

4. **Indexed map:** Store a `Map<(Symbol, u64), FlightStatus>` as a secondary index. Filter by iterating the map. Still O(n) but cheaper than reading full `FlightData` per entry.

Current approach is adequate for expected volume (hundreds of concurrent flights). Option 2 (sweep function) is the simplest near-term fix; migrate to per-status lists (option 3) if performance becomes an issue.

## 6. FlightPool: Restrict `sweep_expired` to Authorized Keeper

Currently `sweep_expired()` can be called by anyone. In a future iteration, restrict this to an authorized keeper/cron address (similar to the Controller's `AuthorizedKeeper`). This prevents griefing and ensures sweeps happen on schedule.

## 7. FlightPool: RecoveryPool Balance Tracking on Sweep

Currently `sweep_expired()` does a direct USDC transfer to RecoveryPool. This means RecoveryPool's per-source balance tracking (via `receive()`) is not updated. Consider either:
- Adding a `record_deposit()` function to RecoveryPool that doesn't do the transfer (just records the balance)
- Having the Controller orchestrate the sweep so it can call both FlightPool.sweep_expired() and RecoveryPool.receive() in sequence with proper auth

## 8. Automated Browser E2E Tests (Playwright + Freighter Mock)

Set up Playwright-based E2E tests for the frontend dApp running against testnet-deployed contracts. Requires building a custom Freighter wallet mock (no off-the-shelf solution exists in the Stellar ecosystem) that injects a fake `window.freighter` with a testnet keypair for headless signing. Run on a cron schedule (e.g. GitHub Actions `schedule`) to catch regressions. Key pieces: wallet mock shim, Friendbot account funding, testnet contract deployment, and failure notifications.

## 9. Oracle Data Auditability (C2 — Event-Emitted Data Hash)

Add a SHA-256 hash of the raw AeroAPI response to each `FlightStatusChange` event emitted by OracleAggregator. Executor hashes the raw JSON before each oracle write; anyone can independently call AeroAPI for the same flight/date and verify the hash matches. Requires minor contract change (new `data_hash: BytesN<32>` event field) and executor change (hash computation). Also includes a new `/audit` frontend page that polls Soroban RPC `getEvents()` to display all oracle state transitions with data hashes.

See [improvement_details/oracle-data-hash.md](improvement_details/oracle-data-hash.md) for full implementation plan.

## 10. NEAR Chain Signatures for Decentralized Oracle Execution

Replace the centralized cron executor with a NEAR-based agent that signs Stellar transactions via MPC. NEAR's Chain Signatures added EdDSA support (April 2025), enabling direct Stellar transaction signing without holding a private key. The MPC-derived Stellar `G...` address is set as `authorized_oracle` on OracleAggregator via a single owner transaction — zero contract redeployment.

See [improvement_details/near-chain-signatures.md](improvement_details/near-chain-signatures.md) for architecture details and comparison with Hedera HCS, Chainlink CRE, EigenLayer, and Phala.

## 11. Auditable AI Agent Decisions (Route Whitelisting)

When an AI agent handles route whitelisting (#2), its decisions need an audit trail. Options researched: Hedera HCS ($0.0001/message, purpose-built agent audit log), NEAR Chain Signatures (agent executes on Stellar via MPC, auditable on NEAR chain), Phala TEE (hardware attestation of agent code execution). Recommended hybrid: NEAR for execution + Hedera HCS for reasoning logs.

See [improvement_details/auditable-ai-agents.md](improvement_details/auditable-ai-agents.md) for full platform comparison.

## 12. ~~Wire Claim Payoff Button (Frontend)~~ (DONE)

The "Claim Payoff" button on the My Policies page is now wired to `FlightPool.claim(traveler)`. A dynamic client (`frontend/src/contracts/flight_pool.ts`) builds an unsigned transaction for the specific pool address, signs via the wallet, and submits. Previously stubbed with `setTimeout(1.5s)`.

## 13. Automated Browser E2E Test Suite (Playwright + Wallet Mock)

E2E test infrastructure created in `e2e/` using [stellar-wallet-mock](https://github.com/SentinelFi/stellar_wallet_mock) and Playwright. Covers landing page, wallet connection, admin operations, insurance purchase, policy tracking, flight markets, and vault deposit/withdrawal. Tests run against testnet-deployed contracts with a mock Freighter wallet (no browser extension needed). See `e2e/README.md` for setup and `e2e/tests/` for test suites. Remaining work: CI/CD integration (GitHub Actions), full lifecycle test with oracle state transitions, and wiring the claim payoff button (#12).

## 14. `buy_insurance` writeBytes Pressure — Instance Storage Root Cause

**Problem:** `buy_insurance` touches 6 contracts (Controller, FlightPool, OracleAggregator, RiskVault, USDC Token, Governance). The combined writeBytes footprint (~134 KB) pushes against the Soroban network limit (~132 KB), causing transaction failures even with only a handful of existing flights.

**Root cause — instance storage pulls WASM into the readWrite footprint:**

Soroban has three storage types with different footprint behavior:

| Storage | TTL | Footprint effect on write |
|---------|-----|--------------------------|
| **Instance** | Shared with contract WASM code entry | Any instance write → WASM included in `readWrite` footprint → WASM size counted toward 132 KB `writeBytes` limit |
| **Persistent** | Independent per-key | Writes do **not** pull WASM into footprint |
| **Temporary** | Auto-deleted on expiry | Cheapest, no TTL renewal needed |

When a contract writes to instance storage (or calls `extend_instance_ttl()`), Soroban includes the contract's WASM code entry in the transaction's `readWrite` footprint. The WASM bytes then count toward the 132 KB `writeBytes` limit — even though the WASM itself isn't changing.

**Actual byte breakdown** (from `debug_footprint.ts` on a `buy_insurance` transaction):

| Source | Size | % of 132 KB limit | Cause |
|--------|------|-------------------|-------|
| RiskVault WASM | ~64 KB | 48.5% | `LockedCapital` + `TotalManagedAssets` stored in instance |
| MockUSDC WASM | ~48 KB | 36.1% | Token transfer triggers instance write (testnet only — disappears with real USDC) |
| OracleAggregator WASM | ~16 KB | 12.3% | Unnecessary `extend_instance_ttl()` calls in write functions |
| Actual data | ~4.6 KB | 3.1% | Flight data, policy records, balances |

**Current band-aid:** The executor's `SorobanClient` bumps simulated resource limits by 40% (instructions, readBytes, writeBytes, resourceFee). This costs more XLM per transaction and will hit the hard ceiling as state grows.

**Storage audit — keys that should migrate from instance → persistent:**

- **Controller:** `TotalPoliciesSold`, `TotalPremiumsCollected`, `TotalPayoutsDistributed` — counters updated on every purchase/settlement, pulling ~25 KB Controller WASM into footprint
- **RiskVault:** `LockedCapital`, `TotalManagedAssets` — updated on every lock/unlock, pulling ~64 KB RiskVault WASM into footprint

**Fix phases:**

1. ~~**OracleAggregator:** Remove `extend_instance_ttl()` from write functions~~ — **DONE** (this PR, saves ~16 KB)
2. **Controller:** Move 3 counter keys to persistent storage (~25 KB saved)
3. **RiskVault:** Move `LockedCapital` + `TotalManagedAssets` to persistent storage (~64 KB saved)
4. ~~**All contracts:** Add public `extend_ttl()` functions + daily TTL extender cron job~~ — **DONE** (`extend_ttl()` on all 5 long-lived contracts + `ttl_extender.ts` cron)
5. **Executor:** Reduce resource bump from 40% to ~10% once instance writes are eliminated
