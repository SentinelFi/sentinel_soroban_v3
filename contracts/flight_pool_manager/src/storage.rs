use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

#[contracttype]
#[derive(Clone)]
pub enum PoolKey {
    // Instance — global config & accounting
    Controller,
    UsdcToken,
    RiskVault,
    ActiveFlightList,
    RecoveredBalance,

    // Persistent — keyed by (flight_id, date)
    FlightConfig(Symbol, u64),

    // Persistent — keyed by (flight_id, date, address)
    Buyer(Symbol, u64, Address),
    Claimed(Symbol, u64, Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlightConfig {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
    pub buyer_count: u32,
    pub claimed_count: u32,
    pub status: SettlementStatus,
    pub claim_expiry: u64,
}

pub(crate) const PERSISTENT_TTL_THRESHOLD: u32 = 120_960; // ~7 days
pub(crate) const PERSISTENT_TTL_EXTEND: u32 = 535_680; // ~31 days

// Buyer key TTL: 180 days at add_buyer time.
// Architecture says "claim_expiry + 30d on write" but add_buyer runs before
// settlement, so claim_expiry is unknown at write time. 180 days covers worst
// case 90d flight book-ahead + 60d claim window + 30d safety. No re-extension
// needed because the contract cannot iterate buyers after settlement.
// 180 days at 5s/ledger = 180 * 24 * 60 * 12 = 3,110,400.
pub(crate) const BUYER_TTL_LEDGERS: u32 = 3_110_400;

pub(crate) fn extend_flight_ttl(e: &Env, flight_id: &Symbol, date: u64) {
    let key = PoolKey::FlightConfig(flight_id.clone(), date);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

pub(crate) fn prune_active_list(e: &Env, flight_id: &Symbol, date: u64) {
    let mut list: Vec<(Symbol, u64)> = e
        .storage()
        .instance()
        .get(&PoolKey::ActiveFlightList)
        .unwrap_or(Vec::new(e));
    let target = (flight_id.clone(), date);
    let mut idx: Option<u32> = None;
    for i in 0..list.len() {
        if list.get(i) == Some(target.clone()) {
            idx = Some(i);
            break;
        }
    }
    if let Some(i) = idx {
        list.remove(i);
        e.storage()
            .instance()
            .set(&PoolKey::ActiveFlightList, &list);
    }
}
