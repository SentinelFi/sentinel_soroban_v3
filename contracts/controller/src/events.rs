use soroban_sdk::{contractevent, Address, Symbol};

use crate::interfaces::FlightStatus;

#[contractevent(topics = ["sentinel", "ctrl"], data_format = "single-value")]
pub struct InsuranceBought {
    #[topic]
    pub(crate) traveler: Address,
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) premium: i128,
}

#[contractevent(topics = ["sentinel", "ctrl"], data_format = "single-value")]
pub struct FlightClassified {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) status: FlightStatus,
}

#[contractevent(topics = ["sentinel", "ctrl"], data_format = "single-value")]
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
#[contractevent(topics = ["sentinel", "ttl_miss"], data_format = "map")]
pub struct TtlMiss {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

// Diagnostic emitted by `classify_flights` / `execute_settlements`
// when a flight is present in the oracle active list but its FlightConfig is
// missing from FlightPoolManager (archived past TTL, or never registered).
// The flight is skipped instead of panicking the whole keeper loop; the
// off-chain cron consumes this to investigate / re-extend TTL.
#[contractevent(topics = ["sentinel", "cfg_missing"], data_format = "map")]
pub struct FlightConfigMissing {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

// Phase 11 — buyer whitelist lifecycle events. The whitelist itself is
// stored on Controller (one source of truth on the buy path); add/remove
// callers are validated by cross-calling GovernanceModule.is_admin.
#[contractevent(topics = ["sentinel", "buyer_whitelisted"], data_format = "single-value")]
pub struct BuyerWhitelistedEvent {
    #[topic]
    pub(crate) addr: Address,
}

#[contractevent(topics = ["sentinel", "buyer_removed"], data_format = "single-value")]
pub struct BuyerWhitelistRemovedEvent {
    #[topic]
    pub(crate) addr: Address,
}

#[contractevent(topics = ["sentinel", "whitelist_toggled"], data_format = "single-value")]
pub struct WhitelistToggled {
    pub(crate) enabled: bool,
}
