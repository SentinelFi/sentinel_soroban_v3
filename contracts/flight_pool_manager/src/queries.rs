use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};

use crate::storage::PoolKey;
use crate::{FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient};

#[contractimpl]
impl FlightPoolManager {
    /// Returns `Some(cfg)` if the flight is registered, `None` otherwise.
    /// Caller decides how to handle missing entries — controllers use this
    /// for the "look up; if missing, register" pattern in `buy_insurance`
    /// without forcing a panic + restart.
    pub fn get_flight_config(e: &Env, flight_id: Symbol, date: u64) -> Option<FlightConfig> {
        e.storage()
            .persistent()
            .get(&PoolKey::FlightConfig(flight_id, date))
    }

    /// Returns true if the traveler holds a policy for the given flight.
    pub fn has_policy(e: &Env, flight_id: Symbol, date: u64, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Buyer(flight_id, date, traveler))
            .unwrap_or(false)
    }

    /// Returns true if the traveler has already claimed their payout.
    pub fn has_claimed(e: &Env, flight_id: Symbol, date: u64, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Claimed(flight_id, date, traveler))
            .unwrap_or(false)
    }

    /// Returns the currently active (unsettled) flights — the whole
    /// paginated active set. Footprint grows with the set's page count (one
    /// ledger entry per ~100 flights); off-chain / simulation convenience.
    pub fn get_active_flights(e: &Env) -> Vec<(Symbol, u64)> {
        sentinel_types::active_set::get_all(e)
    }

    /// Up to `limit` active-set entries starting at slot `offset` — the
    /// bounded enumeration for footprint-sensitive callers. The set is
    /// unordered and removal reshuffles slots.
    pub fn get_active_flights_page(e: &Env, offset: u32, limit: u32) -> Vec<(Symbol, u64)> {
        sentinel_types::active_set::get_range(e, offset, limit)
    }

    /// Number of currently active (unsettled) flight buckets — O(1) from the
    /// stored count. Cheap saturation gauge for operators: the set is capped
    /// (a sanity bound, no longer a storage-entry limit), so occupancy
    /// approaching the cap means new-bucket registration (and thus first
    /// purchases of new flights) is about to be rejected — investigate
    /// settlement throughput before that happens.
    pub fn get_active_flight_count(e: &Env) -> u32 {
        sentinel_types::active_set::count(e)
    }

    /// Returns the balance of unclaimed funds available for owner recovery.
    pub fn get_recovered_balance(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&PoolKey::RecoveredBalance)
            .unwrap_or(0)
    }

    /// Returns the authorized controller address, or `None` if unset.
    pub fn get_controller(e: &Env) -> Option<Address> {
        e.storage().instance().get(&PoolKey::Controller)
    }

    /// Returns the asset token address used for premiums and payouts.
    pub fn get_asset_token(e: &Env) -> Address {
        e.storage().instance().get(&PoolKey::AssetToken).unwrap()
    }

    /// Returns the RiskVault address that collected premiums are swept to.
    pub fn get_risk_vault(e: &Env) -> Address {
        e.storage().instance().get(&PoolKey::RiskVault).unwrap()
    }
}
