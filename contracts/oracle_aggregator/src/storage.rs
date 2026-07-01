use soroban_sdk::{contracttype, Env, Symbol};

use crate::constants::{
    LEDGERS_PER_SECOND_DEN, LEDGERS_PER_SECOND_NUM, MAX_PERSISTENT_TTL_LEDGERS,
    PERSISTENT_TTL_EXTEND,
};

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

// Extend FlightData TTL to cover a deadline (the flight `date` pre-settlement) +
// a settlement buffer, instead of a flat ~31 days. Mirrors
// `flight_pool_manager::extend_flight_ttl_to`. Never shortens: floors at
// PERSISTENT_TTL_EXTEND and clamps to the network max. Once `deadline_secs` is
// in the past (flight already departed), the remaining term is zero so it
// floors to the flat 31-day extension — exactly the right behavior for a flight
// that is about to settle.
pub(crate) fn extend_flight_ttl_to(e: &Env, flight_id: &Symbol, date: u64, deadline_secs: u64) {
    use crate::constants::TTL_BUFFER_LEDGERS;
    let now = e.ledger().timestamp();
    let secs_remaining = deadline_secs.saturating_sub(now);
    let ledgers_remaining =
        secs_remaining.saturating_mul(LEDGERS_PER_SECOND_NUM) / LEDGERS_PER_SECOND_DEN;
    let ledgers_remaining_u32 = u32::try_from(ledgers_remaining).unwrap_or(u32::MAX);
    let extend_to = ledgers_remaining_u32
        .saturating_add(TTL_BUFFER_LEDGERS)
        .clamp(PERSISTENT_TTL_EXTEND, MAX_PERSISTENT_TTL_LEDGERS);

    let key = OracleKey::FlightData(flight_id.clone(), date);
    // Equal threshold/target forces the extension whenever the current TTL is
    // short of the required lifetime (see the pool's note on the no-op hazard).
    e.storage()
        .persistent()
        .extend_ttl(&key, extend_to, extend_to);
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
