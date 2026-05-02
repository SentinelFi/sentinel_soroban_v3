#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Env, Symbol, Vec};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

#[contracttype]
pub enum DataKey {
    Admin(Address),
    DefaultPremium,
    DefaultPayoff,
    DefaultDelayHours,
    Route(Symbol, Symbol, Symbol),
    RouteList,
}

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

use soroban_sdk::Address;

#[contract]
pub struct GovernanceModule;

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

    // --- Owner-only functions ---

    #[only_owner]
    pub fn set_defaults(
        e: &Env,
        premium: i128,
        payoff: i128,
        delay_hours: u32,
    ) {
        e.storage()
            .instance()
            .set(&DataKey::DefaultPremium, &premium);
        e.storage()
            .instance()
            .set(&DataKey::DefaultPayoff, &payoff);
        e.storage()
            .instance()
            .set(&DataKey::DefaultDelayHours, &delay_hours);
    }

    #[only_owner]
    pub fn add_admin(e: &Env, admin: Address) {
        e.storage()
            .instance()
            .set(&DataKey::Admin(admin), &true);
    }

    #[only_owner]
    pub fn remove_admin(e: &Env, admin: Address) {
        e.storage().instance().remove(&DataKey::Admin(admin));
    }

    // --- Owner or Admin functions ---

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

        // Append to route list if not already present
        let mut routes: Vec<(Symbol, Symbol, Symbol)> = e
            .storage()
            .persistent()
            .get(&DataKey::RouteList)
            .unwrap_or(Vec::new(e));

        let route_tuple = (flight_id, origin, dest);
        let mut found = false;
        for i in 0..routes.len() {
            if routes.get(i) == Some(route_tuple.clone()) {
                found = true;
                break;
            }
        }
        if !found {
            routes.push_back(route_tuple);
            e.storage().persistent().set(&DataKey::RouteList, &routes);
        }
    }

    pub fn disable_route(
        e: &Env,
        caller: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
    ) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id, origin, dest);
        let mut terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not found");
        terms.approved = false;
        e.storage().persistent().set(&key, &terms);
    }

    pub fn update_route_terms(
        e: &Env,
        caller: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
        new_premium: Option<i128>,
        new_payoff: Option<i128>,
        new_delay_hours: Option<u32>,
    ) {
        require_owner_or_admin(e, &caller);

        let key = DataKey::Route(flight_id, origin, dest);
        let mut terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not found");
        terms.premium = new_premium;
        terms.payoff = new_payoff;
        terms.delay_hours = new_delay_hours;
        e.storage().persistent().set(&key, &terms);
    }

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(120_960, 535_680);
    }

    // --- Read functions ---

    pub fn get_defaults(e: &Env) -> (i128, i128, u32) {
        let premium: i128 = e.storage().instance().get(&DataKey::DefaultPremium).unwrap();
        let payoff: i128 = e.storage().instance().get(&DataKey::DefaultPayoff).unwrap();
        let delay_hours: u32 = e
            .storage()
            .instance()
            .get(&DataKey::DefaultDelayHours)
            .unwrap();
        (premium, payoff, delay_hours)
    }

    pub fn get_whitelisted_routes(e: &Env) -> Vec<(Symbol, Symbol, Symbol)> {
        e.storage()
            .persistent()
            .get(&DataKey::RouteList)
            .unwrap_or(Vec::new(e))
    }

    pub fn is_route_whitelisted(
        e: &Env,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
    ) -> bool {
        let key = DataKey::Route(flight_id, origin, dest);
        e.storage()
            .persistent()
            .get::<_, RouteTerms>(&key)
            .map(|t| t.approved)
            .unwrap_or(false)
    }

    pub fn get_route_terms(
        e: &Env,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
    ) -> ResolvedTerms {
        let key = DataKey::Route(flight_id, origin, dest);
        let terms: RouteTerms = e
            .storage()
            .persistent()
            .get(&key)
            .expect("route not found");
        assert!(terms.approved, "route is disabled");

        let (default_premium, default_payoff, default_delay_hours) = Self::get_defaults(e);

        ResolvedTerms {
            premium: terms.premium.unwrap_or(default_premium),
            payoff: terms.payoff.unwrap_or(default_payoff),
            delay_hours: terms.delay_hours.unwrap_or(default_delay_hours),
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
