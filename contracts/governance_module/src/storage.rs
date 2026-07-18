use soroban_sdk::{contracttype, panic_with_error, Address, Env, Symbol};

use crate::Error;

// Cross-contract types live in the shared `sentinel_types` crate so the
// governance contract and the controller's mirror reference the same XDR
// layout. Re-exported below for downstream-compatibility.
pub use sentinel_types::{ResolvedTerms, RouteStatus};

#[contracttype]
pub enum DataKey {
    // Admin flags live in Instance storage, which is a single shared ledger
    // entry — every admin added grows that entry for all invocations. The
    // admin set is expected to stay small (a handful of operator addresses);
    // it is a trusted-role roster, not an open registry. If the operating
    // model ever calls for dozens of admins, migrate these to per-address
    // Persistent keys first.
    Admin(Address),                // bool — Instance
    DefaultPremium,                // i128 — Instance
    DefaultPayoff,                 // i128 — Instance
    DefaultDelayHours,             // u32 — Instance
    Route(Symbol, Symbol, Symbol), // RouteTerms — Persistent
    // flight_id → (origin, dest) uniqueness index. Downstream
    // pool/oracle state is keyed only by (flight_id, date), so two approved
    // routes sharing a flight_id but differing in origin/dest would collide.
    // A flight number on a date is one physical flight, so we enforce a single
    // (origin, dest) per flight_id at whitelist time. Persistent.
    FlightRoute(Symbol), // (Symbol, Symbol) — Persistent
    // flight_id → (origin, dest, retired_until) marker written when a route is
    // removed. Blocks re-whitelisting the flight_id with a DIFFERENT
    // origin/dest until `retired_until`, so downstream (flight_id, date) state
    // from the removed route can age out before the id is remapped.
    // Re-adding the same route (undo) stays allowed. Persistent.
    RetiredFlight(Symbol), // (Symbol, Symbol, u64) — Persistent
    // Owner-configured magnitude bounds every route's resolved terms must
    // satisfy. Route writes are open to the admin role — deliberately weaker
    // than owner — so these cap the blast radius of one compromised admin
    // key: without them, a single signature could whitelist a dust-premium
    // route whose one policy commits the vault's entire free capital.
    MaxPayoff,      // i128 — absolute per-policy payoff ceiling; 0 disables. Instance.
    MaxPayoffRatio, // i128 — payoff <= premium * ratio; defaults to DEFAULT_MAX_PAYOFF_RATIO. Instance.
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RouteTerms {
    pub premium: Option<i128>,
    pub payoff: Option<i128>,
    pub delay_hours: Option<u32>,
    pub approved: bool,
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

pub(crate) fn extend_route_ttl(e: &Env, key: &DataKey) {
    use crate::constants::ROUTE_TTL_LEDGERS;
    e.storage()
        .persistent()
        .extend_ttl(key, ROUTE_TTL_LEDGERS, ROUTE_TTL_LEDGERS);
}

// Refresh the `FlightRoute(flight_id)` uniqueness-index TTL in lockstep with the
// route entry. Both keys are written with `ROUTE_TTL_LEDGERS` (120 days) at
// whitelist time; if only the route key were re-extended on reads/mutations,
// the index could archive while the route stayed live, after which a second
// `whitelist_route` would see no index and accept a conflicting (origin, dest)
// for the same flight_id, colliding downstream (flight_id, date) state. No-op
// if the index is absent (extend_ttl on a missing key would panic).
pub(crate) fn extend_route_index_ttl(e: &Env, flight_id: &Symbol) {
    use crate::constants::ROUTE_TTL_LEDGERS;
    let key = DataKey::FlightRoute(flight_id.clone());
    if e.storage().persistent().has(&key) {
        e.storage()
            .persistent()
            .extend_ttl(&key, ROUTE_TTL_LEDGERS, ROUTE_TTL_LEDGERS);
    }
}

pub(crate) fn read_defaults(e: &Env) -> (i128, i128, u32) {
    let premium: i128 = e
        .storage()
        .instance()
        .get(&DataKey::DefaultPremium)
        .unwrap();
    let payoff: i128 = e.storage().instance().get(&DataKey::DefaultPayoff).unwrap();
    let delay_hours: u32 = e
        .storage()
        .instance()
        .get(&DataKey::DefaultDelayHours)
        .unwrap();
    (premium, payoff, delay_hours)
}

pub(crate) fn resolve_terms(terms: &RouteTerms, defaults: (i128, i128, u32)) -> ResolvedTerms {
    let (default_premium, default_payoff, default_delay_hours) = defaults;
    ResolvedTerms {
        premium: terms.premium.unwrap_or(default_premium),
        payoff: terms.payoff.unwrap_or(default_payoff),
        delay_hours: terms.delay_hours.unwrap_or(default_delay_hours),
    }
}

// The owner-configured magnitude bounds route terms must satisfy:
// `(max_payoff, max_payoff_ratio)`. The absolute cap ships disabled (0)
// because it is denominated in asset units the contract cannot guess; the
// ratio bound is unit-free, so it defaults on and cannot be read as absent.
pub(crate) fn read_term_limits(e: &Env) -> (i128, i128) {
    let max_payoff: i128 = e.storage().instance().get(&DataKey::MaxPayoff).unwrap_or(0);
    let max_ratio: i128 = e
        .storage()
        .instance()
        .get(&DataKey::MaxPayoffRatio)
        .unwrap_or(crate::constants::DEFAULT_MAX_PAYOFF_RATIO);
    (max_payoff, max_ratio)
}

// Non-panicking mirror of `assert_terms_valid`. A partially-defaulted route is
// validated at write time, but the global defaults it inherits are mutable: a
// later `set_defaults` can leave an existing route resolving to economically
// invalid terms (e.g. payoff <= premium) with no revalidation — and a later
// `set_term_limits` can leave it exceeding the current magnitude bounds.
// `route_status` uses this to avoid advertising such a route as `Active`.
pub(crate) fn resolved_terms_valid(e: &Env, resolved: &ResolvedTerms) -> bool {
    let (max_payoff, max_ratio) = read_term_limits(e);
    resolved.premium > 0
        && resolved.payoff > 0
        && resolved.payoff > resolved.premium
        && resolved.delay_hours > 0
        && (max_payoff == 0 || resolved.payoff <= max_payoff)
        && resolved.payoff <= resolved.premium.saturating_mul(max_ratio)
}

// Enforce the invariants every economically-meaningful route must satisfy:
// premium > 0, payoff > premium, delay_hours > 0, and the owner-configured
// magnitude bounds. Called at write time after defaults are folded in, so
// partial overrides cannot leave a route with a non-paying or
// guaranteed-payout configuration.
pub(crate) fn assert_terms_valid(e: &Env, premium: i128, payoff: i128, delay_hours: u32) {
    if premium <= 0 {
        panic_with_error!(e, Error::PremiumMustBePositive);
    }
    if payoff <= 0 {
        panic_with_error!(e, Error::PayoffMustBePositive);
    }
    if payoff <= premium {
        panic_with_error!(e, Error::PayoffMustExceedPremium);
    }
    if delay_hours == 0 {
        panic_with_error!(e, Error::DelayHoursMustBePositive);
    }
    let (max_payoff, max_ratio) = read_term_limits(e);
    if max_payoff > 0 && payoff > max_payoff {
        panic_with_error!(e, Error::PayoffExceedsCap);
    }
    // Saturating: a premium large enough to saturate the product already
    // dwarfs any payoff, so saturation can never mask a violation that a
    // finite product would have caught.
    if payoff > premium.saturating_mul(max_ratio) {
        panic_with_error!(e, Error::PayoffExceedsPremiumRatio);
    }
}

pub(crate) fn assert_route_terms_valid(e: &Env, terms: &RouteTerms) {
    let resolved = resolve_terms(terms, read_defaults(e));
    assert_terms_valid(e, resolved.premium, resolved.payoff, resolved.delay_hours);
}
