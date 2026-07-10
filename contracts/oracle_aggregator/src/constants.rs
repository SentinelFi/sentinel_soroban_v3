//! OracleAggregator compile-time constants.

/// Maximum active-list entries inspected per `prune_settled` call.
/// Bounds the expensive per-entry persistent lookups so pruning cannot become
/// uncallable as the list grows. Each call advances a rotating cursor, so
/// repeated calls eventually sweep the whole list.
///
/// A 100-entry inspection window required ~103
/// footprint ledger entries once the fixed contract-instance/invocation entries
/// were added, exceeding Soroban's 100-entry transaction footprint limit and
/// reverting before any state change. 60 leaves comfortable headroom (the
/// rotating cursor still sweeps the full list across repeated calls).
pub(crate) const MAX_PRUNE_BATCH: u32 = 60;

/// Hard cap on `ActiveFlightList` length. The list is a single `Vec` in the
/// contract-instance entry, which Soroban bounds to 65,536 bytes (~1,600
/// entries in the current layout). An unbounded list could grow until that
/// entry becomes unwritable, freezing registration and the instance-state
/// writes that piggyback on it. Capping length well below the limit turns that
/// ungraceful failure into a clean, early rejection with headroom for symbol-
/// length variance and other instance state, and keeps `prune_settled`'s
/// full-list scan bounded. Full resolution (individually-keyed active entries
/// + a compact index) is a larger storage migration tracked separately.
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 1_000;

// Deadline-derived TTL inputs (flat floor, post-deadline buffer, ledger-time
// conversion, and network-max clamp) live in `sentinel_types::ttl`, shared
// with the pool. A flight may be insured up to 90 days before departure, but a
// flat ~31-day bump would let a long-dated record archive before the oracle
// ever reports on it, after which every lifecycle write panics ("flight not
// registered"). `extend_flight_ttl_to` instead sizes the extension to cover
// the flight date plus a settlement buffer.

/// TTL horizon for a flight whose outcome is recorded but whose financial
/// settlement has not completed (Landed/Cancelled/ToBeSettled*). Settlement is
/// keeper-driven and can stall (keeper outage, paused protocol, RPC failure);
/// the previous date-based extension bottomed out at the ~31-day floor once
/// the flight date passed, so an outage longer than that could archive a
/// record that still has premiums, payouts, and locked collateral riding on
/// it — blocking settlement until manual ledger restoration. 90 days
/// comfortably exceeds any plausible outage while staying (with the TTL
/// buffer) under the 180-day network maximum.
pub(crate) const SETTLEMENT_GRACE_SECS: u64 = 90 * SECONDS_PER_DAY;

// Settled flights stay in `ActiveFlightList` for SETTLED_RETENTION_DAYS after
// `set_settled` records their `settled_at` timestamp. Pruning is delegated to
// the permissionless `prune_settled` entry — keeps freshly-settled flights
// visible to off-chain monitoring / indexers / observability tooling for the
// retention window before they disappear from the list.
//
// Kept deliberately short (7 days, not 30): the active list is a single
// capped vector, and settled flights lingering in it consume capacity that new
// registrations need. Every settlement already emits an event, so off-chain
// consumers do not depend on this on-chain window — 7 days is ample for direct
// queries while quadrupling the settled-flight throughput the cap tolerates.
pub(crate) const SETTLED_RETENTION_DAYS: u64 = 7;
pub(crate) const SECONDS_PER_DAY: u64 = 86_400;
