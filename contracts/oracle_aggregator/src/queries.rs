//! Read-only views over flight data and the active flight list.

use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};

use crate::storage::OracleKey;
use crate::{
    FlightData, FlightStatus, OracleAggregator, OracleAggregatorArgs, OracleAggregatorClient,
};

#[contractimpl]
impl OracleAggregator {
    /// Get flight data. Returns NotInitiated with zero timestamps for missing entries.
    pub fn get_flight_data(e: &Env, flight_id: Symbol, date: u64) -> FlightData {
        let key = OracleKey::FlightData(flight_id, date);
        e.storage().persistent().get(&key).unwrap_or(FlightData {
            status: FlightStatus::NotInitiated,
            estimated_arrival_time: 0,
            actual_arrival_time: 0,
            settled_at: 0,
        })
    }

    /// Get all registered flights (the whole paginated active set).
    ///
    /// Footprint grows with the set's page count (one ledger entry per ~100
    /// flights), so this is an off-chain / simulation convenience — bounded
    /// on-chain callers (the controller keeper) use
    /// `get_active_flights_page` instead.
    pub fn get_active_flights(e: &Env) -> Vec<(Symbol, u64)> {
        sentinel_types::active_set::get_all(e)
    }

    /// Up to `limit` active-set entries starting at slot `offset`. The
    /// bounded enumeration for on-chain callers: a window touches at most
    /// two page entries. The set is unordered and removal reshuffles slots,
    /// so callers iterate with idempotent, re-callable rotating cursors.
    pub fn get_active_flights_page(e: &Env, offset: u32, limit: u32) -> Vec<(Symbol, u64)> {
        sentinel_types::active_set::get_range(e, offset, limit)
    }

    /// Whether `(flight_id, date)` is currently in the active set. Exact
    /// even if the set's reverse index archived (falls back to a page scan);
    /// the controller's evicted-flight reconciliation gate relies on that
    /// exactness.
    pub fn is_flight_listed(e: &Env, flight_id: Symbol, date: u64) -> bool {
        sentinel_types::active_set::contains(e, &flight_id, date)
    }

    /// Number of entries in the active set — O(1) from the stored count.
    /// Cheap saturation gauge for operators: the set is capped (a sanity
    /// bound, no longer a storage-entry limit), so occupancy approaching the
    /// cap means new-flight registration (and thus first purchases) is about
    /// to be rejected — prune promptly or investigate before that happens.
    pub fn get_active_flight_count(e: &Env) -> u32 {
        sentinel_types::active_set::count(e)
    }

    /// Whether a `FlightData` entry physically exists for this key. Lets
    /// callers distinguish a genuinely unregistered flight from one whose
    /// entry archived past its TTL — `get_flight_data` reports both as
    /// `NotInitiated`, but an archived entry is restorable and may still
    /// have unresolved settlement riding on it.
    pub fn has_flight_data(e: &Env, flight_id: Symbol, date: u64) -> bool {
        e.storage()
            .persistent()
            .has(&OracleKey::FlightData(flight_id, date))
    }

    /// Whether the sale window for `(flight_id, date)` is currently open:
    /// a sale authorization exists and its expiry timestamp is still in the
    /// future. The controller's purchase gate consumes this — no live
    /// authorization means no sale. Fails closed on every degraded state:
    /// never written, explicitly closed, lapsed past its expiry timestamp,
    /// or archived out of temporary storage.
    pub fn is_sale_open(e: &Env, flight_id: Symbol, date: u64) -> bool {
        match e
            .storage()
            .temporary()
            .get::<_, u64>(&OracleKey::SaleAuth(flight_id, date))
        {
            Some(expires_at) => e.ledger().timestamp() < expires_at,
            None => false,
        }
    }

    /// Expiry timestamp of the sale authorization for `(flight_id, date)`,
    /// or None if none is live. Off-chain convenience (frontends show the
    /// purchase deadline, the executor decides which authorizations need a
    /// refresh); the on-chain gate is `is_sale_open`.
    pub fn get_sale_auth(e: &Env, flight_id: Symbol, date: u64) -> Option<u64> {
        e.storage()
            .temporary()
            .get(&OracleKey::SaleAuth(flight_id, date))
    }

    /// Get flights filtered by status. Iterates active list and filters.
    ///
    /// Unbounded: performs one persistent read per active-list entry, so its
    /// footprint grows with the list. Intended for off-chain / read-only
    /// simulation use (frontends, executor) — on-chain callers must not
    /// invoke it; the keeper entry points iterate with bounded batches
    /// instead.
    pub fn get_flights_by_status(e: &Env, status: FlightStatus) -> Vec<(Symbol, u64)> {
        let all = Self::get_active_flights(e);
        let mut result = Vec::new(e);

        for i in 0..all.len() {
            if let Some((flight_id, date)) = all.get(i) {
                let data = Self::get_flight_data(e, flight_id.clone(), date);
                if data.status == status {
                    result.push_back((flight_id, date));
                }
            }
        }

        result
    }

    // --- Admin read functions ---

    /// Get the authorized oracle address. Panics if not set.
    pub fn get_authorized_oracle(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&OracleKey::AuthorizedOracle)
            .expect("oracle not set")
    }

    /// Get the authorized controller address, or None if not yet set.
    pub fn get_authorized_controller(e: &Env) -> Option<Address> {
        e.storage().instance().get(&OracleKey::AuthorizedController)
    }

    /// Number of flights whose outcome is publicly recorded but not yet settled.
    pub fn get_pending_outcomes(e: &Env) -> u64 {
        e.storage()
            .instance()
            .get(&OracleKey::PendingOutcomes)
            .unwrap_or(0)
    }

    /// Whether any flight outcome is public but not yet financially settled.
    /// The vault reads this to block entry/exit while pending PnL is
    /// unrecognized, so LPs cannot transact at a stale share price.
    pub fn has_pending_outcomes(e: &Env) -> bool {
        Self::get_pending_outcomes(e) > 0
    }
}
