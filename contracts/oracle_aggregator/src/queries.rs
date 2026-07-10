//! Read-only views over flight data and the active flight list.

use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};

use crate::storage::OracleKey;
use crate::{
    FlightData, FlightStatus, OracleAggregator, OracleAggregatorArgs, OracleAggregatorClient,
};

#[contractimpl]
impl OracleAggregator {
    /// Get flight data. Returns NotInitiated with zero timestamps for missing entries.
    pub fn get_flight_data(e: &Env, flight_id: Symbol, date: u64) -> FlightData {
        let key = OracleKey::FlightData(flight_id, date);
        e.storage().persistent().get(&key).unwrap_or(FlightData {
            status: FlightStatus::NotInitiated,
            estimated_arrival_time: 0,
            actual_arrival_time: 0,
            settled_at: 0,
        })
    }

    /// Get all registered flights (active list).
    pub fn get_active_flights(e: &Env) -> Vec<(Symbol, u64)> {
        e.storage()
            .instance()
            .get(&OracleKey::ActiveFlightList)
            .unwrap_or(Vec::new(e))
    }

    /// Number of entries in the active flight list. Cheap saturation gauge
    /// for operators: the list is capped, so occupancy approaching the cap
    /// means new-flight registration (and thus first purchases) is about to
    /// be rejected — prune promptly or investigate before that happens.
    pub fn get_active_flight_count(e: &Env) -> u32 {
        Self::get_active_flights(e).len()
    }

    /// Whether a `FlightData` entry physically exists for this key. Lets
    /// callers distinguish a genuinely unregistered flight from one whose
    /// entry archived past its TTL — `get_flight_data` reports both as
    /// `NotInitiated`, but an archived entry is restorable and may still
    /// have unresolved settlement riding on it.
    pub fn has_flight_data(e: &Env, flight_id: Symbol, date: u64) -> bool {
        e.storage()
            .persistent()
            .has(&OracleKey::FlightData(flight_id, date))
    }

    /// Get flights filtered by status. Iterates active list and filters.
    ///
    /// Unbounded: performs one persistent read per active-list entry, so its
    /// footprint grows with the list. Intended for off-chain / read-only
    /// simulation use (frontends, executor) — on-chain callers must not
    /// invoke it; the keeper entry points iterate with bounded batches
    /// instead.
    pub fn get_flights_by_status(e: &Env, status: FlightStatus) -> Vec<(Symbol, u64)> {
        let all = Self::get_active_flights(e);
        let mut result = Vec::new(e);

        for i in 0..all.len() {
            if let Some((flight_id, date)) = all.get(i) {
                let data = Self::get_flight_data(e, flight_id.clone(), date);
                if data.status == status {
                    result.push_back((flight_id, date));
                }
            }
        }

        result
    }

    // --- Admin read functions ---

    /// Get the authorized oracle address. Panics if not set.
    pub fn get_authorized_oracle(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&OracleKey::AuthorizedOracle)
            .expect("oracle not set")
    }

    /// Get the authorized controller address, or None if not yet set.
    pub fn get_authorized_controller(e: &Env) -> Option<Address> {
        e.storage().instance().get(&OracleKey::AuthorizedController)
    }

    /// Number of flights whose outcome is publicly recorded but not yet settled.
    pub fn get_pending_outcomes(e: &Env) -> u64 {
        e.storage()
            .instance()
            .get(&OracleKey::PendingOutcomes)
            .unwrap_or(0)
    }

    /// Whether any flight outcome is public but not yet financially settled.
    /// The vault reads this to block entry/exit while pending PnL is
    /// unrecognized, so LPs cannot transact at a stale share price.
    pub fn has_pending_outcomes(e: &Env) -> bool {
        Self::get_pending_outcomes(e) > 0
    }
}
