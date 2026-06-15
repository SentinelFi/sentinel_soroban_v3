use soroban_sdk::{contractevent, Address, Env, Symbol};

use crate::storage::FlightStatus;

// --- Owner-only configuration audit events ---

#[contractevent(topics = ["sentinel", "controller_set"], data_format = "single-value")]
pub struct ControllerSet {
    #[topic]
    pub(crate) controller: Address,
}

#[contractevent(topics = ["sentinel", "oracle_set"], data_format = "single-value")]
pub struct OracleSet {
    #[topic]
    pub(crate) oracle: Address,
}

#[contractevent(topics = ["sentinel", "flight"], data_format = "single-value")]
pub struct FlightStatusChange {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) new_status: FlightStatus,
}

// Emitted by `prune_settled` when it evicts an active-list entry
// whose FlightData is missing (archived past its persistent TTL). Eviction is
// retained (a missing entry is unrecoverable on-chain and would
// otherwise block pruning forever), but it is no longer silent: off-chain
// monitoring can detect a flight that vanished without being explicitly settled.
#[contractevent(topics = ["sentinel", "data_missing"], data_format = "map")]
pub struct MissingFlightDataPruned {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

pub(crate) fn emit_status_event(e: &Env, flight_id: &Symbol, date: u64, new_status: &FlightStatus) {
    FlightStatusChange {
        flight_id: flight_id.clone(),
        date,
        new_status: new_status.clone(),
    }
    .publish(e);
}
