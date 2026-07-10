use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol};
use stellar_macros::{only_owner, when_not_paused};

use crate::auth::require_keeper;
use crate::constants::{MAX_SETTLE_BATCH, SECONDS_PER_HOUR};
use crate::events::{
    EvictedFlightSettled, FlightClassified, FlightConfigMissing, FlightSettledEvent, FlightVoided,
    TtlMiss,
};
use crate::interfaces::{FlightPoolManagerClient, FlightStatus, OracleClient, VaultClient};
use crate::storage::CtrlKey;
use crate::{Controller, ControllerArgs, ControllerClient, Error};

#[contractimpl]
impl Controller {
    /// Iterate the oracle's active-flight list (the canonical source of
    /// in-flight registrations plus a 30-day retention window of recently-
    /// settled flights). For each Landed/Cancelled flight, compute the
    /// settlement outcome from FlightPoolManager's locked terms and write
    /// `ToBeSettled*` back to the oracle.
    #[when_not_paused]
    pub fn classify_flights(e: &Env, keeper: Address) {
        require_keeper(e, &keeper);

        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let pool_addr: Address = e
            .storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap();
        let oracle = OracleClient::new(e, &oracle_addr);
        let pool = FlightPoolManagerClient::new(e, &pool_addr);
        let controller_addr = e.current_contract_address();

        let flights = oracle.get_active_flights();
        let len = flights.len();
        if len == 0 {
            Controller::extend_ttl(e);
            return;
        }

        // Scan at most MAX_SETTLE_BATCH entries per call, starting
        // at a persisted rotating cursor, so per-call cost is bounded by the
        // batch size rather than the (unbounded) active-list length.
        let mut cursor: u32 = e
            .storage()
            .instance()
            .get(&CtrlKey::ClassifyCursor)
            .unwrap_or(0);
        if cursor >= len {
            cursor = 0;
        }
        let batch = MAX_SETTLE_BATCH.min(len);

        let mut i = cursor;
        for _ in 0..batch {
            let (flight_id, date) = flights.get(i).unwrap();
            let data = oracle.get_flight_data(&flight_id, &date);

            let new_status = match data.status {
                FlightStatus::Cancelled => Some(FlightStatus::ToBeSettledCancelled),
                FlightStatus::Landed => {
                    // Read delay_hours from FlightPoolManager (locked at register time).
                    // A present-in-oracle but missing-in-pool config
                    // (archived past TTL) must not panic the whole loop. Skip the
                    // flight and emit a diagnostic so one bad entry can't block
                    // settlement of every other flight.
                    match pool.get_flight_config(&flight_id, &date) {
                        Some(cfg) => {
                            let delay_hours = cfg.delay_hours;
                            let delay_seconds = data
                                .actual_arrival_time
                                .saturating_sub(data.estimated_arrival_time);
                            let delay_hours_actual = delay_seconds
                                .checked_div(SECONDS_PER_HOUR)
                                .expect("division by zero");

                            if delay_hours_actual >= (delay_hours as u64) {
                                Some(FlightStatus::ToBeSettledDelayed)
                            } else {
                                Some(FlightStatus::ToBeSettledOnTime)
                            }
                        }
                        None => {
                            FlightConfigMissing {
                                flight_id: flight_id.clone(),
                                date,
                            }
                            .publish(e);
                            None
                        }
                    }
                }
                FlightStatus::NotInitiated => {
                    let stale_at = date
                        .checked_add(sentinel_types::timeouts::STALE_FLIGHT_TIMEOUT_SECS)
                        .expect("addition overflow");
                    if oracle.has_flight_data(&flight_id, &date)
                        && e.ledger().timestamp() >= stale_at
                    {
                        // No flight data ever arrived and the flight is now
                        // long past departure: the purchased date most likely
                        // never matched a physical flight. Void it — settle
                        // as on-time so the premiums become vault yield and
                        // the locked collateral is released, instead of the
                        // row pinning vault capital and a policy-bucket slot
                        // forever. Never a payout: paying claims on a flight
                        // that provably never flew would let anyone mint
                        // guaranteed claims from bogus dates. The
                        // has_flight_data guard keeps archived rows out of
                        // this path — a missing entry is a TTL lapse needing
                        // restoration, not proof the flight never existed.
                        FlightVoided {
                            flight_id: flight_id.clone(),
                            date,
                        }
                        .publish(e);
                        Some(FlightStatus::ToBeSettledOnTime)
                    } else {
                        // Not yet fetched by the executor (normal
                        // pre-departure state) or archived past TTL. Emit the
                        // diagnostic for the off-chain TTL/restoration
                        // tooling; no state change.
                        TtlMiss {
                            flight_id: flight_id.clone(),
                            date,
                        }
                        .publish(e);
                        None
                    }
                }
                _ => None,
            };

            if let Some(status) = new_status {
                oracle.set_to_be_settled(&controller_addr, &flight_id, &date, &status);

                FlightClassified {
                    flight_id,
                    date,
                    status,
                }
                .publish(e);
            }

            i = (i + 1) % len;
        }

        e.storage().instance().set(&CtrlKey::ClassifyCursor, &i);
        Controller::extend_ttl(e);
    }

    /// Iterate the oracle's active-flight list and process every flight that's
    /// in a `ToBeSettled*` status: move money between FlightPoolManager and
    /// RiskVault, then mark the oracle entry as `Settled`.
    ///
    /// Queue drain and share-price snapshot are NOT done here — see
    /// `run_queue_maintenance`. Splitting them ensures
    /// underwriter withdrawals can still be processed when the settlement
    /// loop runs near the resource budget.
    #[when_not_paused]
    pub fn execute_settlements(e: &Env, keeper: Address) {
        require_keeper(e, &keeper);

        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let pool_addr: Address = e
            .storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap();
        let oracle = OracleClient::new(e, &oracle_addr);
        let vault = VaultClient::new(e, &vault_addr);
        let pool = FlightPoolManagerClient::new(e, &pool_addr);
        let controller_addr = e.current_contract_address();
        let claim_window: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::ClaimExpiryWindow)
            .unwrap();
        let claim_expiry = e
            .ledger()
            .timestamp()
            .checked_add(claim_window)
            .expect("addition overflow");

        let flights = oracle.get_active_flights();
        let len = flights.len();
        if len == 0 {
            Controller::extend_ttl(e);
            return;
        }

        // Bounded rotating scan — see classify_flights.
        let mut cursor: u32 = e
            .storage()
            .instance()
            .get(&CtrlKey::SettleCursor)
            .unwrap_or(0);
        if cursor >= len {
            cursor = 0;
        }
        let batch = MAX_SETTLE_BATCH.min(len);

        let mut i = cursor;
        for _ in 0..batch {
            let (flight_id, date) = flights.get(i).unwrap();
            i = (i + 1) % len;
            let data = oracle.get_flight_data(&flight_id, &date);
            let outcome = data.status.clone();

            match data.status {
                FlightStatus::ToBeSettledOnTime => {
                    // FlightPoolManager owns the locked terms + buyer count.
                    // Skip + diagnose a missing config instead of
                    // panicking the whole settlement loop.
                    let cfg = match pool.get_flight_config(&flight_id, &date) {
                        Some(cfg) => cfg,
                        None => {
                            FlightConfigMissing { flight_id, date }.publish(e);
                            continue;
                        }
                    };
                    let total_payoff = cfg
                        .payoff
                        .checked_mul(cfg.buyer_count as i128)
                        .expect("multiplication overflow");

                    // Pool moves the held premiums to the vault and returns the
                    // transferred total. The Controller records it as vault
                    // income directly — record_premium_income is controller-only
                    // and the Controller (not the pool) must be the caller so its
                    // own authorization is the one the vault sees.
                    let premium_income = pool.settle_on_time(&controller_addr, &flight_id, &date);
                    if premium_income > 0 {
                        vault.record_premium_income(&controller_addr, &premium_income);
                    }
                    // Unlock collateral.
                    if total_payoff > 0 {
                        vault.decrease_locked(&controller_addr, &total_payoff);
                    }
                    oracle.set_settled(&controller_addr, &flight_id, &date);

                    FlightSettledEvent {
                        flight_id,
                        date,
                        outcome,
                    }
                    .publish(e);
                }
                FlightStatus::ToBeSettledDelayed | FlightStatus::ToBeSettledCancelled => {
                    let cfg = match pool.get_flight_config(&flight_id, &date) {
                        Some(cfg) => cfg,
                        None => {
                            FlightConfigMissing { flight_id, date }.publish(e);
                            continue;
                        }
                    };
                    let buyer_count_i128 = cfg.buyer_count as i128;
                    let payout_from_vault = cfg
                        .payoff
                        .checked_sub(cfg.premium)
                        .expect("subtraction underflow")
                        .checked_mul(buyer_count_i128)
                        .expect("multiplication overflow");
                    let total_payoff = cfg
                        .payoff
                        .checked_mul(buyer_count_i128)
                        .expect("multiplication overflow");

                    // Vault sends payout funds to the pool (the pool holds all
                    // per-flight asset so travelers can claim from one address).
                    if payout_from_vault > 0 {
                        vault.send_payout(&controller_addr, &pool_addr, &payout_from_vault);
                    }
                    if total_payoff > 0 {
                        vault.decrease_locked(&controller_addr, &total_payoff);
                    }

                    if data.status == FlightStatus::ToBeSettledDelayed {
                        pool.settle_delayed(&controller_addr, &flight_id, &date, &claim_expiry);
                    } else {
                        pool.settle_cancelled(&controller_addr, &flight_id, &date, &claim_expiry);
                    }
                    oracle.set_settled(&controller_addr, &flight_id, &date);

                    let paid: i128 = e
                        .storage()
                        .instance()
                        .get(&CtrlKey::TotalPayoutsDistributed)
                        .unwrap_or(0);
                    e.storage().instance().set(
                        &CtrlKey::TotalPayoutsDistributed,
                        &paid.checked_add(total_payoff).expect("addition overflow"),
                    );

                    FlightSettledEvent {
                        flight_id,
                        date,
                        outcome,
                    }
                    .publish(e);
                }
                _ => {}
            }
        }

        e.storage().instance().set(&CtrlKey::SettleCursor, &i);
        Controller::extend_ttl(e);
    }

    /// Terminal reconciliation for a flight the owner evicted from the
    /// oracle's active list (`oracle.evict_missing_flight`). Eviction frees
    /// the oracle-side list slot and releases the settlement barrier, but on
    /// its own it would leave the flight's pool bucket `Active` forever and
    /// its vault collateral locked forever — the flight is outside keeper
    /// enumeration, so no settlement pass can ever reach it. This entry point
    /// completes the release: the bucket settles like a voided flight (held
    /// premiums forwarded to the vault as income, collateral unlocked, no
    /// payout — with no oracle data there is no on-chain outcome to pay
    /// against), which also frees the bucket's pool active-list slot.
    ///
    /// Owner-only, and restricted to flights provably outside the normal
    /// pipeline:
    /// - the oracle must have NO `FlightData` row (the same gate eviction
    ///   itself enforces — a present row means the flight is restorable, and
    ///   restore-and-settle is the correct path; note this also means the
    ///   row must NOT be restored after eviction, or this reconciliation
    ///   becomes unreachable);
    /// - the flight must NOT be in the oracle active list (a listed flight
    ///   is still keeper-enumerable and must settle through the normal
    ///   pipeline).
    ///
    /// Not exempt from downstream pause gates: the pool/vault calls it makes
    /// are `when_not_paused`, so run it after unpausing those contracts.
    #[only_owner]
    pub fn settle_evicted_flight(e: &Env, flight_id: Symbol, date: u64) {
        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let pool_addr: Address = e
            .storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap();
        let oracle = OracleClient::new(e, &oracle_addr);
        let vault = VaultClient::new(e, &vault_addr);
        let pool = FlightPoolManagerClient::new(e, &pool_addr);
        let controller_addr = e.current_contract_address();

        if oracle.has_flight_data(&flight_id, &date) {
            panic_with_error!(e, Error::FlightDataStillPresent);
        }
        let listed = oracle.get_active_flights();
        for i in 0..listed.len() {
            if listed.get(i).unwrap() == (flight_id.clone(), date) {
                panic_with_error!(e, Error::FlightStillListed);
            }
        }
        let cfg = match pool.get_flight_config(&flight_id, &date) {
            Some(cfg) => cfg,
            None => panic_with_error!(e, Error::FlightNotRegisteredInPool),
        };
        let total_payoff = cfg
            .payoff
            .checked_mul(cfg.buyer_count as i128)
            .expect("multiplication overflow");

        // settle_on_time enforces the bucket is still Active (so this call is
        // cleanly non-repeatable), moves the held premiums to the vault, and
        // prunes the pool's active list.
        let premium_income = pool.settle_on_time(&controller_addr, &flight_id, &date);
        if premium_income > 0 {
            vault.record_premium_income(&controller_addr, &premium_income);
        }
        if total_payoff > 0 {
            vault.decrease_locked(&controller_addr, &total_payoff);
        }

        EvictedFlightSettled {
            flight_id,
            date,
            premium_income,
            collateral_released: total_payoff,
        }
        .publish(e);
        Controller::extend_ttl(e);
    }

    /// Drain the underwriter withdrawal queue and refresh the share-price
    /// snapshot. Keeper-only. Decoupled from `execute_settlements` so the
    /// queue cannot be blocked by gas exhaustion in the settlement loop;
    /// keeper can run this on its own cadence.
    #[when_not_paused]
    pub fn run_queue_maintenance(e: &Env, keeper: Address) {
        require_keeper(e, &keeper);

        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let vault = VaultClient::new(e, &vault_addr);
        let controller_addr = e.current_contract_address();

        vault.process_withdrawal_queue(&controller_addr);
        vault.snapshot();

        Controller::extend_ttl(e);
    }
}
