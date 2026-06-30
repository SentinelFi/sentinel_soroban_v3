//! Route lifecycle entry points (owner or admin): whitelist, disable, enable,
//! remove, and partial term updates for insurable routes.

use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::auth::require_owner_or_admin;
use crate::events::{RouteDisabled, RouteEnabled, RouteListed, RouteRemoved, RouteUpdated};
use crate::storage::{
    assert_route_terms_valid, extend_route_index_ttl, extend_route_ttl, DataKey, RouteTerms,
};
use crate::{
    DelayHoursUpdate, Error, GovernanceModule, GovernanceModuleArgs, GovernanceModuleClient,
    PayoffUpdate, PremiumUpdate,
};

#[contractimpl]
impl GovernanceModule {
    /// Whitelist a route with optional per-route term overrides.
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

        // Enforce one (origin, dest) per flight_id. Downstream
        // pool/oracle keys drop origin/dest, so allowing a flight_id to map to
        // two routes would collide their (flight_id, date) state. Re-whitelisting
        // the same route is fine; a conflicting origin/dest is rejected.
        let fr_key = DataKey::FlightRoute(flight_id.clone());
        if let Some((existing_origin, existing_dest)) =
            e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key)
        {
            if !(existing_origin == origin && existing_dest == dest) {
                panic_with_error!(e, Error::FlightIdAlreadyMapped);
            }
        }

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

        e.storage()
            .persistent()
            .set(&fr_key, &(origin.clone(), dest.clone()));
        extend_route_ttl(e, &fr_key);

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

    /// Mark a whitelisted route as disabled (not purchasable).
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
        if !terms.approved {
            panic_with_error!(e, Error::RouteAlreadyDisabled);
        }
        terms.approved = false;
        e.storage().persistent().set(&key, &terms);
        extend_route_ttl(e, &key);
        extend_route_index_ttl(e, &flight_id);

        RouteDisabled {
            flight_id,
            origin,
            dest,
        }
        .publish(e);
    }

    /// Re-enable a previously disabled route.
    #[when_not_paused]
    pub fn enable_route(e: &Env, caller: Address, flight_id: Symbol, origin: Symbol, dest: Symbol) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id.clone(), origin.clone(), dest.clone());
        let mut terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not whitelisted");
        if terms.approved {
            panic_with_error!(e, Error::RouteAlreadyActive);
        }
        terms.approved = true;
        e.storage().persistent().set(&key, &terms);
        extend_route_ttl(e, &key);
        extend_route_index_ttl(e, &flight_id);

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
        if terms.approved {
            panic_with_error!(e, Error::RouteMustBeDisabledBeforeRemoval);
        }
        e.storage().persistent().remove(&key);
        // Free the flight_id so it can be re-mapped later — but only if the
        // uniqueness index still points at THIS route. After an index-TTL lapse
        // a second, conflicting route can be whitelisted for the same flight_id;
        // unconditionally deleting the index while removing the older route
        // would then strip the newer route's ownership and reopen the flight_id
        // for further collisions.
        let fr_key = DataKey::FlightRoute(flight_id.clone());
        if let Some((idx_origin, idx_dest)) =
            e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key)
        {
            if idx_origin == origin && idx_dest == dest {
                e.storage().persistent().remove(&fr_key);
            }
        }

        RouteRemoved {
            flight_id,
            origin,
            dest,
        }
        .publish(e);
    }

    /// Partially update a route's premium, payoff, and/or delay-hours terms.
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
        extend_route_index_ttl(e, &flight_id);

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
}
