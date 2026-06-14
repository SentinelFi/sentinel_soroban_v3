use soroban_sdk::{contractimpl, Address, Env};
use stellar_access::ownable;
use stellar_macros::{only_owner, when_not_paused};

use crate::auth::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};
use crate::events::{GovAdminAdded, GovAdminRemoved, GovDefaults};
use crate::storage::{assert_terms_valid, DataKey};
use crate::{GovernanceModule, GovernanceModuleArgs, GovernanceModuleClient};

#[contractimpl]
impl GovernanceModule {
    /// Initialize the governance module.
    ///
    /// # Arguments
    /// * `owner` - Address granted owner rights (manage admins, update
    ///   defaults, upgrade).
    /// * `default_premium` - Fallback premium (asset units) applied to routes
    ///   that don't override it.
    /// * `default_payoff` - Fallback payoff (asset units) paid on a valid
    ///   claim; must exceed the premium.
    /// * `default_delay_hours` - Fallback delay threshold (hours) after which a
    ///   flight counts as delayed.
    pub fn __constructor(
        e: &Env,
        owner: Address,
        default_premium: i128,
        default_payoff: i128,
        default_delay_hours: u32,
    ) {
        assert_terms_valid(e, default_premium, default_payoff, default_delay_hours);
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&DataKey::DefaultPremium, &default_premium);
        e.storage()
            .instance()
            .set(&DataKey::DefaultPayoff, &default_payoff);
        e.storage()
            .instance()
            .set(&DataKey::DefaultDelayHours, &default_delay_hours);
        sentinel_types::upgrade::set_initial_version(e);
    }

    // --- Owner-only ---

    #[only_owner]
    #[when_not_paused]
    pub fn set_defaults(e: &Env, premium: i128, payoff: i128, delay_hours: u32) {
        assert_terms_valid(e, premium, payoff, delay_hours);
        e.storage()
            .instance()
            .set(&DataKey::DefaultPremium, &premium);
        e.storage().instance().set(&DataKey::DefaultPayoff, &payoff);
        e.storage()
            .instance()
            .set(&DataKey::DefaultDelayHours, &delay_hours);

        GovDefaults {
            premium,
            payoff,
            delay_hours,
        }
        .publish(e);
    }

    #[only_owner]
    #[when_not_paused]
    pub fn add_admin(e: &Env, admin: Address) {
        e.storage()
            .instance()
            .set(&DataKey::Admin(admin.clone()), &true);

        GovAdminAdded { admin }.publish(e);
    }

    #[only_owner]
    #[when_not_paused]
    pub fn remove_admin(e: &Env, admin: Address) {
        e.storage()
            .instance()
            .remove(&DataKey::Admin(admin.clone()));

        GovAdminRemoved { admin }.publish(e);
    }

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
}
