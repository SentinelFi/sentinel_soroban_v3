use soroban_sdk::{contractevent, Env, Symbol};

use crate::storage::FlightStatus;

#[contractevent(topics = ["flight"], data_format = "single-value")]
pub struct FlightStatusChange {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) new_status: FlightStatus,
}

pub(crate) fn emit_status_event(e: &Env, flight_id: &Symbol, date: u64, new_status: &FlightStatus) {
    FlightStatusChange {
        flight_id: flight_id.clone(),
        date,
        new_status: new_status.clone(),
    }
    .publish(e);
}
