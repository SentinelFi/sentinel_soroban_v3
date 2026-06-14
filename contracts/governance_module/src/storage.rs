use soroban_sdk::{contracttype, panic_with_error, Address, Env, Symbol};

use crate::Error;

// Cross-contract types live in the shared `sentinel_types` crate so the
// governance contract and the controller's mirror reference the same XDR
// layout. Re-exported below for downstream-compatibility.
pub use sentinel_types::{ResolvedTerms, RouteStatus};

#[contracttype]
pub enum DataKey {
    Admin(Address),                // bool — Instance
    DefaultPremium,                // i128 — Instance
    DefaultPayoff,                 // i128 — Instance
    DefaultDelayHours,             // u32 — Instance
    Route(Symbol, Symbol, Symbol), // RouteTerms — Persistent
    // Audit V12-CF-05: flight_id → (origin, dest) uniqueness index. Downstream
    // pool/oracle state is keyed only by (flight_id, date), so two approved
    // routes sharing a flight_id but differing in origin/dest would collide.
    // A flight number on a date is one physical flight, so we enforce a single
    // (origin, dest) per flight_id at whitelist time. Persistent.
    FlightRoute(Symbol), // (Symbol, Symbol) — Persistent
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

// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800.
// Applied on every Route(...) write to keep actively edited routes from
// archival drift; idle routes are extended by the off-chain TTL cron which
// folds Route(...) keys into its ExtendFootprintTTLOp footprint using the
// indexer's enumeration.
pub(crate) const ROUTE_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;

pub(crate) fn extend_route_ttl(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, ROUTE_TTL_LEDGERS, ROUTE_TTL_LEDGERS);
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

// Enforce the invariants every economically-meaningful route must satisfy:
// premium > 0, payoff > premium, delay_hours > 0. Called at write time after
// defaults are folded in, so partial overrides cannot leave a route with a
// non-paying or guaranteed-payout configuration.
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
}

pub(crate) fn assert_route_terms_valid(e: &Env, terms: &RouteTerms) {
    let resolved = resolve_terms(terms, read_defaults(e));
    assert_terms_valid(e, resolved.premium, resolved.payoff, resolved.delay_hours);
}
