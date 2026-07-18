use soroban_sdk::{contracttype, Address, Env, Symbol};

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

// Remove a settled flight from the paginated active set. Tolerant of an
// absent or unreachable entry (e.g. its page or index archived — `remove`
// returns false) so settlement completes rather than reverting. `remove`
// swap-moves the globally last entry into the freed slot — O(1), and
// consumers already treat the set as unordered.
pub(crate) fn prune_active_list(e: &Env, flight_id: &Symbol, date: u64) {
    sentinel_types::active_set::remove(e, flight_id, date);
}
