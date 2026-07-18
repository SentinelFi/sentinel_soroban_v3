use soroban_sdk::{contractimpl, panic_with_error, Address, Env};
use stellar_access::ownable;
use stellar_macros::{only_owner, when_not_paused};

use crate::auth::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};
use crate::events::{GovAdminAdded, GovAdminRemoved, GovDefaults, GovTermLimits};
use crate::storage::{assert_terms_valid, DataKey};
use crate::{Error, GovernanceModule, GovernanceModuleArgs, GovernanceModuleClient};

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

    /// Update the global fallback premium, payoff, and delay-hours defaults.
    #[only_owner]
    #[when_not_paused]
    pub fn set_defaults(e: &Env, premium: i128, payoff: i128, delay_hours: u32) {
        assert_terms_valid(e, premium, payoff, delay_hours);
        Self::extend_ttl(e);
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

    /// Bound the economics any route write may carry (owner-only). Route
    /// lifecycle calls are open to admins — a deliberately weaker role than
    /// owner — so these limits cap the blast radius of a single compromised
    /// admin key, in the same spirit as the controller's bounded owner
    /// setters: without them, one signature could whitelist a dust-premium,
    /// vault-sized-payoff route and any naturally delayed or cancelled
    /// flight on it would hand the vault's free capital to the buyer.
    ///
    /// `max_payoff` is an absolute per-policy payoff ceiling in asset units
    /// (0 disables it — pick a deployment-appropriate value at wiring time).
    /// `max_payoff_ratio` caps `payoff / premium`; it is unit-free, defaults
    /// to a generous constant from genesis, and cannot be disabled (a ratio
    /// below 2 would reject every valid route, since payoff must exceed
    /// premium). Both are enforced on every route write and on
    /// `set_defaults`, and `route_status` stops advertising a route that
    /// exceeds the current limits — lowering them retroactively de-lists
    /// oversized routes.
    #[only_owner]
    #[when_not_paused]
    pub fn set_term_limits(e: &Env, max_payoff: i128, max_payoff_ratio: i128) {
        if max_payoff < 0 || max_payoff_ratio < 2 {
            panic_with_error!(e, Error::InvalidTermLimits);
        }
        Self::extend_ttl(e);
        e.storage().instance().set(&DataKey::MaxPayoff, &max_payoff);
        e.storage()
            .instance()
            .set(&DataKey::MaxPayoffRatio, &max_payoff_ratio);

        GovTermLimits {
            max_payoff,
            max_payoff_ratio,
        }
        .publish(e);
    }

    /// Grant admin rights to an address.
    #[only_owner]
    #[when_not_paused]
    pub fn add_admin(e: &Env, admin: Address) {
        Self::extend_ttl(e);
        e.storage()
            .instance()
            .set(&DataKey::Admin(admin.clone()), &true);

        GovAdminAdded { admin }.publish(e);
    }

    /// Revoke admin rights from an address.
    ///
    /// Deliberately NOT pause-gated: this write only removes authority — it
    /// grants nothing — and an incident response plausibly has the module
    /// paused at exactly the moment a compromised admin key most needs
    /// revoking; gating it would force an unpause first. Same convention as
    /// the oracle's pause-exempt `close_sale` and the controller's
    /// `remove_whitelisted_buyer`.
    #[only_owner]
    pub fn remove_admin(e: &Env, admin: Address) {
        Self::extend_ttl(e);
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
