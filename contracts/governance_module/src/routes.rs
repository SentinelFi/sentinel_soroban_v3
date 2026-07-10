//! Route lifecycle entry points (owner or admin): whitelist, disable, enable,
//! remove, and partial term updates for insurable routes.

use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::auth::require_owner_or_admin;
use crate::constants::{FLIGHT_ID_RETIREMENT_SECS, RETIREMENT_TTL_LEDGERS};
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
        Self::extend_ttl(e);

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

        // A removed route leaves a retirement marker: its flight_id may not be
        // remapped to a different origin/dest until every policy the old route
        // could have written downstream has aged out. Re-adding the identical
        // route (undoing a removal) is always allowed.
        if let Some((retired_origin, retired_dest, retired_until)) = e
            .storage()
            .persistent()
            .get::<_, (Symbol, Symbol, u64)>(&DataKey::RetiredFlight(flight_id.clone()))
        {
            if e.ledger().timestamp() < retired_until
                && !(retired_origin == origin && retired_dest == dest)
            {
                panic_with_error!(e, Error::FlightIdRetired);
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
        Self::extend_ttl(e);

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
        Self::extend_ttl(e);

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
        // Revalidate resolved terms against the CURRENT defaults before
        // re-activating. A route that was valid when disabled can resolve to
        // invalid economics (e.g. payoff <= premium) after a later set_defaults;
        // enabling it anyway would advertise a route the pool would reject at
        // registration. Force the admin to fix the terms or defaults first.
        assert_route_terms_valid(e, &terms);

        // The uniqueness index must agree before the route becomes purchasable
        // again. Absent (archived past TTL) → recreate it from this route;
        // pointing at a different origin/dest → the flight_id has since been
        // claimed by another route, and re-enabling this one would collide
        // their downstream (flight_id, date) state.
        let fr_key = DataKey::FlightRoute(flight_id.clone());
        match e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key) {
            Some((idx_origin, idx_dest)) => {
                if !(idx_origin == origin && idx_dest == dest) {
                    panic_with_error!(e, Error::FlightIdAlreadyMapped);
                }
                extend_route_index_ttl(e, &flight_id);
            }
            None => {
                e.storage()
                    .persistent()
                    .set(&fr_key, &(origin.clone(), dest.clone()));
                extend_route_ttl(e, &fr_key);
            }
        }

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
        Self::extend_ttl(e);

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
                // The freed id is only reserved, not immediately reusable:
                // policies sold under this route may still be live downstream
                // (booked up to 90 days ahead, claimable for the expiry window
                // after settlement), and downstream state carries no
                // origin/dest. The retirement marker blocks remapping until
                // that lifetime has provably elapsed.
                let retired_until = e
                    .ledger()
                    .timestamp()
                    .checked_add(FLIGHT_ID_RETIREMENT_SECS)
                    .expect("addition overflow");
                let retired_key = DataKey::RetiredFlight(flight_id.clone());
                e.storage()
                    .persistent()
                    .set(&retired_key, &(origin.clone(), dest.clone(), retired_until));
                e.storage().persistent().extend_ttl(
                    &retired_key,
                    RETIREMENT_TTL_LEDGERS,
                    RETIREMENT_TTL_LEDGERS,
                );
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
        Self::extend_ttl(e);

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
