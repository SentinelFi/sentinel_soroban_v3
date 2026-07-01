use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

use crate::constants::{MAX_TRAVELER_FLIGHTS, TRAVELER_FLIGHTS_TTL_LEDGERS};

#[contracttype]
pub enum CtrlKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Governance,
    RiskVault,
    Oracle,
    FlightPoolManager,
    AssetToken,
    AuthorizedKeeper,
    SolvencyRatio,
    MinLeadTime,
    ClaimExpiryWindow,
    TotalPoliciesSold,
    TotalPremiumsCollected,
    TotalPayoutsDistributed,
    WhitelistEnabled, // bool — Phase 11 buyer whitelist kill-switch
    ClassifyCursor,   // u32 — rotating index into the oracle active list
    SettleCursor,     // u32 — rotating index into the oracle active list

    // Persistent — keyed multi-row state
    TravelerFlights(Address),  // Vec<(Symbol, u64)>
    BuyerWhitelisted(Address), // bool — Phase 11 buyer whitelist entry
}

pub(crate) fn append_traveler_flight(e: &Env, traveler: &Address, flight_id: &Symbol, date: u64) {
    let key = CtrlKey::TravelerFlights(traveler.clone());
    let mut list: Vec<(Symbol, u64)> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
    // Bound the append-only index so it can't grow into the persistent
    // entry-size limit and, since the append is on the buy path, permanently
    // block the address from purchasing. When full, evict the oldest entry
    // (keep the most recent MAX_TRAVELER_FLIGHTS) instead of blocking the buy —
    // this is a convenience index, and full history is derivable from events.
    if list.len() >= MAX_TRAVELER_FLIGHTS {
        list.remove(0);
    }
    list.push_back((flight_id.clone(), date));
    e.storage().persistent().set(&key, &list);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}

pub(crate) fn write_buyer_whitelisted(e: &Env, addr: &Address, allowed: bool) {
    let key = CtrlKey::BuyerWhitelisted(addr.clone());
    e.storage().persistent().set(&key, &allowed);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}

pub(crate) fn read_buyer_whitelisted(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&CtrlKey::BuyerWhitelisted(addr.clone()))
        .unwrap_or(false)
}

/// Refresh an existing whitelist entry's TTL. Called from the
/// buy_insurance gate so an actively-buying approved address keeps its approval
/// alive on its own (the bare read in `read_buyer_whitelisted` cannot, and a
/// frequent buyer should never have to be re-approved). No-op if the entry is
/// absent.
pub(crate) fn touch_buyer_whitelisted(e: &Env, addr: &Address) {
    let key = CtrlKey::BuyerWhitelisted(addr.clone());
    if e.storage().persistent().has(&key) {
        e.storage().persistent().extend_ttl(
            &key,
            TRAVELER_FLIGHTS_TTL_LEDGERS,
            TRAVELER_FLIGHTS_TTL_LEDGERS,
        );
    }
}

pub(crate) fn read_whitelist_enabled(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&CtrlKey::WhitelistEnabled)
        .unwrap_or(false)
}
