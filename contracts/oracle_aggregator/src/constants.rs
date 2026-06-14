//! OracleAggregator compile-time constants.

/// Maximum active-list entries inspected per `prune_settled` call.
/// Bounds the expensive per-entry persistent lookups so pruning cannot become
/// uncallable as the list grows. Each call advances a rotating cursor, so
/// repeated calls eventually sweep the whole list.
pub(crate) const MAX_PRUNE_BATCH: u32 = 100;

pub(crate) const PERSISTENT_TTL_THRESHOLD: u32 = 120_960; // ~7 days
pub(crate) const PERSISTENT_TTL_EXTEND: u32 = 535_680; // ~31 days

// Settled flights stay in `ActiveFlightList` for SETTLED_RETENTION_DAYS after
// `set_settled` records their `settled_at` timestamp. Pruning is delegated to
// the permissionless `prune_settled` entry — keeps freshly-settled flights
// visible to off-chain monitoring / indexers / observability tooling for the
// retention window before they disappear from the list.
pub(crate) const SETTLED_RETENTION_DAYS: u64 = 30;
pub(crate) const SECONDS_PER_DAY: u64 = 86_400;
