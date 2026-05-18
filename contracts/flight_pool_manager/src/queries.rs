use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};

use crate::storage::PoolKey;
use crate::{FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient};

#[contractimpl]
impl FlightPoolManager {
    /// Returns `Some(cfg)` if the flight is registered, `None` otherwise.
    /// Caller decides how to handle missing entries — controllers use this
    /// for the "look up; if missing, register" pattern in `buy_insurance`
    /// without forcing a panic + restart.
    pub fn get_flight_config(
        e: &Env,
        flight_id: Symbol,
        date: u64,
    ) -> Option<FlightConfig> {
        e.storage()
            .persistent()
            .get(&PoolKey::FlightConfig(flight_id, date))
    }

    pub fn has_policy(e: &Env, flight_id: Symbol, date: u64, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Buyer(flight_id, date, traveler))
            .unwrap_or(false)
    }

    pub fn has_claimed(e: &Env, flight_id: Symbol, date: u64, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Claimed(flight_id, date, traveler))
            .unwrap_or(false)
    }

    pub fn get_active_flights(e: &Env) -> Vec<(Symbol, u64)> {
        e.storage()
            .instance()
            .get(&PoolKey::ActiveFlightList)
            .unwrap_or(Vec::new(e))
    }

    pub fn get_recovered_balance(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&PoolKey::RecoveredBalance)
            .unwrap_or(0)
    }

    pub fn get_controller(e: &Env) -> Option<Address> {
        e.storage().instance().get(&PoolKey::Controller)
    }

    pub fn get_usdc_token(e: &Env) -> Address {
        e.storage().instance().get(&PoolKey::UsdcToken).unwrap()
    }

    pub fn get_risk_vault(e: &Env) -> Address {
        e.storage().instance().get(&PoolKey::RiskVault).unwrap()
    }
}
