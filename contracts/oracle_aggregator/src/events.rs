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

// Emitted by `prune_settled` when it encounters an active-list entry whose
// FlightData is missing (archived past its persistent TTL). The entry is
// RETAINED — archived is not settled, and the flight may still have money
// riding on it — so this is a recovery-required signal: operators restore the
// archived entry via ledger restoration, or confirm finality off-chain and
// free the slot with the owner-only `evict_missing_flight`.
#[contractevent(topics = ["sentinel", "data_missing"], data_format = "map")]
pub struct MissingFlightData {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

// Emitted when the owner removes an active-list entry whose FlightData is
// missing, after confirming off-chain that the flight needs no further
// on-chain resolution. Audit trail for the manual capacity-release path.
#[contractevent(topics = ["sentinel", "evicted"], data_format = "map")]
pub struct FlightEvicted {
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
