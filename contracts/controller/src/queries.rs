use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};

use crate::storage::{read_buyer_whitelisted, read_whitelist_enabled, CtrlKey};
use crate::{Controller, ControllerArgs, ControllerClient};

#[contractimpl]
impl Controller {
    /// Per-traveler index — returns every `(flight_id, date)` the address has
    /// ever bought insurance for. Append-only; frontend filters by current
    /// status (looked up in FlightPoolManager / oracle).
    pub fn get_flights_for_traveler(e: &Env, address: Address) -> Vec<(Symbol, u64)> {
        e.storage()
            .persistent()
            .get(&CtrlKey::TravelerFlights(address))
            .unwrap_or(Vec::new(e))
    }

    pub fn get_stats(e: &Env) -> (u64, i128, i128) {
        let sold: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPoliciesSold)
            .unwrap_or(0);
        let collected: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPremiumsCollected)
            .unwrap_or(0);
        let distributed: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPayoutsDistributed)
            .unwrap_or(0);
        (sold, collected, distributed)
    }

    pub fn get_keeper(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&CtrlKey::AuthorizedKeeper)
            .unwrap()
    }

    pub fn get_solvency_ratio(e: &Env) -> u32 {
        e.storage().instance().get(&CtrlKey::SolvencyRatio).unwrap()
    }

    pub fn get_flight_pool_manager(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap()
    }

    /// Whether the buyer whitelist gate is currently active.
    pub fn whitelist_enabled(e: &Env) -> bool {
        read_whitelist_enabled(e)
    }

    /// Whether `addr` is on the whitelist. Returns `false` for any
    /// address that has never been added (or has been removed / archived).
    pub fn is_whitelisted(e: &Env, addr: Address) -> bool {
        read_buyer_whitelisted(e, &addr)
    }
}
