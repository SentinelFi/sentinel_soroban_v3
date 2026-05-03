#![no_std]
use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env, Symbol, Vec,
};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

// ─── Storage keys ───

#[contracttype]
pub enum CtrlKey {
    Governance,
    RiskVault,
    Oracle,
    RecoveryPool,
    UsdcToken,
    AuthorizedKeeper,
    FlightPoolWasm,
    SolvencyRatio,
    MinLeadTime,
    ClaimExpiryWindow,
    ActiveFlight(Symbol, u64),
    ActiveFlightList,
    TotalPoliciesSold,
    TotalPremiumsCollected,
    TotalPayoutsDistributed,
}

// ─── Cross-contract interfaces (Option C — like Solidity interfaces) ───

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

#[contractclient(name = "PoolClient")]
pub trait PoolInterface {
    fn buy_insurance(env: &Env, controller: Address, traveler: Address);
    fn settle_on_time(env: &Env, controller: Address);
    fn settle_delayed(env: &Env, controller: Address, claim_expiry: u64);
    fn settle_cancelled(env: &Env, controller: Address, claim_expiry: u64);
    fn get_delay_hours(env: &Env) -> u32;
    fn get_premium(env: &Env) -> i128;
    fn get_payoff(env: &Env) -> i128;
    fn get_buyer_count(env: &Env) -> u32;
    fn get_settlement_status(env: &Env) -> SettlementStatus;
}

// ─── Events ───

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct InsuranceBought {
    #[topic]
    traveler: Address,
    premium: i128,
}

#[contractevent(topics = ["ctrl"], data_format = "single-value")]
pub struct PoolDeployed {
    #[topic]
    flight_id: Symbol,
    #[topic]
    date: u64,
    pool_address: Address,
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

// ─── TTL constants ───

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

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

fn get_active_flight_list(e: &Env) -> Vec<(Symbol, u64)> {
    e.storage()
        .persistent()
        .get(&CtrlKey::ActiveFlightList)
        .unwrap_or(Vec::new(e))
}

fn save_active_flight_list(e: &Env, list: &Vec<(Symbol, u64)>) {
    e.storage()
        .persistent()
        .set(&CtrlKey::ActiveFlightList, list);
    if !list.is_empty() {
        e.storage().persistent().extend_ttl(
            &CtrlKey::ActiveFlightList,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
    }
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
        recovery_pool: Address,
        usdc_token: Address,
        flight_pool_wasm: BytesN<32>,
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
            .set(&CtrlKey::RecoveryPool, &recovery_pool);
        e.storage()
            .instance()
            .set(&CtrlKey::UsdcToken, &usdc_token);
        e.storage()
            .instance()
            .set(&CtrlKey::FlightPoolWasm, &flight_pool_wasm);
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
        let usdc_addr: Address = e.storage().instance().get(&CtrlKey::UsdcToken).unwrap();
        let recovery_addr: Address = e.storage().instance().get(&CtrlKey::RecoveryPool).unwrap();
        let wasm_hash: BytesN<32> = e.storage().instance().get(&CtrlKey::FlightPoolWasm).unwrap();

        // 1+2. Validate route + read terms in one cross-contract call.
        let gov = GovClient::new(e, &gov_addr);
        let terms = match gov.route_status(&flight_id, &origin, &dest) {
            RouteStatus::Active(t) => t,
            RouteStatus::Disabled => panic!("route is disabled"),
            RouteStatus::Unknown => panic!("route not whitelisted"),
        };

        // 3. Enforce minimum lead time
        let min_lead: u64 = e.storage().instance().get(&CtrlKey::MinLeadTime).unwrap();
        assert!(
            date > e.ledger().timestamp() + min_lead,
            "departure too soon"
        );

        // 4. Get or deploy pool
        let pool_key = CtrlKey::ActiveFlight(flight_id.clone(), date);
        let pool_addr: Address = if let Some(addr) = e.storage().persistent().get(&pool_key) {
            addr
        } else {
            // Deploy new FlightPool
            // Build deterministic salt from flight_id + date
            let date_bytes = date.to_be_bytes();
            let mut salt_input = Bytes::from_slice(e, &date_bytes);
            // Use the Symbol's raw Val as additional entropy
            let fid_val: u64 = flight_id.to_val().get_payload();
            salt_input.append(&Bytes::from_slice(e, &fid_val.to_be_bytes()));
            let salt = e.crypto().sha256(&salt_input);
            let controller_addr = e.current_contract_address();
            let deployed = e
                .deployer()
                .with_current_contract(salt)
                .deploy_v2(
                    wasm_hash,
                    (
                        controller_addr.clone(),
                        flight_id.clone(),
                        date,
                        terms.premium,
                        terms.payoff,
                        terms.delay_hours,
                        usdc_addr.clone(),
                        vault_addr.clone(),
                        recovery_addr.clone(),
                    ),
                );

            // Register flight in oracle
            let oracle = OracleClient::new(e, &oracle_addr);
            oracle.register_flight(&e.current_contract_address(), &flight_id, &date);

            // Add to active flight list
            let mut flights = get_active_flight_list(e);
            flights.push_back((flight_id.clone(), date));
            save_active_flight_list(e, &flights);

            // Store pool address
            e.storage().persistent().set(&pool_key, &deployed);
            e.storage().persistent().extend_ttl(
                &pool_key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );

            PoolDeployed {
                flight_id: flight_id.clone(),
                date,
                pool_address: deployed.clone(),
            }
            .publish(e);

            deployed
        };

        // 5. Solvency check
        let vault = VaultClient::new(e, &vault_addr);
        let free_capital = vault.get_free_capital();
        let solvency_ratio: u32 = e.storage().instance().get(&CtrlKey::SolvencyRatio).unwrap();
        let required = terms.payoff * (solvency_ratio as i128) / 100;
        assert!(free_capital >= required, "insufficient vault capital");

        // 6. Transfer premium from traveler to pool
        let usdc = token::Client::new(e, &usdc_addr);
        usdc.transfer(&traveler, &pool_addr, &terms.premium);

        // 7. Lock collateral in vault
        vault.increase_locked(&e.current_contract_address(), &terms.payoff);

        // 8. Record purchase in pool
        let pool = PoolClient::new(e, &pool_addr);
        pool.buy_insurance(&e.current_contract_address(), &traveler);

        // 9. Update counters
        let sold: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPoliciesSold)
            .unwrap_or(0);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPoliciesSold, &(sold + 1));

        let collected: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPremiumsCollected)
            .unwrap_or(0);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPremiumsCollected, &(collected + terms.premium));

        extend_instance_ttl(e);

        InsuranceBought {
            traveler,
            premium: terms.premium,
        }
        .publish(e);
    }

    // ─── Classify flights (keeper-only) ───

    pub fn classify_flights(e: &Env, keeper: Address) {
        require_keeper(e, &keeper);

        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let oracle = OracleClient::new(e, &oracle_addr);
        let controller_addr = e.current_contract_address();

        let flights = get_active_flight_list(e);

        for i in 0..flights.len() {
            let (flight_id, date) = flights.get(i).unwrap();
            let data = oracle.get_flight_data(&flight_id, &date);

            let new_status = match data.status {
                FlightStatus::Cancelled => Some(FlightStatus::ToBeSettledCancelled),
                FlightStatus::Landed => {
                    // Read delay_hours from the pool
                    let pool_addr: Address = e
                        .storage()
                        .persistent()
                        .get(&CtrlKey::ActiveFlight(flight_id.clone(), date))
                        .unwrap();
                    let pool = PoolClient::new(e, &pool_addr);
                    let delay_hours = pool.get_delay_hours();

                    let delay_seconds = if data.actual_arrival_time > data.estimated_arrival_time {
                        data.actual_arrival_time - data.estimated_arrival_time
                    } else {
                        0
                    };
                    let delay_hours_actual = delay_seconds / 3600;

                    if delay_hours_actual >= (delay_hours as u64) {
                        Some(FlightStatus::ToBeSettledDelayed)
                    } else {
                        Some(FlightStatus::ToBeSettledOnTime)
                    }
                }
                _ => None, // Not ready for classification
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

    pub fn execute_settlements(e: &Env, keeper: Address) {
        require_keeper(e, &keeper);

        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let oracle = OracleClient::new(e, &oracle_addr);
        let vault = VaultClient::new(e, &vault_addr);
        let controller_addr = e.current_contract_address();
        let claim_window: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::ClaimExpiryWindow)
            .unwrap();
        let claim_expiry = e.ledger().timestamp() + claim_window;

        let flights = get_active_flight_list(e);
        let mut remaining_flights = Vec::new(e);

        for i in 0..flights.len() {
            let (flight_id, date) = flights.get(i).unwrap();
            let data = oracle.get_flight_data(&flight_id, &date);
            let pool_addr: Address = e
                .storage()
                .persistent()
                .get(&CtrlKey::ActiveFlight(flight_id.clone(), date))
                .unwrap();
            let pool = PoolClient::new(e, &pool_addr);

            let mut settled = false;
            let outcome = data.status.clone();

            match data.status {
                FlightStatus::ToBeSettledOnTime => {
                    let premium = pool.get_premium();
                    let payoff = pool.get_payoff();
                    let buyer_count = pool.get_buyer_count();
                    let total_premiums = premium * (buyer_count as i128);
                    let total_payoff = payoff * (buyer_count as i128);

                    // Pool transfers premiums to vault
                    pool.settle_on_time(&controller_addr);
                    // Record premium income in vault
                    if total_premiums > 0 {
                        vault.record_premium_income(&controller_addr, &total_premiums);
                    }
                    // Unlock collateral
                    if total_payoff > 0 {
                        vault.decrease_locked(&controller_addr, &total_payoff);
                    }
                    // Mark settled in oracle
                    oracle.set_settled(&controller_addr, &flight_id, &date);
                    settled = true;
                }
                FlightStatus::ToBeSettledDelayed | FlightStatus::ToBeSettledCancelled => {
                    let premium = pool.get_premium();
                    let payoff = pool.get_payoff();
                    let buyer_count = pool.get_buyer_count();
                    let payout_from_vault = (payoff - premium) * (buyer_count as i128);
                    let total_payoff = payoff * (buyer_count as i128);

                    // Send payout funds from vault to pool
                    if payout_from_vault > 0 {
                        vault.send_payout(&controller_addr, &pool_addr, &payout_from_vault);
                    }
                    // Unlock collateral
                    if total_payoff > 0 {
                        vault.decrease_locked(&controller_addr, &total_payoff);
                    }
                    // Settle the pool
                    if data.status == FlightStatus::ToBeSettledDelayed {
                        pool.settle_delayed(&controller_addr, &claim_expiry);
                    } else {
                        pool.settle_cancelled(&controller_addr, &claim_expiry);
                    }
                    // Mark settled in oracle
                    oracle.set_settled(&controller_addr, &flight_id, &date);

                    // Update payouts counter
                    let paid: i128 = e
                        .storage()
                        .instance()
                        .get(&CtrlKey::TotalPayoutsDistributed)
                        .unwrap_or(0);
                    e.storage().instance().set(
                        &CtrlKey::TotalPayoutsDistributed,
                        &(paid + total_payoff),
                    );

                    settled = true;
                }
                _ => {}
            }

            if settled {
                // Remove pool address mapping
                e.storage()
                    .persistent()
                    .remove(&CtrlKey::ActiveFlight(flight_id.clone(), date));

                FlightSettledEvent {
                    flight_id,
                    date,
                    outcome,
                }
                .publish(e);
            } else {
                remaining_flights.push_back((flight_id, date));
            }
        }

        save_active_flight_list(e, &remaining_flights);

        // Process withdrawal queue and snapshot
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

    pub fn get_active_pools(e: &Env) -> Vec<(Symbol, u64, Address)> {
        let flights = get_active_flight_list(e);
        let mut result = Vec::new(e);
        for i in 0..flights.len() {
            let (flight_id, date) = flights.get(i).unwrap();
            if let Some(addr) = e
                .storage()
                .persistent()
                .get::<_, Address>(&CtrlKey::ActiveFlight(flight_id.clone(), date))
            {
                result.push_back((flight_id, date, addr));
            }
        }
        result
    }

    pub fn get_pool_address(e: &Env, flight_id: Symbol, date: u64) -> Option<Address> {
        e.storage()
            .persistent()
            .get(&CtrlKey::ActiveFlight(flight_id, date))
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
}

#[contractimpl(contracttrait)]
impl Ownable for Controller {}

#[cfg(test)]
mod test;
