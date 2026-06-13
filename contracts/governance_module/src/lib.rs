#![no_std]

mod auth;
mod events;
mod storage;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Symbol};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_macros::{only_owner, when_not_paused};

use auth::{require_owner_or_admin, INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};
use events::{
    GovAdminAdded, GovAdminRemoved, GovDefaults, RouteDisabled, RouteEnabled, RouteListed,
    RouteRemoved, RouteUpdated,
};
use storage::{
    assert_route_terms_valid, assert_terms_valid, extend_route_ttl, read_defaults, resolve_terms,
    DataKey, RouteTerms,
};

pub use storage::{DelayHoursUpdate, PayoffUpdate, PremiumUpdate, ResolvedTerms, RouteStatus};

#[contract]
pub struct GovernanceModule;

#[contractimpl]
impl GovernanceModule {
    pub fn __constructor(
        e: &Env,
        owner: Address,
        default_premium: i128,
        default_payoff: i128,
        default_delay_hours: u32,
    ) {
        assert_terms_valid(default_premium, default_payoff, default_delay_hours);
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
    }

    // --- Owner-only ---

    #[only_owner]
    #[when_not_paused]
    pub fn set_defaults(e: &Env, premium: i128, payoff: i128, delay_hours: u32) {
        assert_terms_valid(premium, payoff, delay_hours);
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

    #[only_owner]
    pub fn upgrade(e: &Env, wasm_hash: BytesN<32>) {
        e.deployer().update_current_contract_wasm(wasm_hash);
    }

    // --- Owner or Admin: route lifecycle ---

    #[when_not_paused]
    pub fn whitelist_route(
        e: &Env,
        caller: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
        premium: Option<i128>,
        payoff: Option<i128>,
        delay_hours: Option<u32>,
    ) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id.clone(), origin.clone(), dest.clone());
        let terms = RouteTerms {
            premium,
            payoff,
            delay_hours,
            approved: true,
        };
        assert_route_terms_valid(e, &terms);
        e.storage().persistent().set(&key, &terms);
        extend_route_ttl(e, &key);

        RouteListed {
            flight_id,
            origin,
            dest,
            premium,
            payoff,
            delay_hours,
        }
        .publish(e);
    }

    #[when_not_paused]
    pub fn disable_route(
        e: &Env,
        caller: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
    ) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id.clone(), origin.clone(), dest.clone());
        let mut terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not whitelisted");
        assert!(terms.approved, "route already disabled");
        terms.approved = false;
        e.storage().persistent().set(&key, &terms);
        extend_route_ttl(e, &key);

        RouteDisabled {
            flight_id,
            origin,
            dest,
        }
        .publish(e);
    }

    #[when_not_paused]
    pub fn enable_route(e: &Env, caller: Address, flight_id: Symbol, origin: Symbol, dest: Symbol) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id.clone(), origin.clone(), dest.clone());
        let mut terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not whitelisted");
        assert!(!terms.approved, "route already active");
        terms.approved = true;
        e.storage().persistent().set(&key, &terms);
        extend_route_ttl(e, &key);

        RouteEnabled {
            flight_id,
            origin,
            dest,
        }
        .publish(e);
    }

    /// Hard-delete a route entry. Strict: requires the route to be disabled
    /// first (approved == false). Prevents fat-finger removal of an
    /// actively-purchasable route.
    #[when_not_paused]
    pub fn remove_route(e: &Env, caller: Address, flight_id: Symbol, origin: Symbol, dest: Symbol) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id.clone(), origin.clone(), dest.clone());
        let terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not whitelisted");
        assert!(!terms.approved, "route must be disabled before removal");
        e.storage().persistent().remove(&key);

        RouteRemoved {
            flight_id,
            origin,
            dest,
        }
        .publish(e);
    }

    #[when_not_paused]
    pub fn update_route_terms(
        e: &Env,
        caller: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
        premium: PremiumUpdate,
        payoff: PayoffUpdate,
        delay_hours: DelayHoursUpdate,
    ) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id.clone(), origin.clone(), dest.clone());
        let mut terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not whitelisted");

        match premium {
            PremiumUpdate::Keep => {}
            PremiumUpdate::Set(v) => terms.premium = Some(v),
            PremiumUpdate::UseDefault => terms.premium = None,
        }
        match payoff {
            PayoffUpdate::Keep => {}
            PayoffUpdate::Set(v) => terms.payoff = Some(v),
            PayoffUpdate::UseDefault => terms.payoff = None,
        }
        match delay_hours {
            DelayHoursUpdate::Keep => {}
            DelayHoursUpdate::Set(v) => terms.delay_hours = Some(v),
            DelayHoursUpdate::UseDefault => terms.delay_hours = None,
        }

        assert_route_terms_valid(e, &terms);
        e.storage().persistent().set(&key, &terms);
        extend_route_ttl(e, &key);

        RouteUpdated {
            flight_id,
            origin,
            dest,
            premium: terms.premium,
            payoff: terms.payoff,
            delay_hours: terms.delay_hours,
        }
        .publish(e);
    }

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    // --- Read functions ---

    pub fn get_defaults(e: &Env) -> (i128, i128, u32) {
        read_defaults(e)
    }

    /// Typed status reader. Returns `Active(ResolvedTerms)` (defaults folded)
    /// if the entry exists and is approved; `Disabled` if the entry exists
    /// but is not approved; `Unknown` if the entry is missing (never
    /// whitelisted, removed, or storage archived).
    pub fn route_status(e: &Env, flight_id: Symbol, origin: Symbol, dest: Symbol) -> RouteStatus {
        let key = DataKey::Route(flight_id, origin, dest);
        let terms: Option<RouteTerms> = e.storage().persistent().get(&key);
        match terms {
            None => RouteStatus::Unknown,
            Some(t) => {
                // Audit VF-05: refresh the route's TTL whenever it is read on a
                // committing call (e.g. the controller's buy_insurance path).
                // Route keys were otherwise extended only on write, so an
                // approved-but-idle route could archive and become unsellable
                // ("route not whitelisted") despite never being disabled.
                // Read-only simulations don't persist this, so frontend queries
                // are unaffected.
                extend_route_ttl(e, &key);
                if !t.approved {
                    RouteStatus::Disabled
                } else {
                    RouteStatus::Active(resolve_terms(&t, read_defaults(e)))
                }
            }
        }
    }

    pub fn is_admin(e: &Env, addr: Address) -> bool {
        e.storage()
            .instance()
            .get(&DataKey::Admin(addr))
            .unwrap_or(false)
    }
}

#[contractimpl(contracttrait)]
impl Ownable for GovernanceModule {}

#[contractimpl(contracttrait)]
impl Pausable for GovernanceModule {
    fn pause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        pausable::pause(e);
    }
    fn unpause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        pausable::unpause(e);
    }
}

#[cfg(test)]
mod test;
