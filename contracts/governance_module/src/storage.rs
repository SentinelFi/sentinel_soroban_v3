use soroban_sdk::{contracttype, Address, Env, Symbol};

#[contracttype]
pub enum DataKey {
    Admin(Address),                // bool — Instance
    DefaultPremium,                // i128 — Instance
    DefaultPayoff,                 // i128 — Instance
    DefaultDelayHours,             // u32 — Instance
    Route(Symbol, Symbol, Symbol), // RouteTerms — Persistent
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
    let premium: i128 = e.storage().instance().get(&DataKey::DefaultPremium).unwrap();
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
pub(crate) fn assert_terms_valid(premium: i128, payoff: i128, delay_hours: u32) {
    assert!(premium > 0, "premium must be positive");
    assert!(payoff > 0, "payoff must be positive");
    assert!(payoff > premium, "payoff must exceed premium");
    assert!(delay_hours > 0, "delay_hours must be positive");
}

pub(crate) fn assert_route_terms_valid(e: &Env, terms: &RouteTerms) {
    let resolved = resolve_terms(terms, read_defaults(e));
    assert_terms_valid(resolved.premium, resolved.payoff, resolved.delay_hours);
}
