//! RiskVault compile-time constants.

pub(crate) const SECONDS_PER_DAY: u64 = 86400;

/// Minimum age a queued deposit or withdrawal request must reach before
/// processing may price it. LP pricing is two-phase — commit first, price
/// later — because the settlement barrier only engages once the oracle
/// WRITES an outcome on-chain, which is strictly after that outcome becomes
/// publicly knowable: without a delay, an LP who learns a result first could
/// exit before a known loss (or enter before a known gain) at the stale
/// pre-outcome share price, transferring that value from the other LPs.
///
/// Sized to exceed the oracle pipeline's worst-case observation-to-write
/// latency in normal operation (fetcher every 2 h, landed resolution waits
/// ETA + 1 h, plus submission — ≈ 3 h worst case) with margin for one missed
/// fetch cycle. The guarantee this buys has a precise horizon: by the time a
/// request matures, every outcome that was WRITABLE at commitment — i.e.
/// already observable by the oracle, roughly landing time minus this delay —
/// is on-chain: either settled (already in the price) or pending (the
/// barrier holds the request queued until settlement).
///
/// Outcomes that are publicly PREDICTABLE before the oracle can possibly
/// write them are outside that horizon, and the delay cannot close them:
/// the earliest write for a delay outcome is the landing itself, so a
/// departure delay on a flight longer than this constant is knowable to an
/// LP a full flight-duration before the barrier can engage, and a
/// stale-void's premium income is computable arbitrarily far ahead. These
/// pre-write foreknowledge channels are accepted residuals, documented
/// together with the outage residual as the pricing-delay horizon in
/// `spec/architecture.md` — retune this constant only against all of them
/// at once. An extended oracle outage exceeding this delay likewise reopens
/// the window — the pause switch is the incident response, and the
/// executor's fail-closed sale windows stop new exposure in the same outage.
pub(crate) const LP_PRICING_DELAY_SECS: u64 = 6 * 3600;

/// Maximum withdrawal requests examined per
/// `process_withdrawal_queue` call. Bounds the per-call resource cost
/// (preview_redeem + share burn + storage writes) so a large queue can never
/// make maintenance exceed Soroban transaction limits and revert before any
/// entry is drained. The keeper cron calls repeatedly, draining the queue
/// across multiple ledgers. Set high enough that normal volumes drain in one
/// call.
pub(crate) const MAX_QUEUE_BATCH: u32 = 50;

/// Hard cap on the number of pending requests in the single-vector withdrawal
/// queue. Both queues live in the one contract-instance ledger entry, which
/// Soroban bounds to 65,536 bytes (~350 requests in the current layout, at
/// ~186 bytes each); unbounded growth would make that entry unwritable,
/// freezing all queue operations. The two caps together (150 + 100 ≈ 47 KB)
/// keep comfortable headroom for the rest of the instance state. Full
/// resolution (individually-keyed requests + head/tail pointers) is a larger
/// storage migration tracked separately.
pub(crate) const MAX_WITHDRAWAL_QUEUE_LEN: u32 = 150;

/// Hard cap on the pending-deposit queue — see MAX_WITHDRAWAL_QUEUE_LEN for
/// the shared instance-entry budget. Smaller than the withdrawal cap: entry
/// requests drain on every maintenance pass (they are never capital-
/// constrained the way exits are), so depth never accumulates in normal
/// operation.
pub(crate) const MAX_DEPOSIT_QUEUE_LEN: u32 = 100;

/// Cap on how many pending requests one address may hold in the queue at once.
/// A convenience bound on careless or buggy clients, NOT a monopolization
/// defense: shares transfer freely, so any per-address limit is trivially
/// split across sybil addresses. Economic defense of the shared queue
/// capacity comes from the request-value floor (`MIN_REQUEST_FLOOR_DIVISOR`),
/// which prices slots by occupancy regardless of how ownership is spread;
/// the full fix for entry-blocking (individually-keyed requests with no
/// shared cap) is the storage migration tracked at
/// `MAX_WITHDRAWAL_QUEUE_LEN`.
pub(crate) const MAX_ACTIVE_REQUESTS_PER_ADDRESS: u32 = 20;

/// Runtime clamps on the owner-configured minimum request value. With
/// `floor_cap = TMA / MIN_REQUEST_FLOOR_DIVISOR`, the effective floor is
/// `clamp(configured, floor_cap × queue_len / queue_cap, floor_cap)`:
///  - The upper clamp bounds the owner setter by construction — without it,
///    a mistaken or hostile configuration could block queue admission
///    entirely; with it, no configured value can exclude a position above
///    1/2500 (0.04%) of the vault while a slot is free (the occupancy term
///    stays strictly below `floor_cap`, so it never breaks this guarantee).
///  - The occupancy-scaled lower clamp keeps slot squatting expensive even
///    when the configured minimum is low or unset (the default): an empty
///    queue admits any non-dust request, but each further slot prices
///    higher, so pinning the withdrawal queue full escrows ~3% of managed
///    assets (deposit queue ~2%) with the marginal slot at the full 0.04%,
///    no matter what the owner configured.
///
/// Applied at request time (not set time) so the floor self-scales with the
/// vault and can be configured before the first deposit.
pub(crate) const MIN_REQUEST_FLOOR_DIVISOR: i128 = 2500;

/// Absolute lower bound on `floor_cap`, in asset stroops (one whole token at
/// the 7-decimal Stellar asset convention — revisit at wiring time for an
/// asset with different decimals). Both protective floor terms above are
/// value-relative, so at launch or after a severe drawdown (TMA near zero)
/// they degenerate to zero — and the upper clamp then also nullifies any
/// owner-configured minimum, making the bounded queues nearly free to squat
/// during exactly the phase the vault most needs deposits. Flooring
/// `floor_cap` here keeps the occupancy term pricing bootstrap slots and
/// lets a configured minimum bind up to one token, while leaving the
/// documented behavior at scale untouched: an empty queue still admits any
/// non-dust request, and no configuration can exclude a position above
/// `max(TMA/2500, one token)` while a slot is free.
pub(crate) const MIN_REQUEST_FLOOR_CAP_ABS: i128 = 1_0000000;

// Bounds on the controller-pushed solvency ratio. Shared with the
// controller's owner setter via `sentinel_types::solvency`, so the two
// contracts can never hold a value the other would reject: at least nominal
// backing (100%), at most a 100× sanity cap.
pub(crate) use sentinel_types::solvency::{MAX_SOLVENCY_RATIO, MIN_SOLVENCY_RATIO};

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
