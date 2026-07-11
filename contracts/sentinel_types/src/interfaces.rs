//! Shared cross-contract client for the OracleAggregator. The controller
//! (register / classify / settle) and the risk vault (settlement-pending
//! barrier read) both call the oracle; defining the client trait once here —
//! next to the shared data types — means the call ABI cannot drift between
//! consumers the way per-crate mirror traits could.
#![allow(dead_code)]

use soroban_sdk::{contractclient, Address, Env, Symbol, Vec};

use crate::{FlightData, FlightStatus};

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn register_flight(env: &Env, controller: Address, flight_id: Symbol, date: u64);
    fn get_flight_data(env: &Env, flight_id: Symbol, date: u64) -> FlightData;
    fn has_flight_data(env: &Env, flight_id: Symbol, date: u64) -> bool;
    fn get_active_flights(env: &Env) -> Vec<(Symbol, u64)>;
    fn set_to_be_settled(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        status: FlightStatus,
    );
    fn set_settled(env: &Env, controller: Address, flight_id: Symbol, date: u64);
    fn has_pending_outcomes(env: &Env) -> bool;
}
