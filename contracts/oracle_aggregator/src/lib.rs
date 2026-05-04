#![no_std]
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env, Symbol, Vec};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

// --- Storage keys ---

#[contracttype]
pub enum OracleKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    AuthorizedOracle,
    AuthorizedController,
    ActiveFlightList,

    // Persistent — keyed multi-row state
    FlightData(Symbol, u64),
}

// --- Domain types ---

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum FlightStatus {
    NotInitiated,
    Active,
    Landed,
    Cancelled,
    ToBeSettledOnTime,
    ToBeSettledDelayed,
    ToBeSettledCancelled,
    Settled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlightData {
    pub status: FlightStatus,
    pub estimated_arrival_time: u64,
    pub actual_arrival_time: u64,
    pub settled_at: u64,                   // 0 means not-yet-settled
}

// --- Error types ---

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OracleError {
    AlreadyInitialized,
    NotAuthorizedOracle,
    NotAuthorizedController,
    ControllerAlreadySet,
    InvalidTransition,
    InvalidSettlementStatus,
}

// --- TTL constants ---

const PERSISTENT_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const PERSISTENT_TTL_EXTEND: u32 = 535_680; // ~31 days
const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;

// --- Prune retention ---
//
// Settled flights stay in `ActiveFlightList` for SETTLED_RETENTION_DAYS after
// `set_settled` records their `settled_at` timestamp. Pruning is delegated to
// the permissionless `prune_settled` entry — keeps freshly-settled flights
// visible to off-chain monitoring / indexers / observability tooling for the
// retention window before they disappear from the list.
const SETTLED_RETENTION_DAYS: u64 = 30;
const SECONDS_PER_DAY: u64 = 86_400;

// --- Helpers ---

fn require_oracle(e: &Env, caller: &Address) {
    caller.require_auth();
    let oracle: Address = e
        .storage()
        .instance()
        .get(&OracleKey::AuthorizedOracle)
        .expect("oracle not set");
    assert!(caller == &oracle, "not authorized oracle");
}

fn require_controller(e: &Env, caller: &Address) {
    caller.require_auth();
    let controller: Address = e
        .storage()
        .instance()
        .get(&OracleKey::AuthorizedController)
        .expect("controller not set");
    assert!(caller == &controller, "not authorized controller");
}

fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

fn extend_flight_ttl(e: &Env, flight_id: &Symbol, date: u64) {
    let key = OracleKey::FlightData(flight_id.clone(), date);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

#[contractevent(topics = ["flight"], data_format = "single-value")]
pub struct FlightStatusChange {
    #[topic]
    flight_id: Symbol,
    #[topic]
    date: u64,
    new_status: FlightStatus,
}

fn emit_status_event(e: &Env, flight_id: &Symbol, date: u64, new_status: &FlightStatus) {
    FlightStatusChange {
        flight_id: flight_id.clone(),
        date,
        new_status: new_status.clone(),
    }
    .publish(e);
}

/// Check that a state transition is valid (forward-only state machine).
fn is_valid_transition(from: &FlightStatus, to: &FlightStatus) -> bool {
    matches!(
        (from, to),
        (FlightStatus::NotInitiated, FlightStatus::Active)
            | (FlightStatus::Active, FlightStatus::Landed)
            | (FlightStatus::Active, FlightStatus::Cancelled)
            | (FlightStatus::Landed, FlightStatus::ToBeSettledOnTime)
            | (FlightStatus::Landed, FlightStatus::ToBeSettledDelayed)
            | (FlightStatus::Cancelled, FlightStatus::ToBeSettledCancelled)
            | (FlightStatus::ToBeSettledOnTime, FlightStatus::Settled)
            | (FlightStatus::ToBeSettledDelayed, FlightStatus::Settled)
            | (FlightStatus::ToBeSettledCancelled, FlightStatus::Settled)
    )
}

// --- Contract ---

#[contract]
pub struct OracleAggregator;

#[contractimpl]
impl OracleAggregator {
    pub fn __constructor(e: &Env, owner: Address, authorized_oracle: Address) {
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&OracleKey::AuthorizedOracle, &authorized_oracle);
    }

    // --- Owner-only admin functions ---

    /// Set the authorized controller address. Can only be called once.
    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        let existing: Option<Address> = e
            .storage()
            .instance()
            .get(&OracleKey::AuthorizedController);
        assert!(existing.is_none(), "controller already set");

        e.storage()
            .instance()
            .set(&OracleKey::AuthorizedController, &controller);
        extend_instance_ttl(e);
    }

    /// Update the authorized oracle address (for backend migration).
    #[only_owner]
    pub fn set_oracle(e: &Env, new_oracle: Address) {
        e.storage()
            .instance()
            .set(&OracleKey::AuthorizedOracle, &new_oracle);
        extend_instance_ttl(e);
    }

    // --- Oracle-only write functions ---

    /// Set estimated arrival time. Transitions NotInitiated → Active.
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

        assert!(
            is_valid_transition(&data.status, &FlightStatus::Active),
            "invalid transition"
        );

        data.status = FlightStatus::Active;
        data.estimated_arrival_time = estimated_arrival_time;
        e.storage().persistent().set(&key, &data);

        extend_flight_ttl(e, &flight_id, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::Active);
    }

    /// Set actual arrival time. Transitions Active → Landed.
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

        assert!(
            is_valid_transition(&data.status, &FlightStatus::Landed),
            "invalid transition"
        );

        data.status = FlightStatus::Landed;
        data.actual_arrival_time = actual_arrival_time;
        e.storage().persistent().set(&key, &data);

        extend_flight_ttl(e, &flight_id, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::Landed);
    }

    /// Mark flight as cancelled. Transitions Active → Cancelled.
    pub fn set_cancelled(e: &Env, oracle: Address, flight_id: Symbol, date: u64) {
        require_oracle(e, &oracle);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        assert!(
            is_valid_transition(&data.status, &FlightStatus::Cancelled),
            "invalid transition"
        );

        data.status = FlightStatus::Cancelled;
        e.storage().persistent().set(&key, &data);

        extend_flight_ttl(e, &flight_id, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::Cancelled);
    }

    // --- Controller-only write functions ---

    /// Register a new flight. Creates entry as NotInitiated and adds to active list.
    pub fn register_flight(e: &Env, controller: Address, flight_id: Symbol, date: u64) {
        require_controller(e, &controller);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        // Must not already exist
        let existing: Option<FlightData> = e.storage().persistent().get(&key);
        assert!(existing.is_none(), "flight already registered");

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
        flights.push_back((flight_id.clone(), date));
        e.storage()
            .instance()
            .set(&OracleKey::ActiveFlightList, &flights);

        extend_flight_ttl(e, &flight_id, date);
        emit_status_event(e, &flight_id, date, &FlightStatus::NotInitiated);
    }

    /// Classify a flight for settlement. Transitions Landed/Cancelled → ToBeSettled*.
    pub fn set_to_be_settled(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        status: FlightStatus,
    ) {
        require_controller(e, &controller);

        // Validate the target status is a ToBeSettled variant
        assert!(
            matches!(
                status,
                FlightStatus::ToBeSettledOnTime
                    | FlightStatus::ToBeSettledDelayed
                    | FlightStatus::ToBeSettledCancelled
            ),
            "invalid settlement status"
        );

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        assert!(
            is_valid_transition(&data.status, &status),
            "invalid transition"
        );

        data.status = status.clone();
        e.storage().persistent().set(&key, &data);

        extend_flight_ttl(e, &flight_id, date);
        emit_status_event(e, &flight_id, date, &status);
    }

    /// Mark flight as settled. Transitions ToBeSettled* → Settled.
    /// Records `settled_at` so the delayed-prune window starts ticking.
    /// Does NOT remove the flight from `ActiveFlightList` — eviction is
    /// delegated to the permissionless `prune_settled` entry, which only
    /// removes entries older than `SETTLED_RETENTION_DAYS`. Does NOT renew
    /// flight TTL — settled entries naturally expire.
    pub fn set_settled(e: &Env, controller: Address, flight_id: Symbol, date: u64) {
        require_controller(e, &controller);

        let key = OracleKey::FlightData(flight_id.clone(), date);
        let mut data: FlightData = e
            .storage()
            .persistent()
            .get(&key)
            .expect("flight not registered");

        assert!(
            is_valid_transition(&data.status, &FlightStatus::Settled),
            "invalid transition"
        );

        data.status = FlightStatus::Settled;
        data.settled_at = e.ledger().timestamp();
        e.storage().persistent().set(&key, &data);

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

        let mut kept: Vec<(Symbol, u64)> = Vec::new(e);
        for i in 0..list.len() {
            let (flight_id, date) = list.get(i).unwrap();
            let data: FlightData = e
                .storage()
                .persistent()
                .get(&OracleKey::FlightData(flight_id.clone(), date))
                .expect("flight data missing");
            let age_seconds = now.saturating_sub(data.settled_at);
            let aged_out = data.status == FlightStatus::Settled
                && data.settled_at != 0
                && age_seconds >= SETTLED_RETENTION_DAYS * SECONDS_PER_DAY;
            if !aged_out {
                kept.push_back((flight_id, date));
            }
        }

        if kept.len() != list.len() {
            e.storage()
                .instance()
                .set(&OracleKey::ActiveFlightList, &kept);
        }
        extend_instance_ttl(e);
    }

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net — write functions
    /// no longer touch instance storage, so TTL must be renewed externally.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }

    // --- Read functions ---

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

    /// Get all registered flights (active list).
    pub fn get_active_flights(e: &Env) -> Vec<(Symbol, u64)> {
        e.storage()
            .instance()
            .get(&OracleKey::ActiveFlightList)
            .unwrap_or(Vec::new(e))
    }

    /// Get flights filtered by status. Iterates active list and filters.
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

    pub fn get_authorized_oracle(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&OracleKey::AuthorizedOracle)
            .expect("oracle not set")
    }

    pub fn get_authorized_controller(e: &Env) -> Option<Address> {
        e.storage()
            .instance()
            .get(&OracleKey::AuthorizedController)
    }
}

#[contractimpl(contracttrait)]
impl Ownable for OracleAggregator {}

#[cfg(test)]
mod test;
