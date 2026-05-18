#![no_std]
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, Env, Symbol,
};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

// --- Storage keys ---

#[contracttype]
pub enum DataKey {
    Admin(Address),                       // bool — Instance
    DefaultPremium,                       // i128 — Instance
    DefaultPayoff,                        // i128 — Instance
    DefaultDelayHours,                    // u32 — Instance
    Route(Symbol, Symbol, Symbol),        // RouteTerms — Persistent
}

// --- Domain types ---

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RouteTerms {
    pub premium: Option<i128>,
    pub payoff: Option<i128>,
    pub delay_hours: Option<u32>,
    pub approved: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedTerms {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RouteStatus {
    Active(ResolvedTerms),
    Disabled,
    Unknown,
}

// Partial-update enums for update_route_terms.
// Soroban contracttype has no generics, so one enum per field type.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PremiumUpdate {
    Keep,
    Set(i128),
    UseDefault,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PayoffUpdate {
    Keep,
    Set(i128),
    UseDefault,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DelayHoursUpdate {
    Keep,
    Set(u32),
    UseDefault,
}

// --- TTL constants ---

// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800.
// Applied on every Route(...) write to keep actively edited routes from
// archival drift; idle routes are extended by the off-chain TTL cron
// (Cron #4) which folds Route(...) keys into its ExtendFootprintTTLOp
// footprint using the indexer's enumeration.
const ROUTE_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;

// --- Helpers ---

fn require_owner_or_admin(e: &Env, caller: &Address) {
    caller.require_auth();
    let owner: Option<Address> = ownable::get_owner(e);
    if let Some(ref o) = owner {
        if caller == o {
            return;
        }
    }
    let is_admin: bool = e
        .storage()
        .instance()
        .get(&DataKey::Admin(caller.clone()))
        .unwrap_or(false);
    assert!(is_admin, "not owner or admin");
}

fn extend_route_ttl(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, ROUTE_TTL_LEDGERS, ROUTE_TTL_LEDGERS);
}

fn read_defaults(e: &Env) -> (i128, i128, u32) {
    let premium: i128 = e.storage().instance().get(&DataKey::DefaultPremium).unwrap();
    let payoff: i128 = e.storage().instance().get(&DataKey::DefaultPayoff).unwrap();
    let delay_hours: u32 = e
        .storage()
        .instance()
        .get(&DataKey::DefaultDelayHours)
        .unwrap();
    (premium, payoff, delay_hours)
}

fn resolve(terms: &RouteTerms, defaults: (i128, i128, u32)) -> ResolvedTerms {
    let (default_premium, default_payoff, default_delay_hours) = defaults;
    ResolvedTerms {
        premium: terms.premium.unwrap_or(default_premium),
        payoff: terms.payoff.unwrap_or(default_payoff),
        delay_hours: terms.delay_hours.unwrap_or(default_delay_hours),
    }
}

// --- Events ---
//
// Topic prefix scheme: ["route", <action>] for route-lifecycle events,
// ["gov", <action>] for governance-meta events.
//
// route.listed / route.updated carry Option<T> values (NOT resolved):
// indexers mirror option-ness in their schema (NULL = UseDefault) and
// resolve against the latest gov.defaults singleton at read time. This
// means a defaults change does not require updating every UseDefault
// route — the indexer just updates its defaults row.

#[contractevent(topics = ["route", "listed"], data_format = "map")]
pub struct RouteListed {
    #[topic]
    flight_id: Symbol,
    origin: Symbol,
    dest: Symbol,
    premium: Option<i128>,
    payoff: Option<i128>,
    delay_hours: Option<u32>,
}

#[contractevent(topics = ["route", "disabled"], data_format = "map")]
pub struct RouteDisabled {
    #[topic]
    flight_id: Symbol,
    origin: Symbol,
    dest: Symbol,
}

#[contractevent(topics = ["route", "enabled"], data_format = "map")]
pub struct RouteEnabled {
    #[topic]
    flight_id: Symbol,
    origin: Symbol,
    dest: Symbol,
}

#[contractevent(topics = ["route", "updated"], data_format = "map")]
pub struct RouteUpdated {
    #[topic]
    flight_id: Symbol,
    origin: Symbol,
    dest: Symbol,
    premium: Option<i128>,
    payoff: Option<i128>,
    delay_hours: Option<u32>,
}

#[contractevent(topics = ["route", "removed"], data_format = "map")]
pub struct RouteRemoved {
    #[topic]
    flight_id: Symbol,
    origin: Symbol,
    dest: Symbol,
}

#[contractevent(topics = ["gov", "defaults"], data_format = "map")]
pub struct GovDefaults {
    premium: i128,
    payoff: i128,
    delay_hours: u32,
}

#[contractevent(topics = ["gov", "admin_added"], data_format = "single-value")]
pub struct GovAdminAdded {
    #[topic]
    admin: Address,
}

#[contractevent(topics = ["gov", "admin_removed"], data_format = "single-value")]
pub struct GovAdminRemoved {
    #[topic]
    admin: Address,
}

// --- Contract ---

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
    pub fn set_defaults(e: &Env, premium: i128, payoff: i128, delay_hours: u32) {
        e.storage()
            .instance()
            .set(&DataKey::DefaultPremium, &premium);
        e.storage()
            .instance()
            .set(&DataKey::DefaultPayoff, &payoff);
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
    pub fn add_admin(e: &Env, admin: Address) {
        e.storage()
            .instance()
            .set(&DataKey::Admin(admin.clone()), &true);

        GovAdminAdded { admin }.publish(e);
    }

    #[only_owner]
    pub fn remove_admin(e: &Env, admin: Address) {
        e.storage().instance().remove(&DataKey::Admin(admin.clone()));

        GovAdminRemoved { admin }.publish(e);
    }

    // --- Owner or Admin: route lifecycle ---

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

    pub fn enable_route(
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
    pub fn remove_route(
        e: &Env,
        caller: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
    ) {
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
    pub fn route_status(
        e: &Env,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
    ) -> RouteStatus {
        let key = DataKey::Route(flight_id, origin, dest);
        let terms: Option<RouteTerms> = e.storage().persistent().get(&key);
        match terms {
            None => RouteStatus::Unknown,
            Some(t) if !t.approved => RouteStatus::Disabled,
            Some(t) => RouteStatus::Active(resolve(&t, read_defaults(e))),
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

#[cfg(test)]
mod test;
