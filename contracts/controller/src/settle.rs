use soroban_sdk::{contractimpl, Address, Env};
use stellar_macros::when_not_paused;

use crate::auth::{extend_instance_ttl, require_keeper};
use crate::events::{FlightClassified, FlightSettledEvent, TtlMiss};
use crate::interfaces::{FlightPoolManagerClient, FlightStatus, OracleClient, VaultClient};
use crate::storage::CtrlKey;
use crate::{Controller, ControllerArgs, ControllerClient};

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

        for i in 0..flights.len() {
            let (flight_id, date) = flights.get(i).unwrap();
            let data = oracle.get_flight_data(&flight_id, &date);

            let new_status = match data.status {
                FlightStatus::Cancelled => Some(FlightStatus::ToBeSettledCancelled),
                FlightStatus::Landed => {
                    // Read delay_hours from FlightPoolManager (locked at register time).
                    // If the flight is in the oracle's active list, it MUST also exist
                    // in FlightPoolManager — they're registered together in buy_insurance.
                    // .unwrap() here surfaces real protocol bugs (mismatched state).
                    let cfg = pool
                        .get_flight_config(&flight_id, &date)
                        .expect("flight in oracle but missing in FlightPoolManager");
                    let delay_hours = cfg.delay_hours;

                    let delay_seconds = data
                        .actual_arrival_time
                        .saturating_sub(data.estimated_arrival_time);
                    let delay_hours_actual = delay_seconds
                        .checked_div(3600)
                        .expect("division by zero");

                    if delay_hours_actual >= (delay_hours as u64) {
                        Some(FlightStatus::ToBeSettledDelayed)
                    } else {
                        Some(FlightStatus::ToBeSettledOnTime)
                    }
                }
                FlightStatus::NotInitiated => {
                    // Oracle has no data for a flight that's already in the
                    // active list — registered via buy_insurance, but oracle
                    // either hasn't fetched yet or the FlightData entry has
                    // archived. Emit a diagnostic for the off-chain TTL-
                    // extender cron to act on. No state change; just a
                    // warning signal.
                    TtlMiss {
                        flight_id: flight_id.clone(),
                        date,
                    }
                    .publish(e);
                    None
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
        }

        extend_instance_ttl(e);
    }

    /// Iterate the oracle's active-flight list and process every flight that's
    /// in a `ToBeSettled*` status: move money between FlightPoolManager and
    /// RiskVault, then mark the oracle entry as `Settled`.
    ///
    /// Queue drain and share-price snapshot are NOT done here — see
    /// `run_queue_maintenance` (audit M-03). Splitting them ensures
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

        for i in 0..flights.len() {
            let (flight_id, date) = flights.get(i).unwrap();
            let data = oracle.get_flight_data(&flight_id, &date);
            let outcome = data.status.clone();

            match data.status {
                FlightStatus::ToBeSettledOnTime => {
                    // FlightPoolManager owns the locked terms + buyer count.
                    let cfg = pool
                        .get_flight_config(&flight_id, &date)
                        .expect("flight not registered in pool");
                    let total_payoff = cfg
                        .payoff
                        .checked_mul(cfg.buyer_count as i128)
                        .expect("multiplication overflow");

                    // Pool transfers premiums to vault and records as income.
                    pool.settle_on_time(&controller_addr, &flight_id, &date);
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
                    let cfg = pool
                        .get_flight_config(&flight_id, &date)
                        .expect("flight not registered in pool");
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
                    // per-flight USDC so travelers can claim from one address).
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
                        &paid
                            .checked_add(total_payoff)
                            .expect("addition overflow"),
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

        extend_instance_ttl(e);
    }

    /// Drain the underwriter withdrawal queue and refresh the share-price
    /// snapshot. Keeper-only. Decoupled from `execute_settlements` so the
    /// queue cannot be blocked by gas exhaustion in the settlement loop
    /// (audit M-03); keeper can run this on its own cadence.
    #[when_not_paused]
    pub fn run_queue_maintenance(e: &Env, keeper: Address) {
        require_keeper(e, &keeper);

        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let vault = VaultClient::new(e, &vault_addr);
        let controller_addr = e.current_contract_address();

        vault.process_withdrawal_queue(&controller_addr);
        vault.snapshot();

        extend_instance_ttl(e);
    }
}
