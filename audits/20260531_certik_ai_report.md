# Certik: Sentinel Soroban Findings Report

## Assessment Information

|                              |                                        |
| ---------------------------- | -------------------------------------- |
| Project Name                 | Sentinel Protocol                      |
| Network                      | Stellar                                |
| Smart Contract Platform      | Soroban                                |
| Programming Language         | Rust                                   |
| Assessment Date(s)           | 2026-05-31                             |
| Report Version               | v1.0                                   |
| Assessment Status            | Final                                  |
| Assessment Type              | AI-Assisted Internal Security Review   |
| Auditor(s)                   | Certik AI Auditor                      |
| Assessment Platform          | https://aiauditor.certik.com/          |

---

## Repository Information

|                           |                                                             |
| ------------------------- | ----------------------------------------------------------- |
| Repository URL            | https://github.com/SentinelFi/sentinel_soroban_v3/tree/main |
| Repository Visibility     | Public                                                      |
| Branch Name               | main                                                        |
| Git Commit Hash           | 09b32f3c8f9fde657b1b21b8def214af8822b816                  |
| Assessment Snapshot       | Source code state corresponding to the commit hash above    |

---

## Scope

### In Scope

The following files and folders were included in the assessment scope:

- `contracts/controller`
- `contracts/flight_pool_manager`
- `contracts/governance_module`
- `contracts/mock_usdc`
- `contracts/oracle_aggregator`
- `contracts/risk_vault`
- `contracts/sentinel_types`

### Out of Scope

The following files and folders were explicitly excluded from the assessment:

- `contracts/integration_tests`

---

## Summary

| ID | Severity | Title |
| --- | --- | --- |
| VF-01 | High | Unbounded settlement scans can block classification and settlement |
| VF-02 | High | Unbounded withdrawal queue drain can become uncallable |
| VF-03 | High | Pause can expire active insurance claims |
| VF-04 | High | Head-of-line withdrawal request can starve later withdrawals |
| VF-05 | Medium | Approved routes can expire and become unsellable |
| VF-06 | Medium | Oracle active-list pruning is unbounded |
| VF-07 | Medium | Early arrivals are rejected and can leave flights stuck Active |
| VF-08 | Medium | Locked capital does not preserve configured solvency ratio |
| VF-09 | Medium | Vault share pricing can use raw balance instead of managed assets |
| VF-10 | Low | Buyer whitelist entries can silently expire |
| VF-11 | Low | Per-traveler flight index is unbounded |
| VF-12 | Low | Traveler policy index TTL can be shorter than policy lifecycle |
| VF-13 | Low | Archived FlightConfig can make active flights unclassifiable |
| VF-14 | Low | FlightPoolManager active-list pruning is linear inside settlement |
| VF-15 | Low | Missing FlightData is pruned as aged out |
| VF-16 | Low | Partial transfer recovery does not refresh remaining claimable TTL |
| VF-17 | Informational | max_redeem ignores paused state |

## VF-01: Unbounded Settlement Scans Can Block Classification and Settlement

**Severity:** High

**Affected code:**

- `contracts/controller/src/settle.rs::classify_flights`
- `contracts/controller/src/settle.rs::execute_settlements`
- `contracts/oracle_aggregator/src/lib.rs::get_active_flights`

**Issue:**

`classify_flights` and `execute_settlements` both fetch the full oracle `ActiveFlightList` and iterate over every entry in a single transaction. There is no batch size, cursor, checkpoint, or partial-progress mechanism. As the active list grows, these calls can exceed Soroban resource limits and revert. Because progress is not persisted mid-loop, retries start from the same oversized list and can fail repeatedly.

**Impact:**

Flight classification and settlement can become globally unavailable. This can block movement into `ToBeSettled*` states, prevent payouts, prevent collateral unlocks, and stop oracle entries from being marked settled.

**Recommendation:**

Add bounded batch processing with an explicit limit and resumable cursor. Prefer separate queues for classification-ready and settlement-ready flights so each call only touches relevant entries. Remove settled flights from hot-path processing lists as soon as possible, or move retention data to a separate non-hot historical index.

## VF-02: Unbounded Withdrawal Queue Drain Can Become Uncallable

**Severity:** High

**Affected code:**

- `contracts/controller/src/settle.rs::run_queue_maintenance`
- `contracts/risk_vault/src/capital.rs::process_withdrawal_queue`
- `contracts/risk_vault/src/claims.rs::request_withdrawal`

**Issue:**

`run_queue_maintenance` calls `process_withdrawal_queue`, which loads the full withdrawal queue and processes from the head until it reaches the first unserviceable request or the end. Each processed request burns shares, updates claimable balances, extends TTL, emits an event, and rewrites queue state. There is no explicit batch limit.

**Impact:**

A large queue can make maintenance exceed transaction limits and revert before any entries are removed. This can block underwriter withdrawals from progressing.

**Recommendation:**

Introduce a maximum number of requests processed per call and persist progress after bounded work. Consider sharding queue storage or storing requests under per-request keys with a head pointer instead of rewriting a full `Vec`.

## VF-03: Pause Can Expire Active Insurance Claims

**Severity:** High

**Affected code:**

- `contracts/flight_pool_manager/src/claim.rs::claim`
- `contracts/flight_pool_manager/src/claim.rs::sweep_expired`
- `contracts/flight_pool_manager/src/lib.rs::Pausable`

**Issue:**

`claim` is protected by `#[when_not_paused]`, but claim windows are based on ledger timestamp. If the contract is paused while a delayed or cancelled flight is claimable, time continues advancing and travelers cannot claim. Once `claim_expiry` passes, unpausing does not restore access.

**Impact:**

Travelers with valid claims can permanently lose the ability to claim payouts during an emergency pause.

**Recommendation:**

Either allow claims during pause, add a claim-specific pause mode, or extend active claim windows by the duration of a pause. Avoid using global pause to block user withdrawals or claims unless a recovery path exists.

## VF-04: Head-of-Line Withdrawal Request Can Starve Later Withdrawals

**Severity:** High

**Affected code:**

- `contracts/risk_vault/src/capital.rs::process_withdrawal_queue`
- `contracts/risk_vault/src/claims.rs::request_withdrawal`

**Issue:**

`process_withdrawal_queue` breaks when the head request previews to zero assets or exceeds remaining free capital. The zero-asset case is problematic because `request_withdrawal` accepts any positive share amount. A dust request that previews to zero can remain at the queue head and block all later requests.

**Impact:**

Later valid withdrawals can be starved indefinitely by a zero-preview head request.

**Recommendation:**

Reject withdrawal requests whose `preview_redeem(shares)` is zero. During processing, remove or skip zero-preview requests rather than breaking. Keep the `assets > remaining_free` behavior if strict FIFO liquidity ordering is intended.

## VF-05: Approved Routes Can Expire and Become Unsellable

**Severity:** Medium

**Affected code:**

- `contracts/governance_module/src/storage.rs::ROUTE_TTL_LEDGERS`
- `contracts/governance_module/src/lib.rs::route_status`
- `contracts/controller/src/purchase.rs::buy_insurance`

**Issue:**

Approved routes are stored as persistent keys with a 60-day TTL refreshed only on route write operations. `route_status` reads the route but does not refresh its TTL. The provided TTL cron only extends instance storage and explicitly does not handle route keys.

**Impact:**

An intended active route can expire from persistent storage and become unsellable. `buy_insurance` will then reject purchases with `route not whitelisted`.

**Recommendation:**

Extend route TTL on reads or ensure off-chain key-level TTL extension is implemented and monitored. For critical route approvals, consider instance storage or a route registry with enumerability and renewal guarantees.

## VF-06: Oracle Active-List Pruning Is Unbounded

**Severity:** Medium

**Affected code:**

- `contracts/oracle_aggregator/src/lib.rs::prune_settled`

**Issue:**

`prune_settled` loads the full oracle `ActiveFlightList`, performs a persistent lookup for every entry, builds a new `Vec`, and may rewrite the full list. There is no batch size or cursor.

**Impact:**

Cleanup can become uncallable once the list grows too large. If cleanup cannot run, the hot active list remains large, worsening settlement scan costs.

**Recommendation:**

Add bounded pruning with pagination and a cursor. Store settled-retention entries separately from active settlement work queues.

## VF-07: Early Arrivals Are Rejected and Can Leave Flights Stuck Active

**Severity:** Medium

**Affected code:**

- `contracts/oracle_aggregator/src/lib.rs::set_landed`

**Issue:**

`set_landed` rejects `actual_arrival_time < estimated_arrival_time`. Early arrivals are legitimate flight outcomes, but this validation prevents the oracle from marking those flights as landed.

**Impact:**

Legitimate early-arriving flights can remain stuck in `Active`, preventing classification, settlement, collateral release, and final accounting.

**Recommendation:**

Allow actual arrival before estimated arrival. If anti-manipulation checks are needed, validate against flight/departure bounds or trusted oracle data quality rules rather than disallowing early arrival.

## VF-08: Locked Capital Does Not Preserve Configured Solvency Ratio

**Severity:** Medium

**Affected code:**

- `contracts/controller/src/purchase.rs::buy_insurance`
- `contracts/risk_vault/src/capital.rs::increase_locked`
- `contracts/risk_vault/src/queries.rs::get_free_capital`

**Issue:**

`buy_insurance` checks `free_capital >= payoff * solvency_ratio / 100`, but then only locks `payoff`. If the solvency ratio is above 100%, the excess reserve remains free and can be withdrawn or used elsewhere after purchase.

**Impact:**

The configured solvency ratio is enforced only at purchase time and is not preserved as an ongoing reserve. The vault can drift below the intended reserve after underwriter withdrawals.

**Recommendation:**

Lock the full required reserve amount or track required collateral separately from payout exposure. Ensure withdrawal limits use the configured solvency ratio when computing free capital.

## VF-09: Vault Share Pricing Can Use Raw Balance Instead of Managed Assets

**Severity:** Medium

**Affected code:**

- `contracts/risk_vault/src/vault_ops.rs`
- `contracts/risk_vault/src/capital.rs::process_withdrawal_queue`

**Issue:**

The vault tracks `TotalManagedAssets`, but ERC-4626 style conversions delegate to generic `Vault::*` helpers. During processed-but-uncollected withdrawal windows, claimable balances have already reduced `TotalManagedAssets` but the USDC remains in the vault address. If conversion logic uses raw token balance, deposits, mints, redeems, and max-withdraw views can be mispriced.

**Impact:**

Participants can receive unfair share pricing during accounting divergence windows. New entrants may be overcharged, and exiting holders may be able to redeem against non-backing funds.

**Recommendation:**

Make `TotalManagedAssets` the single source of truth for share conversion, previews, deposits, mints, withdrawals, and redemptions. Exclude claimable but uncollected balances from NAV.

## VF-10: Buyer Whitelist Entries Can Silently Expire

**Severity:** Low

**Affected code:**

- `contracts/controller/src/storage.rs::write_buyer_whitelisted`
- `contracts/controller/src/storage.rs::read_buyer_whitelisted`
- `contracts/controller/src/purchase.rs::buy_insurance`

**Issue:**

Buyer whitelist entries are persistent keys with a 60-day TTL. Reads return `false` for missing keys, so an expired approval is indistinguishable from a removed or never-approved buyer.

**Impact:**

Previously approved buyers can be locked out of purchases when whitelist mode is enabled.

**Recommendation:**

Refresh whitelist entry TTLs through key-level TTL maintenance, use durable/instance storage where practical, or expose an explicit renewal flow. Consider returning a distinct expired/missing status for observability.

## VF-11: Per-Traveler Flight Index Is Unbounded

**Severity:** Low

**Affected code:**

- `contracts/controller/src/storage.rs::append_traveler_flight`
- `contracts/controller/src/queries.rs::get_flights_for_traveler`

**Issue:**

All policies for a traveler are stored in a single persistent `Vec<(Symbol, u64)>`. Every purchase reads, appends to, and rewrites the full vector. Queries return the full vector.

**Impact:**

A frequent traveler can eventually become unable to buy more policies, and their flight index query can become too expensive or too large to return.

**Recommendation:**

Store traveler policy entries under per-index keys with a counter, or shard the vector. Add paginated reads and explicit per-page limits.

## VF-12: Traveler Policy Index TTL Can Be Shorter Than Policy Lifecycle

**Severity:** Low

**Affected code:**

- `contracts/controller/src/storage.rs::TRAVELER_FLIGHTS_TTL_LEDGERS`
- `contracts/controller/src/storage.rs::append_traveler_flight`

**Issue:**

`TravelerFlights` entries receive a 60-day TTL on append. Policies and claim windows can last longer than that, especially with future-dated purchases and claim expiry windows up to 180 days.

**Impact:**

The frontend or user tooling can lose discoverability of an active or claimable policy even though the policy still exists in `FlightPoolManager`.

**Recommendation:**

Extend the traveler index TTL to cover the maximum policy lifecycle plus buffer, or refresh these keys through off-chain key-level TTL maintenance. Prefer deriving policy state from canonical per-policy storage with pagination.

## VF-13: Archived FlightConfig Can Make Active Flights Unclassifiable

**Severity:** Low

**Affected code:**

- `contracts/flight_pool_manager/src/queries.rs::get_flight_config`
- `contracts/controller/src/settle.rs::classify_flights`
- `contracts/controller/src/settle.rs::execute_settlements`

**Issue:**

`get_flight_config` returns `None` when the persistent `FlightConfig` key is missing or archived. Controller settlement paths expect the config to exist and panic if it does not.

**Impact:**

If `FlightConfig` expires while oracle flight data remains active, classification or settlement can revert for that flight and potentially block broader unbounded loops.

**Recommendation:**

Align TTLs across `FlightConfig`, oracle `FlightData`, buyer keys, and claim windows. Add explicit handling for missing pool config so one inconsistent flight cannot block processing of all other flights.

## VF-14: FlightPoolManager Active-List Pruning Is Linear Inside Settlement

**Severity:** Low

**Affected code:**

- `contracts/flight_pool_manager/src/storage.rs::prune_active_list`
- `contracts/flight_pool_manager/src/settle.rs`

**Issue:**

`prune_active_list` linearly scans `ActiveFlightList`, removes one entry, shifts the vector tail, and rewrites the list. This is called during settlement. When multiple flights are settled in one controller call, repeated linear removals can compound.

**Impact:**

Settlement costs grow with the size of the pool active list and the number of flights settled in the transaction.

**Recommendation:**

Use an indexed set pattern, swap-remove with an index map, or per-flight active flags plus paginated cleanup. Avoid repeated full-vector mutation inside settlement loops.

## VF-15: Missing FlightData Is Pruned as Aged Out

**Severity:** Low

**Affected code:**

- `contracts/oracle_aggregator/src/lib.rs::prune_settled`

**Issue:**

`prune_settled` treats missing `FlightData` as `aged_out = true` and removes the corresponding tuple from `ActiveFlightList`, even if the flight was not known to be settled.

**Impact:**

If active, landed, cancelled, or settlement-ready `FlightData` archives unexpectedly, pruning can remove the flight from the only active index used by classification and settlement.

**Recommendation:**

Only prune entries with explicit `Settled` status and sufficient retention age. Emit a diagnostic event for missing data instead of deleting it, or move missing entries to a recovery queue.

## VF-16: Partial Transfer Recovery Does Not Refresh Remaining Claimable TTL

**Severity:** Low

**Affected code:**

- `contracts/risk_vault/src/claims.rs::recover_uncollected`

**Issue:**

In `RecoveryMode::Transfer`, a partial transfer rewrites the remaining `ClaimableBalance` but does not extend that persistent key's TTL.

**Impact:**

The remaining claimable balance can retain a near-expiry TTL and archive again sooner than intended.

**Recommendation:**

Whenever a nonzero remaining claimable balance is written, call `extend_ttl` with `CLAIMABLE_TTL_LEDGERS`.

## VF-17: max_redeem Ignores Paused State

**Severity:** Informational

**Affected code:**

- `contracts/risk_vault/src/vault_ops.rs::redeem`
- `contracts/risk_vault/src/vault_ops.rs::max_redeem`

**Issue:**

`redeem` is guarded by `#[when_not_paused]`, but `max_redeem` can still return a positive amount while the vault is paused.

**Impact:**

Integrations may believe redemption is available and submit transactions that revert during pause.

**Recommendation:**

Return zero from `max_redeem` while paused, matching executable redemption behavior.

## Limitations

This assessment represents a point-in-time review of the specific repository state. The assessment does not guarantee the absence of vulnerabilities, defects, design weaknesses, implementation errors, or economic risks.

## Disclaimer

No representation, warranty, or guarantee is made regarding the completeness, accuracy, reliability, suitability, or correctness of the assessment results. The absence of reported findings does not imply the absence of vulnerabilities, defects, security weaknesses, or exploitable conditions. This assessment should not be relied upon as the sole basis for security, investment, deployment, governance, operational, or business decisions.

The assessment does not constitute:

- A formal security certification
- A guarantee of security
- Legal advice
- Financial advice
- Investment advice
- Compliance certification
- A substitute for professional security auditing services

Neither the assessment provider, report author(s), AI systems used during analysis, nor any affiliated parties shall be liable for any direct, indirect, incidental, consequential, special, or punitive damages arising from the use of this report or reliance on its contents.
