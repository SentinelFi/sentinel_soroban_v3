use soroban_sdk::{contractevent, Address, Symbol};

use crate::interfaces::FlightStatus;

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct InsuranceBought {
    #[topic]
    pub(crate) traveler: Address,
    pub(crate) premium: i128,
}

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct FlightClassified {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) status: FlightStatus,
}

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct FlightSettledEvent {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) outcome: FlightStatus,
}

// Diagnostic warning emitted by `classify_flights` when oracle returns
// NotInitiated for a flight in the active list — signals that FlightData
// may have archived (or oracle hasn't fetched data yet for an overdue
// flight). Consumed by the off-chain TTL-extender cron.
#[contractevent(topics = ["warn", "ttl_miss"], data_format = "map")]
pub struct TtlMiss {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}
