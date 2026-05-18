use soroban_sdk::{contractevent, Address, Symbol};

use crate::storage::SettlementStatus;

#[contractevent(topics = ["register"], data_format = "map")]
pub struct FlightRegistered {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) premium: i128,
    pub(crate) payoff: i128,
    pub(crate) delay_hours: u32,
}

#[contractevent(topics = ["buyer"], data_format = "single-value")]
pub struct BuyerAdded {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) buyer: Address,
}

#[contractevent(topics = ["settle"], data_format = "map")]
pub struct FlightSettled {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) status: SettlementStatus,
    pub(crate) claim_expiry: u64,
}

#[contractevent(topics = ["claim"], data_format = "map")]
pub struct PayoutClaimed {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) traveler: Address,
    pub(crate) amount: i128,
}

#[contractevent(topics = ["sweep"], data_format = "single-value")]
pub struct ExpiredSwept {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) unclaimed: i128,
}

#[contractevent(topics = ["withdraw"], data_format = "single-value")]
pub struct RecoveredWithdrawn {
    #[topic]
    pub(crate) owner: Address,
    pub(crate) amount: i128,
}
