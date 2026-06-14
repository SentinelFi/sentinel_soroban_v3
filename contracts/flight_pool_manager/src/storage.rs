use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

// Cross-contract types live in the shared `sentinel_types` crate.
pub use sentinel_types::{FlightConfig, SettlementStatus};

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

pub(crate) const PERSISTENT_TTL_THRESHOLD: u32 = 120_960; // ~7 days
pub(crate) const PERSISTENT_TTL_EXTEND: u32 = 535_680; // ~31 days

// Buffer past claim_expiry: 30 days. Combined with claim_expiry_window (default
// 60d), gives ~90 days of post-settle TTL on FlightConfig — long enough that a
// cron lapse cannot archive the entry while a buyer can still claim.
pub(crate) const TTL_BUFFER_LEDGERS: u32 = 518_400; // ~30 days at 5s/ledger
pub(crate) const LEDGERS_PER_SECOND_NUM: u64 = 1;
pub(crate) const LEDGERS_PER_SECOND_DEN: u64 = 5; // ~5 s per ledger on mainnet

// Buyer key TTL: 180 days at add_buyer time.
// Architecture says "claim_expiry + 30d on write" but add_buyer runs before
// settlement, so claim_expiry is unknown at write time. 180 days covers worst
// case 90d flight book-ahead + 60d claim window + 30d safety. No re-extension
// needed because the contract cannot iterate buyers after settlement.
// 180 days at 5s/ledger = 180 * 24 * 60 * 12 = 3,110,400.
pub(crate) const BUYER_TTL_LEDGERS: u32 = 3_110_400;

// ~180 days = Stellar's maximum persistent-entry TTL. extend_ttl panics if the
// target exceeds the network max, so any computed extension is clamped to this.
pub(crate) const MAX_PERSISTENT_TTL_LEDGERS: u32 = 3_110_400;

pub(crate) fn extend_flight_ttl(e: &Env, flight_id: &Symbol, date: u64) {
    let key = PoolKey::FlightConfig(flight_id.clone(), date);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

// Extend FlightConfig TTL to cover a deadline (claim window, or the flight date
// itself pre-settlement) + safety buffer. Never shortens: floors at
// PERSISTENT_TTL_EXTEND; clamped to the network max.
pub(crate) fn extend_flight_ttl_to(e: &Env, flight_id: &Symbol, date: u64, deadline_secs: u64) {
    let now = e.ledger().timestamp();
    let secs_remaining = deadline_secs.saturating_sub(now);
    let ledgers_remaining =
        secs_remaining.saturating_mul(LEDGERS_PER_SECOND_NUM) / LEDGERS_PER_SECOND_DEN;
    let ledgers_remaining_u32 = u32::try_from(ledgers_remaining).unwrap_or(u32::MAX);
    let extend_to = ledgers_remaining_u32
        .saturating_add(TTL_BUFFER_LEDGERS)
        .clamp(PERSISTENT_TTL_EXTEND, MAX_PERSISTENT_TTL_LEDGERS);

    let key = PoolKey::FlightConfig(flight_id.clone(), date);
    // Audit V12-CF-02: use `extend_to` as the threshold, NOT the ~7-day
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
        // Audit VF-14: swap-remove instead of `Vec::remove`, which shifts every
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
