use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};

use crate::storage::{read_buyer_whitelisted, read_whitelist_enabled, CtrlKey};
use crate::{Controller, ControllerArgs, ControllerClient};

#[contractimpl]
impl Controller {
    /// Per-traveler index — returns the address's most recent
    /// `(flight_id, date)` purchases, bounded at `MAX_TRAVELER_FLIGHTS` (the
    /// oldest entries are evicted once the cap is reached; full history is
    /// reconstructable from events). Frontend filters by current status
    /// (looked up in FlightPoolManager / oracle).
    pub fn get_flights_for_traveler(e: &Env, address: Address) -> Vec<(Symbol, u64)> {
        e.storage()
            .persistent()
            .get(&CtrlKey::TravelerFlights(address))
            .unwrap_or(Vec::new(e))
    }

    /// Returns aggregate stats: total policies sold, premiums collected, and
    /// payouts distributed. The payouts figure is the gross claimable value
    /// opened by delayed/cancelled settlements (payoff × buyer_count) — it
    /// includes the premium portion already held by the pool, not just the
    /// vault's outflow.
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

    /// Returns the currently authorized keeper address.
    pub fn get_keeper(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&CtrlKey::AuthorizedKeeper)
            .unwrap()
    }

    /// Returns the configured vault solvency ratio.
    pub fn get_solvency_ratio(e: &Env) -> u32 {
        e.storage().instance().get(&CtrlKey::SolvencyRatio).unwrap()
    }

    /// Returns the configured FlightPoolManager contract address.
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

    /// Whether `addr` holds a currently valid whitelist approval — added,
    /// not removed, and not past its 180-day inactivity deadline (each
    /// purchase slides the deadline forward). Returns `false` for any
    /// address never added, removed, or dormant past the window.
    pub fn is_whitelisted(e: &Env, addr: Address) -> bool {
        read_buyer_whitelisted(e, &addr)
    }
}
