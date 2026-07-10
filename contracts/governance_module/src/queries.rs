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
    /// if the entry exists, is approved, and owns its flight_id per the
    /// uniqueness index; `Disabled` if the entry exists but is not approved;
    /// `Unknown` if the entry is missing (never whitelisted, removed, or
    /// storage archived) or the flight_id is mapped to a different route.
    pub fn route_status(e: &Env, flight_id: Symbol, origin: Symbol, dest: Symbol) -> RouteStatus {
        // NOTE ON PAUSE: this reader is deliberately not pause-gated, and its
        // side effects (TTL renewals, uniqueness-index self-heal below) still
        // commit while the module is paused. They are protective writes that
        // grant no privilege — gating them would let route/index entries
        // drift toward archival during a long incident. The pause switch
        // halts the *administrative* write entry points only.
        //
        // Purchase traffic flows through here — renew the instance alongside
        // the route keys so ongoing use keeps the contract itself alive even
        // if the external TTL cron lapses.
        Self::extend_ttl(e);
        let key = DataKey::Route(flight_id.clone(), origin.clone(), dest.clone());
        let terms: Option<RouteTerms> = e.storage().persistent().get(&key);
        match terms {
            None => RouteStatus::Unknown,
            Some(t) => {
                // Verify this route still OWNS its flight_id before advertising
                // it. Route entry and uniqueness index are separate persistent
                // keys that can archive/restore independently; if the index now
                // points at a different origin/dest, this record is a stale
                // duplicate and selling it would collide downstream
                // (flight_id, date) state with the index owner's. If the index
                // archived while the route stayed live, recreate it from this
                // record so a later whitelist can't map the id elsewhere.
                // Healing is deliberately independent of the approval flag: a
                // disabled route still owns its flight_id while paused. The
                // known limit is first-reader-wins — if TWO route entries for
                // one flight_id survive a repeated index lapse (possible only
                // after a prior lapse let a conflicting whitelist through),
                // whichever entry is read first on a committing call reclaims
                // the id and the other reads Unknown until an admin removes
                // the stale one. There is no local signal to prefer one entry;
                // prevention is the lockstep index/route TTL extension.
                let fr_key = DataKey::FlightRoute(flight_id.clone());
                match e.storage().persistent().get::<_, (Symbol, Symbol)>(&fr_key) {
                    Some((idx_origin, idx_dest)) => {
                        if !(idx_origin == origin && idx_dest == dest) {
                            return RouteStatus::Unknown;
                        }
                        extend_route_index_ttl(e, &flight_id);
                    }
                    None => {
                        e.storage().persistent().set(&fr_key, &(origin, dest));
                        extend_route_ttl(e, &fr_key);
                    }
                }
                // Refresh the route's TTL whenever it is read on a
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
