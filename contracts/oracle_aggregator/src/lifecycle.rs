//! Flight-status state machine: oracle-only outcome writes, controller-only
//! registration/classification/settlement, and the permissionless pruning of
//! aged-out settled flights from the active list.

use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::auth::{extend_instance_ttl, require_controller, require_oracle};
use crate::constants::{
    MAX_ACTIVE_FLIGHTS, MAX_ACTUAL_ARRIVAL_AFTER_DATE_SECS, MAX_PRUNE_BATCH,
    MAX_SCHEDULED_ARRIVAL_AFTER_DATE_SECS, SALE_AUTH_MAX_VALIDITY_SECS, SECONDS_PER_DAY,
    SETTLED_RETENTION_DAYS,
};
use crate::events::{emit_status_event, MissingFlightData, SaleClosed, SaleOpened};
use crate::storage::{
    decrement_pending_outcomes, extend_flight_ttl_to, extend_sale_auth_ttl,
    increment_pending_outcomes, is_valid_transition, settlement_deadline, OracleKey,
};
use crate::{
    Error, FlightData, FlightStatus, OracleAggregator, OracleAggregatorArgs, OracleAggregatorClient,
};

#[contractimpl]
impl OracleAggregator {
    // --- Oracle-only write functions ---

    /// Open (or refresh) the sale window for a flight instance. The purchase
    /// gate requires a live, unexpired authorization, so this write is the
    /// oracle's AFFIRMATIVE attestation — made after verifying the flight
    /// off-chain — that `(flight_id, date)` matches a scheduled,
    /// not-cancelled physical flight. Absence of an on-chain outcome proves
    /// nothing about the real flight (a publicly cancelled one looks
    /// identical to a valid unreported one until the cancellation write
    /// lands), so insurability must be attested, not inferred.
    ///
    /// The attestation is only as fresh as its remaining validity:
    /// `expires_at` must lie within `SALE_AUTH_MAX_VALIDITY_SECS` of now
    /// (and never past the departure-day boundary, beyond which the
    /// controller's lead-time gate blocks purchases anyway). Sales stay open
    /// only while the oracle keeps re-attesting; if it stops — outage,
    /// provider gap, unverifiable flight — the window lapses and purchases
    /// fail closed.
    #[when_not_paused]
    pub fn open_sale(e: &Env, oracle: Address, flight_id: Symbol, date: u64, expires_at: u64) {
        require_oracle(e, &oracle);

        let now = e.ledger().timestamp();
        let latest_allowed = now
            .checked_add(SALE_AUTH_MAX_VALIDITY_SECS)
            .expect("addition overflow");
        if expires_at <= now || expires_at > latest_allowed || expires_at > date {
            panic_with_error!(e, Error::InvalidTimestamp);
        }

        // A flight with a recorded outcome is not insurable; opening a sale
        // window for it would contradict the state machine the purchase gate
        // also checks. NotInitiated (no row, or registered pre-outcome) and
        // Active (in-flight, pre-outcome) are the only attestable states.
        let key = OracleKey::FlightData(flight_id.clone(), date);
        if let Some(data) = e.storage().persistent().get::<_, FlightData>(&key) {
            if !matches!(
                data.status,
                FlightStatus::NotInitiated | FlightStatus::Active
            ) {
                panic_with_error!(e, Error::InvalidTransition);
            }
        }

        let auth_key = OracleKey::SaleAuth(flight_id.clone(), date);
        e.storage().temporary().set(&auth_key, &expires_at);
        extend_sale_auth_ttl(e, &flight_id, date, expires_at);

        SaleOpened {
            flight_id,
            date,
            expires_at,
        }
        .publish(e);
    }

    /// Close the sale window for a flight instance ahead of its expiry —
    /// used when the oracle observes a cancellation or loses confidence in
    /// the flight's identity and cannot wait for the authorization to lapse.
    /// Idempotent: closing an absent window is a silent no-op (no event).
    /// `set_cancelled` also closes the window as a side effect.
    ///
    /// Deliberately NOT pause-gated: this write only revokes authorization —
    /// it grants nothing. Already-open windows live in temporary storage and
    /// stay readable (and purchasable through the controller, which may not
    /// be paused) for up to their 24 h validity regardless of this
    /// contract's pause state, so pausing the oracle must not also disable
    /// the one write that can kill insurability of a flight that goes
    /// publicly cancelled mid-window — gating it would invert the protection
    /// exactly when the pause switch is in use. Same convention as the
    /// governance module's pause-exempt protective writes.
    pub fn close_sale(e: &Env, oracle: Address, flight_id: Symbol, date: u64) {
        require_oracle(e, &oracle);

        let auth_key = OracleKey::SaleAuth(flight_id.clone(), date);
        if !e.storage().temporary().has(&auth_key) {
            return;
        }
        e.storage().temporary().remove(&auth_key);

        SaleClosed { flight_id, date }.publish(e);
    }

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
        // Zero is the unset sentinel in FlightData, and an arrival cannot
        // precede the departure day's midnight. Rejecting malformed values
        // here matters because the state machine is forward-only: a bad
        // timestamp accepted now corrupts the delay classification later with
        // no on-chain correction path. The upper bound is the symmetric half
        // of the same defense: no schedule puts arrival days past departure,
        // and a unit-confused value (milliseconds-for-seconds) passes every
        // lower bound while corrupting the same downstream math — see
        // MAX_SCHEDULED_ARRIVAL_AFTER_DATE_SECS.
        let latest_plausible = date
            .checked_add(MAX_SCHEDULED_ARRIVAL_AFTER_DATE_SECS)
            .expect("addition overflow");
        if estimated_arrival_time == 0
            || estimated_arrival_time < date
            || estimated_arrival_time > latest_plausible
        {
            panic_with_error!(e, Error::InvalidTimestamp);
        }

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
        // A zero actual arrival is the unset sentinel — accepted, it would
        // saturate the delay computation to zero and settle every such flight
        // as on-time, silently denying delayed-flight payouts with no
        // correction path in the forward-only machine. An arrival before the
        // departure day's midnight is equally malformed. The upper bound
        // rejects the opposite malformation — a unit-confused
        // (milliseconds-for-seconds) value that would classify the flight as
        // delayed by ~10¹² seconds and mint a wrongful payout, equally
        // uncorrectable — see MAX_ACTUAL_ARRIVAL_AFTER_DATE_SECS.
        let latest_plausible = date
            .checked_add(MAX_ACTUAL_ARRIVAL_AFTER_DATE_SECS)
            .expect("addition overflow");
        if actual_arrival_time == 0
            || actual_arrival_time < date
            || actual_arrival_time > latest_plausible
        {
            panic_with_error!(e, Error::InvalidTimestamp);
        }

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

        // Outcome is now public but not yet financially settled. From here the
        // record must survive until keeper-driven settlement completes, so
        // extend to the settlement horizon rather than the (typically past)
        // flight date, whose extension bottoms out at the ~31-day floor.
        increment_pending_outcomes(e);
        extend_flight_ttl_to(e, &flight_id, date, settlement_deadline(e, date));
        emit_status_event(e, &flight_id, date, &FlightStatus::Landed);
    }

    /// Mark flight as cancelled. Transitions NotInitiated/Active → Cancelled.
    ///
    /// Unlike the other outcome writes, this also accepts a flight that has
    /// never been registered. Registration normally happens as a side effect of
    /// the first purchase, so without this path the oracle could not record a
    /// publicly known cancellation until someone bought a policy — and the
    /// purchase gate, seeing no oracle record, would admit buyers into a flight
    /// whose payout is already certain. Writing the cancellation first creates
    /// a purchase-blocking record.
    ///
    /// A record created this way is deliberately kept OUT of the active flight
    /// list and the pending-outcomes counter: absence of a record proves no
    /// policy exists (every purchase registers the flight), so there is no
    /// premium or collateral to settle and no unrecognized vault PnL. Entering
    /// the classify/settle pipeline would strand the flight forever on a
    /// missing pool config and jam the vault's settlement barrier. The record
    /// is a tombstone: it exists only so the purchase gate sees `Cancelled`.
    #[when_not_paused]
    pub fn set_cancelled(e: &Env, oracle: Address, flight_id: Symbol, date: u64) {
        require_oracle(e, &oracle);

        // A cancelled flight must not remain purchasable for a second: kill
        // any live sale authorization in the same transaction that records
        // the cancellation, rather than waiting for it to lapse.
        e.storage()
            .temporary()
            .remove(&OracleKey::SaleAuth(flight_id.clone(), date));

        let key = OracleKey::FlightData(flight_id.clone(), date);
        match e.storage().persistent().get::<_, FlightData>(&key) {
            Some(mut data) => {
                if !(is_valid_transition(&data.status, &FlightStatus::Cancelled)) {
                    panic_with_error!(e, Error::InvalidTransition);
                }

                data.status = FlightStatus::Cancelled;
                e.storage().persistent().set(&key, &data);

                // Outcome is now public but not yet financially settled — the
                // record must survive until keeper-driven settlement (see
                // `set_landed` on the extended horizon).
                increment_pending_outcomes(e);
                extend_flight_ttl_to(e, &flight_id, date, settlement_deadline(e, date));
            }
            None => {
                // Pre-registration cancellation: create the tombstone record
                // (see the doc comment — no active-list entry, no pending
                // outcome, nothing to settle). Date-based TTL suffices: the
                // tombstone only needs to outlive the purchase window.
                let data = FlightData {
                    status: FlightStatus::Cancelled,
                    estimated_arrival_time: 0,
                    actual_arrival_time: 0,
                    settled_at: 0,
                };
                e.storage().persistent().set(&key, &data);
                extend_flight_ttl_to(e, &flight_id, date, date);
            }
        }

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

        // Append to the paginated active set (per-page persistent entries +
        // reverse index — see `sentinel_types::active_set`). The cap is an
        // operational sanity bound, not a storage-entry limit: settled
        // flights are evicted by prune_settled, freeing capacity.
        if sentinel_types::active_set::count(e) >= MAX_ACTIVE_FLIGHTS {
            panic_with_error!(e, Error::ActiveFlightListFull);
        }
        sentinel_types::active_set::add(e, &flight_id, date);

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

        // Voiding a flight that never produced any data (NotInitiated, no
        // outcome to classify from) is only legitimate once the stale timeout
        // past departure has elapsed — enforced here, on the state machine
        // itself, so no caller can void a date the executor merely hasn't
        // fetched yet. The void counts as a pending outcome from this moment:
        // it deterministically implies premium income the vault has not yet
        // recognized, so LP entry/exit must be barred until it settles (the
        // Landed/Cancelled paths increment at outcome time instead; their
        // classification is not a new disclosure).
        if data.status == FlightStatus::NotInitiated {
            let stale_at = date
                .checked_add(sentinel_types::timeouts::STALE_FLIGHT_TIMEOUT_SECS)
                .expect("addition overflow");
            if e.ledger().timestamp() < stale_at {
                panic_with_error!(e, Error::StaleTimeoutNotReached);
            }
            increment_pending_outcomes(e);
        }

        // Voiding an Active flight whose terminal outcome (Landed/Cancelled)
        // never arrived is only legitimate once the active timeout past the
        // recorded scheduled arrival has elapsed — enforced here, on the
        // state machine itself, so no caller can void a flight the oracle is
        // merely late in resolving. The transition table restricts the
        // Active source to ToBeSettledOnTime, so this void never pays out.
        // Like the NotInitiated void, it is a new outcome disclosure: it
        // deterministically implies premium income the vault has not yet
        // recognized, so it counts as a pending outcome from this moment.
        if data.status == FlightStatus::Active {
            let timeout_at = data
                .estimated_arrival_time
                .checked_add(sentinel_types::timeouts::ACTIVE_FLIGHT_TIMEOUT_SECS)
                .expect("addition overflow");
            if e.ledger().timestamp() < timeout_at {
                panic_with_error!(e, Error::ActiveTimeoutNotReached);
            }
            increment_pending_outcomes(e);
        }

        data.status = status.clone();
        e.storage().persistent().set(&key, &data);

        // A classified flight still awaits the money-moving settlement pass;
        // keep it alive through the settlement horizon (see `set_landed`).
        extend_flight_ttl_to(e, &flight_id, date, settlement_deadline(e, date));
        emit_status_event(e, &flight_id, date, &status);
    }

    /// Mark flight as settled. Transitions ToBeSettled* → Settled.
    /// Records `settled_at` so the delayed-prune window starts ticking.
    /// Does NOT remove the flight from the active set — eviction is
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

    /// Remove settled flights from the active set once they have been
    /// settled for at least `SETTLED_RETENTION_DAYS`. Permissionless —
    /// anyone may call (matches `flight_pool_manager::sweep_expired`
    /// pattern). Idempotent: re-callable with no panic; no-op if nothing
    /// has aged out.
    pub fn prune_settled(e: &Env) {
        let now = e.ledger().timestamp();
        let len = sentinel_types::active_set::count(e);
        if len == 0 {
            extend_instance_ttl(e);
            return;
        }

        // Only inspect a bounded window [cursor, cursor+batch) of the set per
        // call — the paged fetch reads just the one or two pages the window
        // spans (and re-extends their TTL), bounding the expensive storage
        // reads. The cursor rotates across calls so the whole set is
        // eventually swept.
        let mut cursor: u32 = e
            .storage()
            .instance()
            .get(&OracleKey::PruneCursor)
            .unwrap_or(0);
        if cursor >= len {
            cursor = 0;
        }
        let stop = cursor.saturating_add(MAX_PRUNE_BATCH).min(len);
        let window = sentinel_types::active_set::get_range(e, cursor, stop - cursor);

        for entry in window.iter() {
            let flight_id = entry.0.clone();
            let date = entry.1;
            let aged_out = match e
                .storage()
                .persistent()
                .get::<_, FlightData>(&OracleKey::FlightData(flight_id.clone(), date))
            {
                None => {
                    // FlightData row unobservable. RETAIN the entry: a
                    // missing persistent read is never proof of settlement —
                    // the flight may still have unresolved premiums, payouts,
                    // or locked collateral, and evicting it here would strip
                    // the tuple from keeper enumeration, turning a temporary
                    // lapse into an orphaned workflow item. Emit the
                    // diagnostic so operators restore the entry (ledger
                    // restoration) or, once finality is confirmed off-chain,
                    // free the slot via the owner-only `evict_missing_flight`.
                    // (Under the current protocol model an archived entry in
                    // the footprint is restored before execution — or the
                    // transaction fails requiring restoration — rather than
                    // read as absent, so this branch is fail-safe
                    // defense-in-depth: it commits only under an archival
                    // model where lapsed entries are observable as missing.)
                    MissingFlightData {
                        flight_id: flight_id.clone(),
                        date,
                    }
                    .publish(e);
                    false
                }
                Some(data) => {
                    let age_seconds = now.saturating_sub(data.settled_at);
                    data.status == FlightStatus::Settled
                        && data.settled_at != 0
                        && age_seconds >= SETTLED_RETENTION_DAYS * SECONDS_PER_DAY
                }
            };
            if aged_out {
                // Removal is by key against live storage — the window is a
                // snapshot, so the swap-remove reshuffle cannot corrupt this
                // loop. A reshuffled entry may escape this sweep; the
                // rotating, re-callable scan picks it up on a later pass.
                sentinel_types::active_set::remove(e, &flight_id, date);
            }
        }

        // Advance (wrap at end). Slots shift after removals, but pruning is
        // idempotent and re-callable, so eventual full coverage still holds.
        let next_cursor = if stop >= len { 0 } else { stop };
        e.storage()
            .instance()
            .set(&OracleKey::PruneCursor, &next_cursor);
        extend_instance_ttl(e);
    }
}
