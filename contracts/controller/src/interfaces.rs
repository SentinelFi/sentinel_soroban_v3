// Cross-contract interfaces. The trait names are input to `#[contractclient]`
// which generates the actual `XClient` types. The data types live in the
// shared `sentinel_types` crate so this file no longer mirrors them — single
// source of truth, no byte-layout drift hazard.
#![allow(dead_code)]

use soroban_sdk::{contractclient, Address, Env, Symbol};

pub use sentinel_types::{FlightConfig, FlightStatus, ResolvedTerms, RouteStatus};

// The oracle client is shared with the risk vault (settlement-barrier read)
// and therefore lives in `sentinel_types` alongside the data types — one
// definition, no per-consumer signature drift.
pub use sentinel_types::interfaces::OracleClient;

#[contractclient(name = "GovClient")]
pub trait GovernanceInterface {
    fn route_status(env: &Env, flight_id: Symbol, origin: Symbol, dest: Symbol) -> RouteStatus;
    fn terms_valid(env: &Env, terms: ResolvedTerms) -> bool;
    fn is_admin(env: &Env, addr: Address) -> bool;
}

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn get_free_capital(env: &Env) -> i128;
    fn get_total_managed_assets(env: &Env) -> i128;
    fn get_locked_capital(env: &Env) -> i128;
    fn increase_locked(env: &Env, controller: Address, amount: i128);
    fn decrease_locked(env: &Env, controller: Address, amount: i128);
    fn record_premium_income(env: &Env, controller: Address, amount: i128);
    fn send_payout(env: &Env, controller: Address, to: Address, amount: i128);
    fn process_withdrawal_queue(env: &Env, controller: Address);
    fn set_solvency_ratio(env: &Env, controller: Address, ratio: u32);
    fn snapshot(env: &Env);
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
    fn settle_on_time(env: &Env, controller: Address, flight_id: Symbol, date: u64) -> i128;
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
