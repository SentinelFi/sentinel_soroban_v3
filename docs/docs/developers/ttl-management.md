---
sidebar_position: 5
title: Storage TTL
---

# Storage TTL

Soroban storage is rented, not permanent. Every ledger entry has a time to live (TTL), measured in ledgers, and an entry whose TTL runs out is archived (persistent and instance storage) or deleted (temporary storage). Keeping data alive requires periodically extending its TTL and paying rent.

Sentinel treats this as a first-class operational concern.

## What must stay alive

Persistent entries that hold user-facing state:

- Flight configurations and buyer records in the Flight Pool Manager.
- Flight data in the Oracle Aggregator.
- Claimable and withdrawal balances.
- Per-traveler flight indexes in the Controller.
- Whitelisted routes in the Governance Module.

TTL constants are centralized in the `sentinel_types` crate, so all contracts use consistent lifetimes.

## How TTLs are extended

1. **On write.** Contracts extend an entry's TTL whenever they touch it, so actively used data keeps itself alive.
2. **Scheduled cron.** The executor's TTL extender job periodically calls each contract's permissionless `extend_ttl` entry point (instance-storage renewal, a safety net) and the oracle's `prune_settled` (daily by default, the schedule is configurable). It can be signed by any funded key, no protocol role required. Key-level `ExtendFootprintTTLOp` extension of individual flight, claim, traveler index, and route entries is a planned improvement, not part of this cron yet.
3. **Permissionless.** TTL extension entry points are callable by anyone, so third parties can keep data alive independently of the executor.

## Keeping storage bounded

- Settled flight data is pruned after a 7 day retention period via the permissionless `prune_settled` function.
- Share price snapshots use temporary storage with a 30 day TTL and expire on their own.
- Expired unclaimed payouts are swept into a recovery balance, so per-flight claim entries do not need to live forever.

## If an entry archives anyway

Archived persistent entries are not lost: on current protocol versions an archived entry named in a transaction's footprint is restored with its original value before the contract executes (or the transaction fails up front), so contract logic never mistakes an archived entry for a missing one. The cost of a lapse is operational — restoration rent and, for transactions built outside the normal simulation flow, an extra step — never silent state loss. For claimable balances that were archived before collection, the Risk Vault owner additionally has a `recover_uncollected` path that re-credits the user or transfers the funds out. Operationally, a regular extender cadence is designed to make restoration a rare edge case rather than a normal event.

Because restoration brings values back verbatim, nothing in the protocol uses a storage TTL as a business deadline. Where lifetime matters semantically — the buyer-whitelist approvals with their 180-day inactivity window — the deadline is an explicit timestamp the contract compares against the ledger clock, so it holds whether or not the entry ever archived.
