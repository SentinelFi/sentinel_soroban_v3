use soroban_sdk::{contractimpl, panic_with_error, Address, Env};
use stellar_access::ownable;
use stellar_macros::only_owner;

use crate::auth::extend_instance_ttl;
use crate::events::{ControllerSet, OracleSet};
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

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net; instance-mutating
    /// hot paths also renew it inline so the contract self-heals if the cron
    /// lapses.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }
}
