# Soroban Storage — Why We Make The Changes We Make

This document explains the Soroban storage model and the reasoning behind every change in `improvements.md`. Read this to understand the "why" — then use `improvements.md` for the "what".

---

## Soroban Storage Tiers

Soroban has three storage tiers. Choosing the wrong one causes bugs — not performance issues, but actual fund-trapping, contract-bricking bugs.

### Instance Storage

- Tied to the contract instance itself. All Instance entries share one TTL — they live and die together.
- When the instance TTL expires, the **entire contract** archives. Every Instance entry goes with it.
- Extending any Instance entry's TTL extends them all.
- **Use for:** global config, shared state that all users depend on, anything that must be alive whenever the contract is alive.
- **Our usage:** Owner addresses, contract references (Controller, UsdcToken, RiskVault), WithdrawalQueue, ActiveFlightList, routes, RecoveredBalance.

### Persistent Storage

- Independent TTL per entry. Each entry can archive at different times.
- Archived entries are **not deleted** — they move to cold storage and can be restored via `RestoreFootprintOp`.
- **Use for:** per-user data, per-entity data that grows unboundedly, anything that shouldn't bloat Instance.
- **Our usage:** FlightConfig per flight, Buyer/Claimed per buyer, ClaimableBalance per underwriter, FlightData per flight, TravelerFlights per traveler.

### Temporary Storage

- Like Persistent, but archived entries **are permanently deleted**. No restore possible.
- Cheapest — no archival rent.
- **Use for:** disposable data with a natural expiry. Data you'd never pay to restore.
- **Our usage:** SnapshotPrice (daily share price — historical, informational, never needed for business logic).

---

## The 7 Guiding Principles

These come from Soroban best practices and govern every decision:

1. **Prefer Temporary over Persistent and Instance.** Anything with a natural timeout should be Temporary with TTL set to the timeout.

2. **All global/shared state that cannot be Temporary should be in Instance storage.** This guarantees the contract instance and all relevant globals are tied together — they live and die as one.

3. **TTL extensions should never be relied on for functionality or safety.** You must assume any entry's TTL can reach 0. Design contracts so that TTL expiry degrades gracefully rather than bricking the contract or trapping funds.

4. **TTL exhaustion should never be relied on for functionality or safety.** `ExtendFootprintTTLOp` is permissionless — anyone can extend any entry's TTL without authorization. Never use TTL as a timer or expiry mechanism.

5. **Owned contracts: owners should subsidize shared-state TTL via `ExtendFootprintTTLOp` cron.** This is a raw Soroban operation, not an in-contract function call. No contract code needed.

6. **Autonomous contracts: extend TTL of shared state touched by each invocation.** Since there's no owner to subsidize, callers must pay.

7. **Account-specific state: wallets/dApps should present TTL info and suggest extensions.** Per-user entries are the user's responsibility.

---

## Key Insight: Owner-Operated Protocol

Our protocol is **owner-operated** (the deployer controls governance, crons, keeper). The Soroban docs say the owner should use `ExtendFootprintTTLOp` via cron — not in-contract `extend_ttl()` functions. However, **Principle 3 is the critical one**: TTL extension is a convenience, not a safety mechanism. The contract must not brick or trap funds if TTL expires despite best efforts.

---

## `RestoreFootprintOp` — The Universal Safety Net

Instance and Persistent storage entries are **never permanently deleted** on Soroban. When their TTL expires they are "archived" — moved to cold storage. Archived entries can always be restored via `RestoreFootprintOp` (a raw Soroban operation, no contract call needed). This means:

- A "bricked" contract can be unbricked by submitting `RestoreFootprintOp` for its instance storage, then `ExtendFootprintTTLOp` to keep it alive
- Archived persistent entries (routes, flight data, balances) can be restored the same way
- Only **Temporary** storage is truly permanent deletion

This changes the severity framing: most issues are "temporarily inaccessible until restored" rather than "permanently lost." However, restoration requires the operator to **notice** the archival and **know** which entries to restore — which is why prevention (TTL management) and detection (graceful error handling + events) are both important.

### ⚠️ What contract code actually observes for an archived entry

Several places in this document (and defensive branches in the contracts) describe an archived Persistent entry as "reads back as missing" inside contract execution — `get() → None`, `has() → false`. **That is not guaranteed by the platform and must not be relied on.** What actually happens to a transaction that touches an expired Persistent key depends on the protocol version:

- **Fail-until-restored semantics:** the transaction fails at the footprint level (the entry is archived) until a `RestoreFootprintOp` brings it back — contract code never runs against the missing key.
- **Automatic-restoration semantics (newer protocols):** the entry is restored automatically when accessed, at additional fee, with its **original value** — contract code sees the old data, not `None`.

In **neither** regime does a once-written key read as absent. The `unwrap_or(...)` / `has()` fallbacks in the contracts therefore fire only for keys that were **never written** — they are defense-in-depth for genuinely-unregistered lookups, not archival handling. (The SDK test environment panics on expired-entry access, so these branches cannot be exercised by unit tests either.) Operational consequences:

- Diagnostic/recovery paths keyed on "missing = archived" (`data_missing` retention, `cfg_missing` skips, `evict_missing_flight`, `has_flight_data`) act on *physically absent* entries; for genuinely archived entries the recovery tool is restoration, driven off-chain.
- The executor must handle restore preambles (`restorePreamble` from transaction simulation) on keeper transactions so an archived entry in a scan window is restored rather than repeatedly failing the keeper call.
- Before mainnet, confirm the target protocol's exact behavior with a deliberately-expired Persistent entry on testnet, and align runbooks with the result.

---

## OZ Crate Storage (Already Correct)

The OpenZeppelin Stellar crates used by RiskVault handle their own storage correctly:
- **Token balances** -> Persistent with TTL extension on access
- **Allowances** -> Temporary (time-bound by design)
- **Token metadata** (name, symbol, decimals) -> Instance
- **Vault config** (asset address, decimals offset) -> Instance
- **Owner address** -> Instance

These follow best practices and are not touched by our changes.

---

## Why Each Change Is Necessary

### Why FlightPool becomes FlightPoolManager (Improvement #1)

The old design deploys a separate FlightPool contract per `(flight_id, date)` via `env.deployer()`. Each pool is an independent contract with its own instance storage, token balance, and TTL lifecycle. This causes four problems:

1. **Per-pool instance TTL expiry.** Each pool's instance storage can independently archive if no one interacts with it for ~60 days. The existing TTL cron has no mechanism to keep individual pools alive. On testnet, all 3 active pools are currently bricked because of this.

2. **Controller ActiveFlight mapping expiry.** The Controller stores `ActiveFlight(Symbol, u64) -> Address` in Persistent storage to find each pool. These entries expire independently — one expired entry crashes the entire settlement batch via `.unwrap()` panic.

3. **Deployment complexity.** Controller must store a `FlightPoolWasm` hash, manage deterministic salts, and deploy new contracts on first purchase.

4. **writeBytes pressure.** Each FlightPool's WASM (~16-25 KB) is pulled into the transaction footprint on instance writes, contributing to the 132 KB limit.

A single FlightPoolManager with keyed Persistent storage eliminates all four. Global config lives in Instance (kept alive by cron). Per-flight data lives in Persistent (extended by `ExtendFootprintTTLOp` cron). No separate contracts to archive.

**Tradeoff:** All flight USDC in one contract — a bug affects all flights. Accepted because the alternative (N independently-archivable contracts) is provably broken.

### Why RecoveryPool is deleted (part of #1)

RecoveryPool was a simple custody contract for expired unclaimed payouts. With FlightPoolManager, `sweep_expired()` credits an internal `RecoveredBalance` counter in Instance storage. Owner calls `withdraw_recovered()`. No cross-contract transfer, no separate contract TTL to manage.

### Why WithdrawalQueue moves to Instance (Improvement #2)

`WithdrawalQueue` is a global Vec — all users' withdrawal requests live in one list. It was in Persistent storage with **no TTL extension**. If the entry archives before `process_withdrawal_queue` runs:
1. Next read returns `unwrap_or(Vec::new(e))` — empty Vec
2. Escrowed shares are stuck with no on-chain record of ownership
3. Users cannot cancel (queue appears empty)

**Violates Principle 2:** global shared state must be Instance. Moving it to Instance means the existing cron `extend_ttl()` keeps it alive automatically.

The queue was originally placed in Persistent to avoid bloating the Instance entry — an optimization concern that trades correctness for efficiency. The queue is processed daily and rarely has more than a handful of entries.

### Why ClaimableBalance needs TTL extension + recovery (Improvement #3)

When `process_withdrawal_queue` processes a request, it credits `ClaimableBalance(address)` in Persistent storage with **no TTL extension**. The entry gets network-minimum TTL (days). If the user doesn't call `collect()` in time, `collect()` returns 0 and the USDC is stuck.

This is **account-specific state** — Persistent is the correct tier (not global, so Principle 2 doesn't apply). But it needs TTL extension (60 days) and an owner recovery fallback.

**Why not push-based (direct transfer)?** If any recipient address is a contract that rejects incoming tokens, the entire `process_withdrawal_queue` transaction reverts — blocking all other users' withdrawals in the same batch. Soroban has no try/catch to isolate individual transfer failures within a loop. Pull-based avoids this.

### Why Governance routes move to Instance (Improvement #4)

Routes and RouteList are in Persistent storage with **no TTL extension**. A route whitelisted today can archive within days. The next `buy_insurance` call panics with "route not found" — identical error to "route was never whitelisted," so the operator can't distinguish the two.

**Routes are global shared state.** All protocol users depend on them. Per Principle 2, they belong in Instance. Route count is expected to stay under ~50 — Instance is practical.

### Why Oracle ActiveFlightList needs pruning + Instance (Improvement #5)

The Oracle's `ActiveFlightList` is appended to in `register_flight` but **never pruned**. Settled flights stay forever. Over time, `get_flights_by_status()` iterates an ever-growing list (unbounded gas cost).

Additionally, the list is only TTL-extended in `register_flight`. If no new flights are registered for ~31 days, the list archives. On next read, `unwrap_or(Vec::new(e))` returns empty — silently skipping all pending flights.

**Per Principle 2**, this is global shared state. But without pruning, unbounded growth makes Instance impractical. Fix: prune in `set_settled`, then move to Instance where the cron keeps it alive.

### Why Oracle FlightData needs TTL cron (Improvement #6)

`FlightData(Symbol, u64)` gets TTL ~31 days on each oracle write. If no updates for 31+ days, the entry archives. `get_flight_data` returns `NotInitiated` default — the Controller silently skips the flight forever.

This is per-flight shared state — Persistent is the correct tier. The fix is `ExtendFootprintTTLOp` via cron (same pass that extends FlightPoolManager's FlightConfig entries) plus detection logic in the Controller.

### Why SnapshotPrice becomes Temporary (Improvement #7)

`SnapshotPrice(u64)` stores daily share price snapshots — historical, informational, append-only. No business logic depends on restoring archived snapshots. Currently Persistent, meaning archived snapshots incur archival rent indefinitely for data that will never be restored.

**Per Principle 1:** anything with a natural timeout should be Temporary. Snapshots are disposable. Switch to Temporary with 30-day TTL — old snapshots are permanently deleted (no archival rent). Historical data lives off-chain via event indexing.

### Why we add TravelerFlights (Improvement #8)

The `/policies` page calls `Controller.get_active_pools()` which returns **all** active flights across the entire protocol. Every user sees every policy.

There is no per-user index. FlightPoolManager has `has_policy(flight_id, date, traveler)` but calling it per-flight from the frontend requires N RPC calls. Adding `TravelerFlights(Address) -> Vec<(Symbol, u64)>` in the Controller gives the frontend a single-call query.

---

## `ExtendFootprintTTLOp` — How It Works

`ExtendFootprintTTLOp` is a raw Soroban operation (not an in-contract function call). It extends the TTL of specific storage entries without invoking any contract code. Key properties:

- **Permissionless** — anyone can extend any entry's TTL. No authorization needed.
- **Batched** — one transaction can extend many entries across multiple contracts.
- **Off-chain** — submitted as a regular Stellar transaction by the cron/operator.
- **No contract code needed** — the contract doesn't need an `extend_ttl()` function for this to work.

Our TTL cron (Cron #4) uses this to extend per-flight Persistent entries:
1. Read `FlightPoolManager.get_active_flights()` for all `(flight_id, date)` tuples
2. Build one `ExtendFootprintTTLOp` covering `FlightConfig` entries + `FlightData` entries
3. Submit

This is the pattern recommended by Soroban docs for owner-operated protocols (Principle 5).
