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

/// Sanity cap on the paginated active-flight set. The set lives in
/// per-page persistent entries (see `sentinel_types::active_set`), so
/// capacity no longer competes with the 65,536-byte contract-instance entry
/// that bounded the old single-vector list to 1,000 flights — the cap is now
/// purely an operational guard against unbounded growth (runaway
/// registration, stalled pruning), set far above any plausible concurrent
/// flight volume. Matches the FlightPoolManager cap.
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 100_000;

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

// Settled flights stay in the active set for SETTLED_RETENTION_DAYS after
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

/// Hard cap on how far ahead a sale authorization (`open_sale`) may expire.
/// The authorization is the oracle's attestation that the flight was
/// verified scheduled-and-not-cancelled AT WRITE TIME, so its remaining
/// validity is exactly how stale that attestation may be when a purchase
/// consumes it. 24 hours bounds the worst-case window in which a publicly
/// cancelled flight is still purchasable (executor outage included) while
/// keeping the oracle's refresh duty to one write per flight instance per
/// day; the executor is expected to refresh far more often and to tombstone
/// observed cancellations immediately, which closes the window regardless of
/// any live authorization.
pub(crate) const SALE_AUTH_MAX_VALIDITY_SECS: u64 = SECONDS_PER_DAY;

/// TTL slack past a sale authorization's expiry timestamp (~1 hour of
/// ledgers). The entry only needs to outlive its own expiry check; the
/// buffer absorbs ledger-time drift from the nominal 5 s cadence.
pub(crate) const SALE_AUTH_TTL_BUFFER_LEDGERS: u32 = 720;
