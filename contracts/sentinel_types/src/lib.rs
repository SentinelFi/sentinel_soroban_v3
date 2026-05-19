// Shared cross-contract types. Lives in its own crate so the canonical
// definitions and the controller-side mirrors are guaranteed to share a
// single XDR layout — eliminates the byte-level drift hazard that motivated
// audit I-05.
//
// Every type here is part of the public ABI of at least one contract.
// Field/variant order is load-bearing for #[contracttype] codec — do NOT
// reorder without bumping all dependent contract versions in lockstep.

#![no_std]

use soroban_sdk::contracttype;

// =========================================================================
// governance_module
// =========================================================================

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedTerms {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RouteStatus {
    Active(ResolvedTerms),
    Disabled,
    Unknown,
}

// =========================================================================
// oracle_aggregator
// =========================================================================

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum FlightStatus {
    NotInitiated,
    Active,
    Landed,
    Cancelled,
    ToBeSettledOnTime,
    ToBeSettledDelayed,
    ToBeSettledCancelled,
    Settled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlightData {
    pub status: FlightStatus,
    pub estimated_arrival_time: u64,
    pub actual_arrival_time: u64,
    pub settled_at: u64,
}

// =========================================================================
// flight_pool_manager
// =========================================================================

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlightConfig {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
    pub buyer_count: u32,
    pub claimed_count: u32,
    pub status: SettlementStatus,
    pub claim_expiry: u64,
}
