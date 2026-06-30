//! Read-only views over defaults, resolved route status, and admin membership.

use soroban_sdk::{contractimpl, Address, Env, Symbol};

use crate::storage::{
    extend_route_index_ttl, extend_route_ttl, read_defaults, resolve_terms, resolved_terms_valid,
    DataKey, RouteTerms,
};
use crate::{GovernanceModule, GovernanceModuleArgs, GovernanceModuleClient, RouteStatus};

#[contractimpl]
impl GovernanceModule {
    /// Return the global default premium, payoff, and delay hours.
    pub fn get_defaults(e: &Env) -> (i128, i128, u32) {
        read_defaults(e)
    }

    /// Typed status reader. Returns `Active(ResolvedTerms)` (defaults folded)
    /// if the entry exists and is approved; `Disabled` if the entry exists
    /// but is not approved; `Unknown` if the entry is missing (never
    /// whitelisted, removed, or storage archived).
    pub fn route_status(e: &Env, flight_id: Symbol, origin: Symbol, dest: Symbol) -> RouteStatus {
        let key = DataKey::Route(flight_id.clone(), origin, dest);
        let terms: Option<RouteTerms> = e.storage().persistent().get(&key);
        match terms {
            None => RouteStatus::Unknown,
            Some(t) => {
                // Refresh the route's TTL whenever it is read on a
                // committing call (e.g. the controller's buy_insurance path).
                // Route keys were otherwise extended only on write, so an
                // approved-but-idle route could archive and become unsellable
                // ("route not whitelisted") despite never being disabled.
                // Read-only simulations don't persist this, so frontend queries
                // are unaffected.
                extend_route_ttl(e, &key);
                // Keep the uniqueness index alive in lockstep:
                // otherwise it could archive while this route stays hot, letting
                // a later whitelist map the same flight_id to a conflicting
                // route.
                extend_route_index_ttl(e, &flight_id);
                if !t.approved {
                    RouteStatus::Disabled
                } else {
                    let resolved = resolve_terms(&t, read_defaults(e));
                    // A mutable-defaults change can leave a partially-defaulted
                    // route resolving to invalid economics. Do
                    // not advertise such a route as purchasable — report it as
                    // Disabled so the controller rejects the buy cleanly instead
                    // of proceeding into a downstream registration revert.
                    if !resolved_terms_valid(&resolved) {
                        RouteStatus::Disabled
                    } else {
                        RouteStatus::Active(resolved)
                    }
                }
            }
        }
    }

    /// Return whether the given address has admin rights.
    pub fn is_admin(e: &Env, addr: Address) -> bool {
        e.storage()
            .instance()
            .get(&DataKey::Admin(addr))
            .unwrap_or(false)
    }
}
