use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol, Vec};
use stellar_access::ownable;
use stellar_macros::only_owner;

use crate::auth::extend_instance_ttl;
use crate::events::{ControllerSet, FlightEvicted, OracleSet};
use crate::storage::OracleKey;
use crate::{Error, OracleAggregator, OracleAggregatorArgs, OracleAggregatorClient};

#[contractimpl]
impl OracleAggregator {
    /// Initialize the oracle aggregator.
    ///
    /// # Arguments
    /// * `owner` - Address granted owner rights (set the authorized controller,
    ///   manage configuration, upgrade).
    /// * `authorized_oracle` - Address permitted to submit flight outcome data.
    pub fn __constructor(e: &Env, owner: Address, authorized_oracle: Address) {
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&OracleKey::AuthorizedOracle, &authorized_oracle);
        sentinel_types::upgrade::set_initial_version(e);
    }

    // --- Owner-only admin functions ---

    /// Set the authorized controller address. Can only be called once.
    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        let existing: Option<Address> =
            e.storage().instance().get(&OracleKey::AuthorizedController);
        if existing.is_some() {
            panic_with_error!(e, Error::ControllerAlreadySet);
        }

        e.storage()
            .instance()
            .set(&OracleKey::AuthorizedController, &controller);
        extend_instance_ttl(e);
        ControllerSet { controller }.publish(e);
    }

    /// Update the authorized oracle address (for backend migration).
    #[only_owner]
    pub fn set_oracle(e: &Env, new_oracle: Address) {
        e.storage()
            .instance()
            .set(&OracleKey::AuthorizedOracle, &new_oracle);
        extend_instance_ttl(e);
        OracleSet { oracle: new_oracle }.publish(e);
    }

    /// Remove an active-list entry whose `FlightData` has archived past its
    /// TTL (owner-only). `prune_settled` deliberately retains such entries —
    /// archived is not settled, and permissionless eviction would strip an
    /// unresolved flight from keeper enumeration. Freeing the capped list
    /// slot therefore requires the owner to first confirm, off-chain, that
    /// the flight needs no further on-chain resolution (or to restore the
    /// archived entry instead, after which the normal pipeline resumes).
    /// Bounded: refuses to evict a flight whose data is still present — live
    /// flights can only leave the list via the normal settle-and-prune path.
    #[only_owner]
    pub fn evict_missing_flight(e: &Env, flight_id: Symbol, date: u64) {
        if e.storage()
            .persistent()
            .has(&OracleKey::FlightData(flight_id.clone(), date))
        {
            panic_with_error!(e, Error::FlightDataStillPresent);
        }

        let flights: Vec<(Symbol, u64)> = e
            .storage()
            .instance()
            .get(&OracleKey::ActiveFlightList)
            .unwrap_or(Vec::new(e));
        let mut found: Option<u32> = None;
        for i in 0..flights.len() {
            if flights.get(i).unwrap() == (flight_id.clone(), date) {
                found = Some(i);
                break;
            }
        }
        let idx = match found {
            Some(i) => i,
            None => panic_with_error!(e, Error::FlightNotInList),
        };

        let mut flights = flights;
        flights.remove(idx);
        e.storage()
            .instance()
            .set(&OracleKey::ActiveFlightList, &flights);
        extend_instance_ttl(e);

        FlightEvicted { flight_id, date }.publish(e);
    }

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net; instance-mutating
    /// hot paths also renew it inline so the contract self-heals if the cron
    /// lapses.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }
}
