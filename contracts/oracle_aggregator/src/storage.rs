use soroban_sdk::{contracttype, Env, Symbol};

// Cross-contract types live in the shared `sentinel_types` crate.
pub use sentinel_types::{FlightData, FlightStatus};

#[contracttype]
pub enum OracleKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    AuthorizedOracle,
    AuthorizedController,
    ActiveFlightList,
    PruneCursor, // u32 — rotating index into ActiveFlightList

    // Persistent — keyed multi-row state
    FlightData(Symbol, u64),
}

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

pub(crate) fn extend_flight_ttl(e: &Env, flight_id: &Symbol, date: u64) {
    let key = OracleKey::FlightData(flight_id.clone(), date);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

/// Forward-only state machine — accepted edges.
pub(crate) fn is_valid_transition(from: &FlightStatus, to: &FlightStatus) -> bool {
    matches!(
        (from, to),
        (FlightStatus::NotInitiated, FlightStatus::Active)
            // Short-notice cancellation: oracle may learn the flight is
            // cancelled before it has set an estimated arrival time.
            | (FlightStatus::NotInitiated, FlightStatus::Cancelled)
            | (FlightStatus::Active, FlightStatus::Landed)
            | (FlightStatus::Active, FlightStatus::Cancelled)
            | (FlightStatus::Landed, FlightStatus::ToBeSettledOnTime)
            | (FlightStatus::Landed, FlightStatus::ToBeSettledDelayed)
            | (FlightStatus::Cancelled, FlightStatus::ToBeSettledCancelled)
            | (FlightStatus::ToBeSettledOnTime, FlightStatus::Settled)
            | (FlightStatus::ToBeSettledDelayed, FlightStatus::Settled)
            | (FlightStatus::ToBeSettledCancelled, FlightStatus::Settled)
    )
}
