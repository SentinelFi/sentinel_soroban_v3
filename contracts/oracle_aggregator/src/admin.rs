use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol, Vec};
use stellar_access::ownable;
use stellar_macros::only_owner;

use crate::auth::extend_instance_ttl;
use crate::events::{ControllerSet, FlightEvicted, OracleSet};
use crate::storage::{decrement_pending_outcomes, OracleKey};
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
    /// the flight needs no further on-chain resolution. **Restoring the
    /// archived entry and letting the normal settle pipeline finish is always
    /// the preferred path** — eviction removes the flight from keeper
    /// enumeration permanently (re-registration of an existing key does not
    /// re-add it to the list).
    ///
    /// `outcome_pending` must be `true` iff the flight's outcome was already
    /// publicly recorded (it reached Landed / Cancelled / ToBeSettled*) and
    /// therefore counted toward `PendingOutcomes`. The counter is only ever
    /// released by settlement; evicting such a flight without releasing its
    /// count would leave the vault's entry/exit barrier engaged forever, with
    /// no remaining on-chain path to decrement it. The owner reconstructs the
    /// flag from the flight's status-change events. Passing `true` for a
    /// flight that was never counted opens the barrier early instead — both
    /// directions are owner judgment calls, so the flag is recorded on the
    /// audit event.
    ///
    /// Bounded: refuses to evict a flight whose data is still present — live
    /// flights can only leave the list via the normal settle-and-prune path.
    #[only_owner]
    pub fn evict_missing_flight(e: &Env, flight_id: Symbol, date: u64, outcome_pending: bool) {
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
        // Release the barrier count this flight would have released at
        // settlement — eviction is its terminal transition.
        if outcome_pending {
            decrement_pending_outcomes(e);
        }
        extend_instance_ttl(e);

        FlightEvicted {
            flight_id,
            date,
            outcome_pending,
        }
        .publish(e);
    }

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net; instance-mutating
    /// hot paths also renew it inline so the contract self-heals if the cron
    /// lapses.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }
}
