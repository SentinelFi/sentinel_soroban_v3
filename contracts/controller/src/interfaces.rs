// Cross-contract interfaces (inline trait + mirror types). Mirror struct/enum
// field order MUST match the upstream contract — drift causes runtime
// deserialization panics. The trait names exist only as input to the
// `#[contractclient]` macro that generates the actual `XClient` types.
#![allow(dead_code)]

use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol, Vec};

#[contractclient(name = "GovClient")]
pub trait GovernanceInterface {
    fn route_status(env: &Env, flight_id: Symbol, origin: Symbol, dest: Symbol) -> RouteStatus;
}

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

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn get_free_capital(env: &Env) -> i128;
    fn increase_locked(env: &Env, controller: Address, amount: i128);
    fn decrease_locked(env: &Env, controller: Address, amount: i128);
    fn record_premium_income(env: &Env, controller: Address, amount: i128);
    fn send_payout(env: &Env, controller: Address, to: Address, amount: i128);
    fn process_withdrawal_queue(env: &Env, controller: Address);
    fn snapshot(env: &Env);
}

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
    pub settled_at: u64, // 0 means not-yet-settled — must match oracle's struct field order
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn register_flight(env: &Env, controller: Address, flight_id: Symbol, date: u64);
    fn get_flight_data(env: &Env, flight_id: Symbol, date: u64) -> FlightData;
    fn get_active_flights(env: &Env) -> Vec<(Symbol, u64)>;
    fn set_to_be_settled(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        status: FlightStatus,
    );
    fn set_settled(env: &Env, controller: Address, flight_id: Symbol, date: u64);
}

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

#[contractclient(name = "FlightPoolManagerClient")]
pub trait FlightPoolManagerInterface {
    fn register_flight(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        premium: i128,
        payoff: i128,
        delay_hours: u32,
    );
    fn get_flight_config(env: &Env, flight_id: Symbol, date: u64) -> Option<FlightConfig>;
    fn add_buyer(env: &Env, controller: Address, flight_id: Symbol, date: u64, buyer: Address);
    fn settle_on_time(env: &Env, controller: Address, flight_id: Symbol, date: u64);
    fn settle_delayed(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    );
    fn settle_cancelled(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    );
}
