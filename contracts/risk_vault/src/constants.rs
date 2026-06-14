//! RiskVault compile-time constants.

pub(crate) const SECONDS_PER_DAY: u64 = 86400;

/// Maximum withdrawal requests examined per
/// `process_withdrawal_queue` call. Bounds the per-call resource cost
/// (preview_redeem + share burn + storage writes) so a large queue can never
/// make maintenance exceed Soroban transaction limits and revert before any
/// entry is drained. The keeper cron calls repeatedly, draining the queue
/// across multiple ledgers. Set high enough that normal volumes drain in one
/// call.
pub(crate) const MAX_QUEUE_BATCH: u32 = 50;

/// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800.
/// Applied on every `ClaimableBalance(addr)` write to prevent silent archival
/// of per-user pending asset. Layered defense:
/// 1. On-write extension (this constant).
/// 2. Off-chain TTL cron footprint extension via the indexer.
/// 3. `recover_uncollected` owner manual fallback.
pub(crate) const CLAIMABLE_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;

/// 30 days at 5s/ledger = 30 * 24 * 60 * 12 = 518_400.
/// Applied on every `SnapshotPrice(day)` Temporary write. Snapshots are
/// short-lived — recent ones queryable on-chain; older entries auto-delete
/// with no archival rent. Historical analytics happen off-chain via events.
pub(crate) const SNAPSHOT_TTL_LEDGERS: u32 = 30 * 24 * 60 * 12;
