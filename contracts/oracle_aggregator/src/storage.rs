use soroban_sdk::{contracttype, Env, Symbol};

use crate::constants::{PERSISTENT_TTL_EXTEND, PERSISTENT_TTL_THRESHOLD};

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
