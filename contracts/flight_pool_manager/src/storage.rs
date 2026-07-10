use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

use sentinel_types::ttl::{
    deadline_extension_ledgers, PERSISTENT_TTL_EXTEND, PERSISTENT_TTL_THRESHOLD,
};

// Cross-contract types live in the shared `sentinel_types` crate.
pub use sentinel_types::{FlightConfig, SettlementStatus};

#[contracttype]
#[derive(Clone)]
pub enum PoolKey {
    // Instance — global config & accounting
    Controller,
    AssetToken,
    RiskVault,
    ActiveFlightList,
    RecoveredBalance,

    // Persistent — keyed by (flight_id, date)
    FlightConfig(Symbol, u64),

    // Persistent — keyed by (flight_id, date, address)
    Buyer(Symbol, u64, Address),
    Claimed(Symbol, u64, Address),
}

pub(crate) fn extend_flight_ttl(e: &Env, flight_id: &Symbol, date: u64) {
    let key = PoolKey::FlightConfig(flight_id.clone(), date);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

// Extend FlightConfig TTL to cover a deadline (claim window, or the flight date
// itself pre-settlement) + safety buffer. Never shortens: floors at
// PERSISTENT_TTL_EXTEND; clamped to the network max. The ledger math lives in
// `sentinel_types::ttl` and is shared with the oracle's per-flight sizing.
pub(crate) fn extend_flight_ttl_to(e: &Env, flight_id: &Symbol, date: u64, deadline_secs: u64) {
    let extend_to = deadline_extension_ledgers(e.ledger().timestamp(), deadline_secs);

    let key = PoolKey::FlightConfig(flight_id.clone(), date);
    // Use `extend_to` as the threshold, NOT the ~7-day
    // PERSISTENT_TTL_THRESHOLD. `extend_ttl` only acts when the current TTL is
    // below the threshold; with the small threshold a config settled soon after
    // purchase (still holding ~31 days of TTL) was skipped entirely, so the
    // intended claim-window extension silently no-op'd and the entry could
    // archive before the claim window closed. Equal threshold/target forces the
    // extension whenever the current TTL is short of the required lifetime.
    e.storage()
        .persistent()
        .extend_ttl(&key, extend_to, extend_to);
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
        // Swap-remove instead of `Vec::remove`, which shifts every
        // trailing element. The active list is an unordered set, so moving the
        // last entry into the gap and popping the tail is O(1) and avoids
        // compounding shift cost when many flights settle in one call.
        let last = list.len() - 1;
        if i != last {
            let tail = list.get(last).unwrap();
            list.set(i, tail);
        }
        list.pop_back();
        e.storage()
            .instance()
            .set(&PoolKey::ActiveFlightList, &list);
    }
}
