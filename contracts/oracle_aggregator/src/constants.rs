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

// Sanity cap on the paginated active-flight set. Defined once in
// `sentinel_types::active_set` — next to the structure it bounds and shared
// with the FlightPoolManager — so the two caps can never drift (a divergent
// copy would let one contract reject a first-buy registration the other still
// accepts). Re-exported here so existing `crate::constants::MAX_ACTIVE_FLIGHTS`
// references keep resolving.
pub(crate) use sentinel_types::active_set::MAX_ACTIVE_FLIGHTS;

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
// Kept deliberately short (7 days, not 30): settled flights lingering in the
// paginated active set inflate keeper sweep and prune footprints for no
// benefit. Every settlement already emits an event, so off-chain consumers do
// not depend on this on-chain window — 7 days is ample for direct queries.
pub(crate) const SETTLED_RETENTION_DAYS: u64 = 7;
pub(crate) const SECONDS_PER_DAY: u64 = 86_400;

/// Latest scheduled arrival `set_estimated_arrival` accepts, measured from
/// the departure-day midnight the flight is keyed on. No published schedule
/// puts arrival days after departure — the longest commercial routes are
/// under 24 h, and departure falls inside the key's own day — so a value
/// past this horizon is malformed, not late. The lower-bound checks catch
/// zeroed and before-departure values; this is the symmetric upper half,
/// aimed squarely at unit confusion in a future executor backend: a
/// milliseconds-for-seconds timestamp (~10¹²) sails over every lower bound
/// but sits five orders of magnitude above this ceiling. Without it, one
/// such write would zero the delay computation for the flight (saturating
/// subtraction), classifying genuinely delayed flights on-time with no
/// correction path in the forward-only machine — and push the Active-void
/// timeout out of reach.
pub(crate) const MAX_SCHEDULED_ARRIVAL_AFTER_DATE_SECS: u64 = 3 * SECONDS_PER_DAY;

/// Latest actual arrival `set_landed` accepts, measured from the
/// departure-day midnight. Generous — comfortably past any real diversion,
/// recovery, or days-late resolution (the classify pipeline voids an
/// unresolved flight 14 days past its scheduled arrival anyway) — while
/// still five orders of magnitude below a milliseconds-for-seconds value.
/// The stakes of the missing upper bound are highest here: a unit-confused
/// actual arrival computes to a ~10¹²-second delay, classifying EVERY
/// flight the buggy backend settles as delayed and paying
/// `(payoff − premium) × buyer_count` per flight, irreversibly.
pub(crate) const MAX_ACTUAL_ARRIVAL_AFTER_DATE_SECS: u64 = 30 * SECONDS_PER_DAY;

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
