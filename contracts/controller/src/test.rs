use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger},
    Env,
};

// Import FlightPool WASM for deployer
mod flight_pool_wasm {
    soroban_sdk::contractimport!(
        file = "../target/wasm32v1-none/release/flight_pool.wasm"
    );
}

const PREMIUM: i128 = 10_0000000; // 10 USDC
const PAYOFF: i128 = 50_0000000; // 50 USDC
const DELAY_HOURS: u32 = 3;
const FLIGHT_DATE: u64 = 1710500000; // future date
const MIN_LEAD_TIME: u64 = 3600; // 1 hour
const CLAIM_EXPIRY_WINDOW: u64 = 5_184_000; // 60 days
const DEPOSIT_AMOUNT: i128 = 1000_0000000; // 1000 USDC

struct TestSetup {
    env: Env,
    controller: ControllerClient<'static>,
    owner: Address,
    keeper: Address,
    gov_addr: Address,
    vault_addr: Address,
    oracle_addr: Address,
    _recovery_addr: Address,
    usdc_addr: Address,
    usdc_client: token::StellarAssetClient<'static>,
    oracle_account: Address,
}

fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();
    // Set current timestamp before flight date
    env.ledger().with_mut(|l| l.timestamp = 1710400000);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let oracle_account = Address::generate(&env);

    // Deploy USDC
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_client = token::StellarAssetClient::new(&env, &usdc_id.address());

    // Deploy GovernanceModule
    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );

    // Deploy RiskVault
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));

    // Deploy OracleAggregator
    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &oracle_account),
    );

    // Deploy RecoveryPool
    let recovery_addr = env.register(
        recovery_pool::RecoveryPool,
        (&owner, &usdc_id.address()),
    );

    // Upload FlightPool WASM and get hash
    let pool_wasm_hash = env.deployer().upload_contract_wasm(flight_pool_wasm::WASM);

    // Deploy Controller
    let controller_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &recovery_addr,
            &usdc_id.address(),
            &pool_wasm_hash,
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let controller = ControllerClient::new(&env, &controller_addr);

    // Wire controller into vault and oracle
    let vault_client = risk_vault::RiskVaultClient::new(&env, &vault_addr);
    vault_client.set_controller(&controller_addr);

    let oracle_client =
        oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);
    oracle_client.set_controller(&controller_addr);

    // Whitelist a route
    let gov_client =
        governance_module::GovernanceModuleClient::new(&env, &gov_addr);
    gov_client.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Deposit capital into vault (underwriter)
    let underwriter = Address::generate(&env);
    usdc_client.mint(&underwriter, &DEPOSIT_AMOUNT);
    vault_client.deposit(&DEPOSIT_AMOUNT, &underwriter, &underwriter, &underwriter);

    TestSetup {
        env,
        controller,
        owner,
        keeper,
        gov_addr,
        vault_addr,
        oracle_addr,
        _recovery_addr: recovery_addr,
        usdc_addr: usdc_id.address(),
        usdc_client,
        oracle_account,
    }
}

fn buy_policy(s: &TestSetup, traveler: &Address) {
    s.usdc_client.mint(traveler, &PREMIUM);
    s.controller.buy_insurance(
        traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

// ─── Constructor & admin tests ───

#[test]
fn test_constructor() {
    let s = setup();
    assert_eq!(s.controller.get_owner(), Some(s.owner));
    assert_eq!(s.controller.get_keeper(), s.keeper);
    assert_eq!(s.controller.get_solvency_ratio(), 100);
    let (sold, collected, distributed) = s.controller.get_stats();
    assert_eq!(sold, 0);
    assert_eq!(collected, 0);
    assert_eq!(distributed, 0);
}

#[test]
fn test_set_keeper() {
    let s = setup();
    let new_keeper = Address::generate(&s.env);
    s.controller.set_keeper(&new_keeper);
    assert_eq!(s.controller.get_keeper(), new_keeper);
}

#[test]
fn test_set_solvency_ratio() {
    let s = setup();
    s.controller.set_solvency_ratio(&150);
    assert_eq!(s.controller.get_solvency_ratio(), 150);
}

#[test]
#[should_panic]
fn test_unauthorized_set_keeper() {
    let env = Env::default();
    // No mock_all_auths
    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let gov = Address::generate(&env);
    let vault = Address::generate(&env);
    let oracle = Address::generate(&env);
    let recovery = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov,
            &vault,
            &oracle,
            &recovery,
            &usdc_id.address(),
            &wasm_hash,
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);
    let new_keeper = Address::generate(&env);
    ctrl.set_keeper(&new_keeper);
}

// ─── buy_insurance tests ───

#[test]
fn test_buy_insurance_deploys_pool() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);

    // Pool should exist
    let pool_addr = s
        .controller
        .get_pool_address(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert!(pool_addr.is_some());

    // Counters updated
    let (sold, collected, _) = s.controller.get_stats();
    assert_eq!(sold, 1);
    assert_eq!(collected, PREMIUM);

    // Active pools list
    let pools = s.controller.get_active_pools();
    assert_eq!(pools.len(), 1);

    // Traveler USDC spent
    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&traveler), 0);
}

#[test]
fn test_buy_insurance_existing_pool() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);

    buy_policy(&s, &t1);
    let pool1 = s
        .controller
        .get_pool_address(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();

    buy_policy(&s, &t2);
    let pool2 = s
        .controller
        .get_pool_address(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();

    // Same pool address — no redeploy
    assert_eq!(pool1, pool2);

    let (sold, collected, _) = s.controller.get_stats();
    assert_eq!(sold, 2);
    assert_eq!(collected, PREMIUM * 2);
    assert_eq!(s.controller.get_active_pools().len(), 1);
}

#[test]
#[should_panic(expected = "route not whitelisted")]
fn test_buy_insurance_invalid_route() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    s.usdc_client.mint(&traveler, &PREMIUM);

    s.controller.buy_insurance(
        &traveler,
        &symbol_short!("XX999"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

#[test]
#[should_panic(expected = "departure too soon")]
fn test_buy_insurance_departure_too_soon() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    s.usdc_client.mint(&traveler, &PREMIUM);

    let too_soon = s.env.ledger().timestamp() + 100;
    s.controller.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &too_soon,
    );
}

#[test]
#[should_panic(expected = "insufficient vault capital")]
fn test_buy_insurance_solvency_rejection() {
    let s = setup();

    // Vault has 1000 USDC, each policy locks 50 USDC payoff → max 20 policies
    // Use the same flight/date — all go into one pool, each locks 50
    for _ in 0..20u32 {
        let traveler = Address::generate(&s.env);
        s.usdc_client.mint(&traveler, &PREMIUM);
        s.controller.buy_insurance(
            &traveler,
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &FLIGHT_DATE,
        );
    }

    // 21st should fail — vault at capacity
    let traveler = Address::generate(&s.env);
    s.usdc_client.mint(&traveler, &PREMIUM);
    s.controller.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

// ─── Classify flights tests ───

fn setup_and_buy_and_get_oracle(
    s: &TestSetup,
) -> oracle_aggregator::OracleAggregatorClient<'static> {
    let traveler = Address::generate(&s.env);
    buy_policy(s, &traveler);
    oracle_aggregator::OracleAggregatorClient::new(&s.env, &s.oracle_addr)
}

#[test]
fn test_classify_on_time() {
    let s = setup();
    let oracle = setup_and_buy_and_get_oracle(&s);

    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    // 30 min late (< 3h threshold)
    oracle.set_landed(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710501800,
    );

    s.controller.classify_flights(&s.keeper);

    let data = oracle.get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledOnTime
    );
}

#[test]
fn test_classify_delayed() {
    let s = setup();
    let oracle = setup_and_buy_and_get_oracle(&s);

    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    // 3h late (>= 3h threshold)
    oracle.set_landed(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710510800,
    );

    s.controller.classify_flights(&s.keeper);

    let data = oracle.get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledDelayed
    );
}

#[test]
fn test_classify_cancelled() {
    let s = setup();
    let oracle = setup_and_buy_and_get_oracle(&s);

    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    oracle.set_cancelled(&s.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);

    s.controller.classify_flights(&s.keeper);

    let data = oracle.get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledCancelled
    );
}

// ─── Execute settlements tests ───

#[test]
fn test_settle_on_time() {
    let s = setup();
    let oracle = setup_and_buy_and_get_oracle(&s);

    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    oracle.set_landed(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710501800,
    );

    s.controller.classify_flights(&s.keeper);
    s.controller.execute_settlements(&s.keeper);

    let data = oracle.get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);
    assert_eq!(s.controller.get_active_pools().len(), 0);

    let vault = risk_vault::RiskVaultClient::new(&s.env, &s.vault_addr);
    assert_eq!(vault.get_locked_capital(), 0);
}

#[test]
fn test_settle_delayed_and_claim() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    buy_policy(&s, &traveler);

    let pool_addr = s
        .controller
        .get_pool_address(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();

    let oracle =
        oracle_aggregator::OracleAggregatorClient::new(&s.env, &s.oracle_addr);
    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    oracle.set_landed(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710510800,
    );

    s.controller.classify_flights(&s.keeper);
    s.controller.execute_settlements(&s.keeper);

    let data = oracle.get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);

    // Pool holds payoff for traveler
    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&pool_addr), PAYOFF);

    // Traveler claims
    let pool = flight_pool::FlightPoolClient::new(&s.env, &pool_addr);
    pool.claim(&traveler);
    assert_eq!(usdc.balance(&traveler), PAYOFF);

    let (_, _, distributed) = s.controller.get_stats();
    assert_eq!(distributed, PAYOFF);
}

#[test]
fn test_settle_cancelled_and_claim() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    buy_policy(&s, &traveler);

    let pool_addr = s
        .controller
        .get_pool_address(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();

    let oracle =
        oracle_aggregator::OracleAggregatorClient::new(&s.env, &s.oracle_addr);
    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    oracle.set_cancelled(&s.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);

    s.controller.classify_flights(&s.keeper);
    s.controller.execute_settlements(&s.keeper);

    let pool = flight_pool::FlightPoolClient::new(&s.env, &pool_addr);
    pool.claim(&traveler);

    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&traveler), PAYOFF);
}

// ─── Keeper authorization ───

#[test]
#[should_panic(expected = "not authorized keeper")]
fn test_classify_unauthorized() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    s.controller.classify_flights(&stranger);
}

#[test]
#[should_panic(expected = "not authorized keeper")]
fn test_settle_unauthorized() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    s.controller.execute_settlements(&stranger);
}

// ─── Full end-to-end ───

#[test]
fn test_e2e_buy_classify_settle_claim() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);

    buy_policy(&s, &t1);
    buy_policy(&s, &t2);

    let pool_addr = s
        .controller
        .get_pool_address(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();

    let oracle =
        oracle_aggregator::OracleAggregatorClient::new(&s.env, &s.oracle_addr);
    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    oracle.set_landed(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710510800,
    ); // 3h late

    s.controller.classify_flights(&s.keeper);
    s.controller.execute_settlements(&s.keeper);

    let pool = flight_pool::FlightPoolClient::new(&s.env, &pool_addr);
    pool.claim(&t1);
    pool.claim(&t2);

    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&t1), PAYOFF);
    assert_eq!(usdc.balance(&t2), PAYOFF);

    let (sold, collected, distributed) = s.controller.get_stats();
    assert_eq!(sold, 2);
    assert_eq!(collected, PREMIUM * 2);
    assert_eq!(distributed, PAYOFF * 2);

    let vault = risk_vault::RiskVaultClient::new(&s.env, &s.vault_addr);
    assert_eq!(vault.get_locked_capital(), 0);
}

// ─── Multiple flights in parallel ───

#[test]
fn test_multiple_flights() {
    let s = setup();

    let gov =
        governance_module::GovernanceModuleClient::new(&s.env, &s.gov_addr);
    gov.whitelist_route(
        &s.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);
    s.usdc_client.mint(&t1, &PREMIUM);
    s.usdc_client.mint(&t2, &PREMIUM);

    s.controller.buy_insurance(
        &t1,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
    s.controller.buy_insurance(
        &t2,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &(FLIGHT_DATE + 100),
    );

    assert_eq!(s.controller.get_active_pools().len(), 2);

    let oracle =
        oracle_aggregator::OracleAggregatorClient::new(&s.env, &s.oracle_addr);
    // AA100: on-time (30min late)
    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710500000,
    );
    oracle.set_landed(
        &s.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &1710501800,
    );

    // UA200: delayed (3h late)
    oracle.set_estimated_arrival(
        &s.oracle_account,
        &symbol_short!("UA200"),
        &(FLIGHT_DATE + 100),
        &1710500100,
    );
    oracle.set_landed(
        &s.oracle_account,
        &symbol_short!("UA200"),
        &(FLIGHT_DATE + 100),
        &1710510900,
    );

    s.controller.classify_flights(&s.keeper);
    s.controller.execute_settlements(&s.keeper);

    assert_eq!(s.controller.get_active_pools().len(), 0);

    let (sold, _, distributed) = s.controller.get_stats();
    assert_eq!(sold, 2);
    assert_eq!(distributed, PAYOFF); // Only UA200 had payout
}

// ─── Counter accuracy ───

#[test]
fn test_counter_accuracy() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);
    let t3 = Address::generate(&s.env);

    buy_policy(&s, &t1);
    buy_policy(&s, &t2);
    buy_policy(&s, &t3);

    let (sold, collected, distributed) = s.controller.get_stats();
    assert_eq!(sold, 3);
    assert_eq!(collected, PREMIUM * 3);
    assert_eq!(distributed, 0);
}

// ─── Event emission ───

#[test]
fn test_event_on_buy() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    buy_policy(&s, &traveler);

    let events = s.env.events().all();
    assert!(events.len() > 0);
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, s.controller.address);
}
