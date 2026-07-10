//! Flight-status state machine: oracle-only outcome writes, controller-only
//! registration/classification/settlement, and the permissionless pruning of
//! aged-out settled flights from the active list.

use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol, Vec};
use stellar_macros::when_not_paused;

use crate::auth::{extend_instance_ttl, require_controller, require_oracle};
use crate::constants::{
    MAX_ACTIVE_FLIGHTS, MAX_PRUNE_BATCH, SECONDS_PER_DAY, SETTLED_RETENTION_DAYS,
};
use crate::events::{emit_status_event, MissingFlightDataPruned};
use crate::storage::{
    decrement_pending_outcomes, extend_flight_ttl_to, increment_pending_outcomes,
    is_valid_transition, OracleKey,
};
use crate::{
    Error, FlightData, FlightStatus, OracleAggregator, OracleAggregatorArgs, OracleAggregatorClient,
};

#[contractimpl]
impl OracleAggregator {
    // --- Oracle-only write functions ---

    /// Set estimated arrival time. Transitions NotInitiated → Active.
    #[when_not_paused]
    pub fn set_estimated_arrival(
        e: &Env,
        oracle: Address,
        flight_id: Symbol,
        date: u64,
        estimated_arrival_time: u64,
    ) {
        require_oracle(e, &oracle);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        if !(is_valid_transition(&data.status, &FlightStatus::Active)) {
            panic_with_error!(e, Error::InvalidTransition);
        }

        data.status = FlightStatus::Active;
        data.estimated_arrival_time = estimated_arrival_time;
        e.storage().persistent().set(&key, &data);

        extend_flight_ttl_to(e, &flight_id, date, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::Active);
    }

    /// Set actual arrival time. Transitions Active → Landed.
    #[when_not_paused]
    pub fn set_landed(
        e: &Env,
        oracle: Address,
        flight_id: Symbol,
        date: u64,
        actual_arrival_time: u64,
    ) {
        require_oracle(e, &oracle);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        if !(is_valid_transition(&data.status, &FlightStatus::Landed)) {
            panic_with_error!(e, Error::InvalidTransition);
        }
        // Do NOT reject `actual_arrival_time < estimated_arrival_time`.
        // Early arrivals are legitimate flight outcomes; rejecting them left such
        // flights stuck `Active` forever (never classifiable/settleable, collateral
        // locked indefinitely). The authorized oracle is trusted to report truthful
        // times, and downstream delay math (`classify_flights`) already saturates a
        // negative delay to zero, classifying an early/on-time arrival correctly.

        data.status = FlightStatus::Landed;
        data.actual_arrival_time = actual_arrival_time;
        e.storage().persistent().set(&key, &data);

        // Outcome is now public but not yet financially settled.
        increment_pending_outcomes(e);
        extend_flight_ttl_to(e, &flight_id, date, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::Landed);
    }

    /// Mark flight as cancelled. Transitions Active → Cancelled.
    #[when_not_paused]
    pub fn set_cancelled(e: &Env, oracle: Address, flight_id: Symbol, date: u64) {
        require_oracle(e, &oracle);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        if !(is_valid_transition(&data.status, &FlightStatus::Cancelled)) {
            panic_with_error!(e, Error::InvalidTransition);
        }

        data.status = FlightStatus::Cancelled;
        e.storage().persistent().set(&key, &data);

        // Outcome is now public but not yet financially settled.
        increment_pending_outcomes(e);
        extend_flight_ttl_to(e, &flight_id, date, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::Cancelled);
    }

    // --- Controller-only write functions ---

    /// Register a flight. Idempotent: re-registering the same
    /// `(flight_id, date)` is a no-op — only the TTL is
    /// extended, no event is re-emitted.
    #[when_not_paused]
    pub fn register_flight(e: &Env, controller: Address, flight_id: Symbol, date: u64) {
        require_controller(e, &controller);
        extend_instance_ttl(e);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        if e.storage().persistent().has(&key) {
            extend_flight_ttl_to(e, &flight_id, date, date);
            return;
        }

        let data = FlightData {
            status: FlightStatus::NotInitiated,
            estimated_arrival_time: 0,
            actual_arrival_time: 0,
            settled_at: 0,
        };
        e.storage().persistent().set(&key, &data);

        // Append to active flight list (Instance — auto-extended with contract instance TTL)
        let mut flights: Vec<(Symbol, u64)> = e
            .storage()
            .instance()
            .get(&OracleKey::ActiveFlightList)
            .unwrap_or(Vec::new(e));
        // Bound the single-vector active list so it can't grow into the
        // contract-instance entry-size limit and become unwritable. Settled
        // flights are evicted by prune_settled, freeing capacity.
        if flights.len() >= MAX_ACTIVE_FLIGHTS {
            panic_with_error!(e, Error::ActiveFlightListFull);
        }
        flights.push_back((flight_id.clone(), date));
        e.storage()
            .instance()
            .set(&OracleKey::ActiveFlightList, &flights);

        extend_flight_ttl_to(e, &flight_id, date, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::NotInitiated);
    }

    /// Classify a flight for settlement. Transitions Landed/Cancelled → ToBeSettled*.
    #[when_not_paused]
    pub fn set_to_be_settled(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        status: FlightStatus,
    ) {
        require_controller(e, &controller);

        if !(matches!(
            status,
            FlightStatus::ToBeSettledOnTime
                | FlightStatus::ToBeSettledDelayed
                | FlightStatus::ToBeSettledCancelled
        )) {
            panic_with_error!(e, Error::InvalidSettlementStatus);
        }

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        if !(is_valid_transition(&data.status, &status)) {
            panic_with_error!(e, Error::InvalidTransition);
        }

        data.status = status.clone();
        e.storage().persistent().set(&key, &data);

        extend_flight_ttl_to(e, &flight_id, date, date);
        emit_status_event(e, &flight_id, date, &status);
    }

    /// Mark flight as settled. Transitions ToBeSettled* → Settled.
    /// Records `settled_at` so the delayed-prune window starts ticking.
    /// Does NOT remove the flight from `ActiveFlightList` — eviction is
    /// delegated to the permissionless `prune_settled` entry, which only
    /// removes entries older than `SETTLED_RETENTION_DAYS`. Does NOT renew
    /// flight TTL — settled entries naturally expire.
    #[when_not_paused]
    pub fn set_settled(e: &Env, controller: Address, flight_id: Symbol, date: u64) {
        require_controller(e, &controller);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        if !(is_valid_transition(&data.status, &FlightStatus::Settled)) {
            panic_with_error!(e, Error::InvalidTransition);
        }

        data.status = FlightStatus::Settled;
        data.settled_at = e.ledger().timestamp();
        e.storage().persistent().set(&key, &data);

        // Pending PnL for this flight is now recognized in the vault.
        decrement_pending_outcomes(e);
        emit_status_event(e, &flight_id, date, &FlightStatus::Settled);
    }

    // --- Permissionless housekeeping ---

    /// Remove settled flights from `ActiveFlightList` once they have been
    /// settled for at least `SETTLED_RETENTION_DAYS`. Permissionless —
    /// anyone may call (matches `flight_pool_manager::sweep_expired`
    /// pattern). Idempotent: re-callable with no panic; no-op if nothing
    /// has aged out.
    pub fn prune_settled(e: &Env) {
        let now = e.ledger().timestamp();
        let list: Vec<(Symbol, u64)> = e
            .storage()
            .instance()
            .get(&OracleKey::ActiveFlightList)
            .unwrap_or(Vec::new(e));

        let len = list.len();
        if len == 0 {
            extend_instance_ttl(e);
            return;
        }

        // Only inspect a bounded window [cursor, cursor+batch) of
        // the list per call. Entries outside the window are kept untouched (no
        // persistent lookup), bounding the expensive storage reads. The cursor
        // rotates across calls so the whole list is eventually swept.
        let mut cursor: u32 = e
            .storage()
            .instance()
            .get(&OracleKey::PruneCursor)
            .unwrap_or(0);
        if cursor >= len {
            cursor = 0;
        }
        let stop = cursor.saturating_add(MAX_PRUNE_BATCH).min(len);

        let mut kept: Vec<(Symbol, u64)> = Vec::new(e);
        let mut removed_any = false;
        for i in 0..len {
            let entry = list.get(i).unwrap();
            if i < cursor || i >= stop {
                // Outside the inspection window — carry over without a lookup.
                kept.push_back(entry);
                continue;
            }
            let flight_id = entry.0.clone();
            let date = entry.1;
            let aged_out = match e
                .storage()
                .persistent()
                .get::<_, FlightData>(&OracleKey::FlightData(flight_id.clone(), date))
            {
                None => {
                    // FlightData archived past its TTL. Keep the
                    // prior evict behavior (a missing entry is unrecoverable
                    // on-chain and would block pruning forever) but
                    // surface it via a diagnostic so it is no longer silent.
                    MissingFlightDataPruned {
                        flight_id: flight_id.clone(),
                        date,
                    }
                    .publish(e);
                    true
                }
                Some(data) => {
                    let age_seconds = now.saturating_sub(data.settled_at);
                    data.status == FlightStatus::Settled
                        && data.settled_at != 0
                        && age_seconds >= SETTLED_RETENTION_DAYS * SECONDS_PER_DAY
                }
            };
            if aged_out {
                removed_any = true;
            } else {
                kept.push_back(entry);
            }
        }

        if removed_any {
            e.storage()
                .instance()
                .set(&OracleKey::ActiveFlightList, &kept);
        }
        // Advance (wrap at end). Indices shift after removals, but pruning is
        // idempotent and re-callable, so eventual full coverage still holds.
        let next_cursor = if stop >= len { 0 } else { stop };
        e.storage()
            .instance()
            .set(&OracleKey::PruneCursor, &next_cursor);
        extend_instance_ttl(e);
    }
}
