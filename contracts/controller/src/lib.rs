#![no_std]
use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, contracttype, token, Address, Env,
    Symbol, Vec,
};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

// ─── Storage keys ───

#[contracttype]
pub enum CtrlKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Governance,
    RiskVault,
    Oracle,
    FlightPoolManager,
    UsdcToken,
    AuthorizedKeeper,
    SolvencyRatio,
    MinLeadTime,
    ClaimExpiryWindow,
    TotalPoliciesSold,
    TotalPremiumsCollected,
    TotalPayoutsDistributed,

    // Persistent — keyed multi-row state
    TravelerFlights(Address),                // Vec<(Symbol, u64)>
}

// ─── Cross-contract interfaces (Pattern B — inline trait + mirror types) ───
//
// See project_codebase_patterns.md for the rationale (loose orchestration coupling,
// no production dep on downstream crates). Mirror struct/enum field order MUST
// match the upstream contract — drift causes runtime deserialization panics.

#[contractclient(name = "GovClient")]
pub trait GovernanceInterface {
    fn route_status(env: &Env, flight_id: Symbol, origin: Symbol, dest: Symbol) -> RouteStatus;
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedTerms {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RouteStatus {
    Active(ResolvedTerms),
    Disabled,
    Unknown,
}

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn get_free_capital(env: &Env) -> i128;
    fn increase_locked(env: &Env, controller: Address, amount: i128);
    fn decrease_locked(env: &Env, controller: Address, amount: i128);
    fn record_premium_income(env: &Env, controller: Address, amount: i128);
    fn send_payout(env: &Env, controller: Address, to: Address, amount: i128);
    fn process_withdrawal_queue(env: &Env, controller: Address);
    fn snapshot(env: &Env);
}

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
    pub settled_at: u64,                   // 0 means not-yet-settled — must match oracle's struct field order
}

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn register_flight(env: &Env, controller: Address, flight_id: Symbol, date: u64);
    fn get_flight_data(env: &Env, flight_id: Symbol, date: u64) -> FlightData;
    fn get_active_flights(env: &Env) -> Vec<(Symbol, u64)>;
    fn set_to_be_settled(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        status: FlightStatus,
    );
    fn set_settled(env: &Env, controller: Address, flight_id: Symbol, date: u64);
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

#[contractclient(name = "FlightPoolManagerClient")]
pub trait FlightPoolManagerInterface {
    fn register_flight(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        premium: i128,
        payoff: i128,
        delay_hours: u32,
    );
    fn get_flight_config(env: &Env, flight_id: Symbol, date: u64) -> Option<FlightConfig>;
    fn add_buyer(env: &Env, controller: Address, flight_id: Symbol, date: u64, buyer: Address);
    fn settle_on_time(env: &Env, controller: Address, flight_id: Symbol, date: u64);
    fn settle_delayed(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    );
    fn settle_cancelled(
        env: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    );
}

// ─── Events ───

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct InsuranceBought {
    #[topic]
    traveler: Address,
    premium: i128,
}

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct FlightClassified {
    #[topic]
    flight_id: Symbol,
    #[topic]
    date: u64,
    status: FlightStatus,
}

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct FlightSettledEvent {
    #[topic]
    flight_id: Symbol,
    #[topic]
    date: u64,
    outcome: FlightStatus,
}

// Diagnostic warning emitted by `classify_flights` when oracle returns
// NotInitiated for a flight in the active list — signals that FlightData
// may have archived (or oracle hasn't fetched data yet for an overdue
// flight). Consumed by the off-chain TTL-extender cron (Improvement #6 /
// Phase 11 executor work).
#[contractevent(topics = ["warn", "ttl_miss"], data_format = "map")]
pub struct TtlMiss {
    #[topic]
    flight_id: Symbol,
    date: u64,
}

// ─── TTL constants ───

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;

// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800. Applied on every
// `TravelerFlights(addr)` write to keep the per-traveler index alive without
// special cron coverage; the off-chain TTL cron (Improvement #6 / Cron #4)
// will extend idle entries for active travelers.
const TRAVELER_FLIGHTS_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;

// ─── Helpers ───

fn require_keeper(e: &Env, caller: &Address) {
    caller.require_auth();
    let keeper: Address = e
        .storage()
        .instance()
        .get(&CtrlKey::AuthorizedKeeper)
        .expect("keeper not set");
    assert!(caller == &keeper, "not authorized keeper");
}

fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

fn append_traveler_flight(e: &Env, traveler: &Address, flight_id: &Symbol, date: u64) {
    let key = CtrlKey::TravelerFlights(traveler.clone());
    let mut list: Vec<(Symbol, u64)> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
    list.push_back((flight_id.clone(), date));
    e.storage().persistent().set(&key, &list);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}

// ─── Contract ───

#[contract]
pub struct Controller;

#[contractimpl]
impl Controller {
    pub fn __constructor(
        e: &Env,
        owner: Address,
        governance: Address,
        risk_vault: Address,
        oracle: Address,
        flight_pool_manager: Address,
        usdc_token: Address,
        authorized_keeper: Address,
        min_lead_time: u64,
        claim_expiry_window: u64,
    ) {
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&CtrlKey::Governance, &governance);
        e.storage()
            .instance()
            .set(&CtrlKey::RiskVault, &risk_vault);
        e.storage().instance().set(&CtrlKey::Oracle, &oracle);
        e.storage()
            .instance()
            .set(&CtrlKey::FlightPoolManager, &flight_pool_manager);
        e.storage()
            .instance()
            .set(&CtrlKey::UsdcToken, &usdc_token);
        e.storage()
            .instance()
            .set(&CtrlKey::AuthorizedKeeper, &authorized_keeper);
        e.storage()
            .instance()
            .set(&CtrlKey::MinLeadTime, &min_lead_time);
        e.storage()
            .instance()
            .set(&CtrlKey::ClaimExpiryWindow, &claim_expiry_window);
        e.storage()
            .instance()
            .set(&CtrlKey::SolvencyRatio, &100u32);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPoliciesSold, &0u64);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPremiumsCollected, &0i128);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPayoutsDistributed, &0i128);
    }

    // ─── Owner-only admin ───

    #[only_owner]
    pub fn set_keeper(e: &Env, keeper: Address) {
        e.storage()
            .instance()
            .set(&CtrlKey::AuthorizedKeeper, &keeper);
        extend_instance_ttl(e);
    }

    #[only_owner]
    pub fn set_solvency_ratio(e: &Env, ratio: u32) {
        e.storage()
            .instance()
            .set(&CtrlKey::SolvencyRatio, &ratio);
        extend_instance_ttl(e);
    }

    #[only_owner]
    pub fn set_min_lead_time(e: &Env, seconds: u64) {
        e.storage()
            .instance()
            .set(&CtrlKey::MinLeadTime, &seconds);
        extend_instance_ttl(e);
    }

    #[only_owner]
    pub fn set_claim_expiry_window(e: &Env, seconds: u64) {
        e.storage()
            .instance()
            .set(&CtrlKey::ClaimExpiryWindow, &seconds);
        extend_instance_ttl(e);
    }

    // ─── Buy insurance ───

    pub fn buy_insurance(
        e: &Env,
        traveler: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
        date: u64,
    ) {
        traveler.require_auth();

        let gov_addr: Address = e.storage().instance().get(&CtrlKey::Governance).unwrap();
        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let pool_addr: Address = e
            .storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap();
        let usdc_addr: Address = e.storage().instance().get(&CtrlKey::UsdcToken).unwrap();
        let controller_addr = e.current_contract_address();

        // 1+2. Validate route + read terms in one cross-contract call.
        let gov = GovClient::new(e, &gov_addr);
        let terms = match gov.route_status(&flight_id, &origin, &dest) {
            RouteStatus::Active(t) => t,
            RouteStatus::Disabled => panic!("route is disabled"),
            RouteStatus::Unknown => panic!("route not whitelisted"),
        };

        // 3. Enforce minimum lead time.
        let min_lead: u64 = e.storage().instance().get(&CtrlKey::MinLeadTime).unwrap();
        let earliest_allowed = e
            .ledger()
            .timestamp()
            .checked_add(min_lead)
            .expect("addition overflow");
        assert!(date > earliest_allowed, "departure too soon");

        // 4. Look up flight in the singleton FlightPoolManager. If missing,
        //    register it (locks terms) AND register the same (flight_id, date)
        //    in the oracle so the FlightDataFetcher cron can populate
        //    estimated/actual arrival times.
        let pool = FlightPoolManagerClient::new(e, &pool_addr);
        if pool.get_flight_config(&flight_id, &date).is_none() {
            pool.register_flight(
                &controller_addr,
                &flight_id,
                &date,
                &terms.premium,
                &terms.payoff,
                &terms.delay_hours,
            );
            let oracle = OracleClient::new(e, &oracle_addr);
            oracle.register_flight(&controller_addr, &flight_id, &date);
        }

        // 5. Solvency check.
        let vault = VaultClient::new(e, &vault_addr);
        let free_capital = vault.get_free_capital();
        let solvency_ratio: u32 = e
            .storage()
            .instance()
            .get(&CtrlKey::SolvencyRatio)
            .unwrap();
        let required = terms
            .payoff
            .checked_mul(solvency_ratio as i128)
            .expect("multiplication overflow")
            .checked_div(100)
            .expect("division by zero");
        assert!(free_capital >= required, "insufficient vault capital");

        // 6. Transfer premium directly from traveler to FlightPoolManager.
        //    Soroban auth propagates: the traveler signed buy_insurance, so
        //    this sub-invocation transfer is authorized.
        let usdc = token::Client::new(e, &usdc_addr);
        usdc.transfer(&traveler, &pool_addr, &terms.premium);

        // 7. Lock collateral in vault.
        vault.increase_locked(&controller_addr, &terms.payoff);

        // 8. Record buyer in FlightPoolManager.
        pool.add_buyer(&controller_addr, &flight_id, &date, &traveler);

        // 9. Append to per-traveler index (unblocks MyPolicies frontend).
        append_traveler_flight(e, &traveler, &flight_id, date);

        // 10. Update aggregate counters.
        let sold: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPoliciesSold)
            .unwrap_or(0);
        e.storage().instance().set(
            &CtrlKey::TotalPoliciesSold,
            &sold.checked_add(1).expect("addition overflow"),
        );

        let collected: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPremiumsCollected)
            .unwrap_or(0);
        e.storage().instance().set(
            &CtrlKey::TotalPremiumsCollected,
            &collected
                .checked_add(terms.premium)
                .expect("addition overflow"),
        );

        extend_instance_ttl(e);

        InsuranceBought {
            traveler,
            premium: terms.premium,
        }
        .publish(e);
    }

    // ─── Classify flights (keeper-only) ───

    /// Iterate the oracle's active-flight list (post-Phase-6, this is the
    /// canonical source of in-flight registrations + a 30-day retention
    /// window of recently-settled flights). For each Landed/Cancelled flight,
    /// compute the settlement outcome from FlightPoolManager's locked terms
    /// and write `ToBeSettled*` back to the oracle.
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
                        .checked_sub(data.estimated_arrival_time)
                        .unwrap_or(0);
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
                    // archived. Emit a diagnostic for the off-chain
                    // TTL-extender cron (Improvement #6) to act on. No state
                    // change; just a warning signal.
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

    // ─── Execute settlements (keeper-only) ───

    /// Iterate the oracle's active-flight list and process every flight that's
    /// in a `ToBeSettled*` status: move money between FlightPoolManager and
    /// RiskVault, then mark the oracle entry as `Settled`. After looping,
    /// process the underwriter withdrawal queue and snapshot share price.
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

                    // Vault sends payout funds to FlightPoolManager (it now
                    // holds all per-flight USDC).
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

        // Process underwriter withdrawal queue and take share-price snapshot.
        vault.process_withdrawal_queue(&controller_addr);
        vault.snapshot();

        extend_instance_ttl(e);
    }

    // ─── TTL management ───

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }

    // ─── Read functions ───

    /// Per-traveler index — returns every `(flight_id, date)` the address has
    /// ever bought insurance for. Append-only; frontend filters by current
    /// status (looked up in FlightPoolManager / oracle).
    pub fn get_flights_for_traveler(e: &Env, address: Address) -> Vec<(Symbol, u64)> {
        e.storage()
            .persistent()
            .get(&CtrlKey::TravelerFlights(address))
            .unwrap_or(Vec::new(e))
    }

    pub fn get_stats(e: &Env) -> (u64, i128, i128) {
        let sold: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPoliciesSold)
            .unwrap_or(0);
        let collected: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPremiumsCollected)
            .unwrap_or(0);
        let distributed: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPayoutsDistributed)
            .unwrap_or(0);
        (sold, collected, distributed)
    }

    pub fn get_keeper(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&CtrlKey::AuthorizedKeeper)
            .unwrap()
    }

    pub fn get_solvency_ratio(e: &Env) -> u32 {
        e.storage()
            .instance()
            .get(&CtrlKey::SolvencyRatio)
            .unwrap()
    }

    pub fn get_flight_pool_manager(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap()
    }
}

#[contractimpl(contracttrait)]
impl Ownable for Controller {}

#[cfg(test)]
mod test;
