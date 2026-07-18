use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol};
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
    ///
    /// Rotation does NOT invalidate outstanding sale authorizations: every
    /// window the outgoing oracle opened lives in temporary storage (not
    /// enumerable on-chain, so no bulk revoke exists) and keeps authorizing
    /// purchases through the controller until it expires — up to
    /// `SALE_AUTH_MAX_VALIDITY_SECS` — or is individually closed. For a
    /// routine backend migration that is harmless: the windows are honest
    /// attestations and the new backend re-attests on its own cadence.
    ///
    /// **Rotation as a compromise response is a two-step operation.** The
    /// departing key's parting attestations survive the swap, so flights the
    /// honest pipeline never verified (including publicly cancelled ones)
    /// stay purchasable until each window lapses. Immediately after the
    /// swap, the new oracle must sweep `close_sale` over every window still
    /// open — reconstructed off-chain from the `SaleOpened`/`SaleClosed`
    /// event stream — or the controller must be paused for the full validity
    /// horizon so nothing can purchase against them.
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
    ///
    /// **Eviction is step one of two.** Every listed flight was registered by
    /// a purchase, so it has buyers, escrowed premiums in the pool, and locked
    /// vault collateral — none of which this call releases. After evicting,
    /// the owner must run `Controller::settle_evicted_flight(flight_id, date)`
    /// to settle the pool bucket (void semantics: premiums to the vault, no
    /// payout) and unlock the collateral; skipping it leaves that capital
    /// stranded forever. That reconciliation requires the `FlightData` row to
    /// remain absent — do not restore the archived row after evicting.
    #[only_owner]
    pub fn evict_missing_flight(e: &Env, flight_id: Symbol, date: u64, outcome_pending: bool) {
        if e.storage()
            .persistent()
            .has(&OracleKey::FlightData(flight_id.clone(), date))
        {
            panic_with_error!(e, Error::FlightDataStillPresent);
        }

        // Swap-remove from the paginated active set (the set is unordered;
        // prune and the keeper cursors tolerate reordering). `remove` falls
        // back to a page scan if the reverse index archived, so a `false`
        // here genuinely means "not listed" (or its page needs restoring).
        if !sentinel_types::active_set::remove(e, &flight_id, date) {
            panic_with_error!(e, Error::FlightNotInList);
        }
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
