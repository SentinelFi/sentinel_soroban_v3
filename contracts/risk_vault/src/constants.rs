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

/// Hard cap on the number of pending requests in the single-vector withdrawal
/// queue. The queue shares one contract-instance ledger entry, which Soroban
/// bounds to 65,536 bytes (~385 requests in the current layout); an unbounded
/// queue could grow until that entry becomes unwritable, freezing all queue
/// operations. Capping length below the limit turns that ungraceful failure
/// into a clean, early rejection with headroom for other instance state. Full
/// resolution (individually-keyed requests + head/tail pointers) is a larger
/// storage migration tracked separately.
pub(crate) const MAX_WITHDRAWAL_QUEUE_LEN: u32 = 250;

/// Cap on how many pending requests one address may hold in the queue at once.
/// Prevents a single underwriter from monopolizing the shared queue capacity
/// and starving other underwriters' exits.
pub(crate) const MAX_ACTIVE_REQUESTS_PER_ADDRESS: u32 = 20;

/// Runtime clamp on the owner-configured minimum withdrawal-request value:
/// the effective floor is `min(configured, TMA / MIN_REQUEST_FLOOR_DIVISOR)`.
/// Owner setters are bounded by convention — without the clamp, a mistaken or
/// hostile configuration could block queue admission entirely. With it, no
/// configured value can exclude a position above 1/2500 (0.04%) of the vault,
/// while slot occupation stays expensive: filling all
/// `MAX_WITHDRAWAL_QUEUE_LEN` slots at the clamped floor still escrows
/// ~10% of managed assets. Applied at request time (not set time) so the
/// floor self-scales with the vault and can be configured before the first
/// deposit.
pub(crate) const MIN_REQUEST_FLOOR_DIVISOR: i128 = 2500;

/// Bounds on the controller-pushed solvency ratio, mirroring the controller's
/// own owner-setter bounds so the two contracts can never hold a value the
/// other would reject: at least nominal backing (100%), at most a 100×
/// sanity cap.
pub(crate) const MIN_SOLVENCY_RATIO: u32 = 100;
pub(crate) const MAX_SOLVENCY_RATIO: u32 = 10_000;

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
