use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

#[contracttype]
pub enum CtrlKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Governance,
    RiskVault,
    Oracle,
    FlightPoolManager,
    UsdcToken,
    AuthorizedKeeper,
    SolvencyRatio,
    MinLeadTime,
    ClaimExpiryWindow,
    TotalPoliciesSold,
    TotalPremiumsCollected,
    TotalPayoutsDistributed,

    // Persistent — keyed multi-row state
    TravelerFlights(Address), // Vec<(Symbol, u64)>
}

// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800. Applied on every
// `TravelerFlights(addr)` write to keep the per-traveler index alive without
// special cron coverage; the off-chain TTL cron extends idle entries for
// active travelers.
pub(crate) const TRAVELER_FLIGHTS_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;

pub(crate) fn append_traveler_flight(e: &Env, traveler: &Address, flight_id: &Symbol, date: u64) {
    let key = CtrlKey::TravelerFlights(traveler.clone());
    let mut list: Vec<(Symbol, u64)> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
    list.push_back((flight_id.clone(), date));
    e.storage().persistent().set(&key, &list);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}
