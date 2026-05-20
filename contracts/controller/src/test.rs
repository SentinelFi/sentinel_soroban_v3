use super::*;
use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger as _, token, Address, Env, Symbol,
    TryFromVal,
};

const PREMIUM: i128 = 10_0000000; // 10 USDC (7 decimals)
const PAYOFF: i128 = 50_0000000; // 50 USDC
const DELAY_HOURS: u32 = 3;
const FLIGHT_DATE: u64 = 1_710_500_000;
const MIN_LEAD_TIME: u64 = 3_600;
const CLAIM_EXPIRY_WINDOW: u64 = 5_184_000; // 60 days
const DEPOSIT_AMOUNT: i128 = 1_000_0000000; // 1000 USDC
const INITIAL_TIMESTAMP: u64 = 1_710_400_000;
const EST_ARRIVAL: u64 = 1_710_500_000;
const ACTUAL_ON_TIME: u64 = 1_710_501_800; // 30 min late (< 3h)
const ACTUAL_DELAYED: u64 = 1_710_510_800; // 3h late (>= 3h)

#[allow(dead_code)]
struct TestEnv {
    env: Env,
    ctrl: ControllerClient<'static>,
    ctrl_addr: Address,
    vault: risk_vault::RiskVaultClient<'static>,
    oracle: oracle_aggregator::OracleAggregatorClient<'static>,
    pool: flight_pool_manager::FlightPoolManagerClient<'static>,
    pool_addr: Address,
    gov: governance_module::GovernanceModuleClient<'static>,
    usdc: token::Client<'static>,
    usdc_admin: token::StellarAssetClient<'static>,
    owner: Address,
    keeper: Address,
    oracle_account: Address,
    underwriter: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    // The controller orchestrates 3-deep call chains
    // (keeper → controller → pool → vault) where the controller's address
    // authorizes sub-invocations beyond the root frame. Use the non-root
    // variant so contract auth flows through nested cross-contract calls.
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let usdc_admin_addr = Address::generate(&env);
    let oracle_account = Address::generate(&env);

    // USDC (Stellar Asset Contract)
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr.clone());
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_id.address());
    let usdc = token::Client::new(&env, &usdc_id.address());

    // GovernanceModule
    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

    // RiskVault
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    // OracleAggregator
    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &oracle_account),
    );
    let oracle = oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);

    // FlightPoolManager
    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &usdc_id.address(), &vault_addr),
    );
    let pool = flight_pool_manager::FlightPoolManagerClient::new(&env, &pool_addr);

    // Controller
    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &usdc_id.address(),
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);

    // Wire one-time controllers on each downstream contract.
    vault.set_controller(&ctrl_addr);
    oracle.set_controller(&ctrl_addr);
    pool.set_controller(&ctrl_addr);

    // Whitelist the default test route.
    gov.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Seed underwriter capital so solvency checks pass.
    let underwriter = Address::generate(&env);
    usdc_admin.mint(&underwriter, &DEPOSIT_AMOUNT);
    vault.deposit(&DEPOSIT_AMOUNT, &underwriter, &underwriter, &underwriter);

    TestEnv {
        env,
        ctrl,
        ctrl_addr,
        vault,
        oracle,
        pool,
        pool_addr,
        gov,
        usdc,
        usdc_admin,
        owner,
        keeper,
        oracle_account,
        underwriter,
    }
}

fn buy(t: &TestEnv, traveler: &Address) {
    t.usdc_admin.mint(traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

fn oracle_on_time(t: &TestEnv) {
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &ACTUAL_ON_TIME,
    );
}

fn oracle_delayed(t: &TestEnv) {
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &ACTUAL_DELAYED,
    );
}

fn oracle_cancelled(t: &TestEnv) {
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle
        .set_cancelled(&t.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);
}

// =========================================================================
// Constructor & getters
// =========================================================================

#[test]
fn test_constructor() {
    let t = setup();
    assert_eq!(t.ctrl.get_owner(), Some(t.owner.clone()));
    assert_eq!(t.ctrl.get_keeper(), t.keeper);
    assert_eq!(t.ctrl.get_solvency_ratio(), 100);
    assert_eq!(t.ctrl.get_flight_pool_manager(), t.pool_addr);
    let (sold, collected, distributed) = t.ctrl.get_stats();
    assert_eq!(sold, 0);
    assert_eq!(collected, 0);
    assert_eq!(distributed, 0);
}

// =========================================================================
// Owner-only setters
// =========================================================================

#[test]
fn test_set_keeper() {
    let t = setup();
    let new_keeper = Address::generate(&t.env);
    t.ctrl.set_keeper(&new_keeper);
    assert_eq!(t.ctrl.get_keeper(), new_keeper);
}

#[test]
fn test_set_solvency_ratio() {
    let t = setup();
    t.ctrl.set_solvency_ratio(&150);
    assert_eq!(t.ctrl.get_solvency_ratio(), 150);
}

#[test]
fn test_set_min_lead_time() {
    let t = setup();
    t.ctrl.set_min_lead_time(&7_200);
    // Effect observable through buy_insurance lead-time gate (covered separately).
}

#[test]
fn test_set_claim_expiry_window() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&86_400);
    // Effect observable through execute_settlements paths.
}

#[test]
#[should_panic(expected = "solvency_ratio out of bounds")]
fn test_set_solvency_ratio_below_100_panics() {
    let t = setup();
    t.ctrl.set_solvency_ratio(&99);
}

#[test]
#[should_panic(expected = "solvency_ratio out of bounds")]
fn test_set_solvency_ratio_above_max_panics() {
    let t = setup();
    t.ctrl.set_solvency_ratio(&10_001);
}

#[test]
#[should_panic(expected = "min_lead_time exceeds maximum")]
fn test_set_min_lead_time_above_max_panics() {
    let t = setup();
    t.ctrl.set_min_lead_time(&7_776_001);
}

#[test]
#[should_panic(expected = "claim_expiry_window out of bounds")]
fn test_set_claim_expiry_window_zero_panics() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&0);
}

#[test]
#[should_panic(expected = "claim_expiry_window out of bounds")]
fn test_set_claim_expiry_window_below_min_panics() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&86_399);
}

#[test]
#[should_panic(expected = "claim_expiry_window out of bounds")]
fn test_set_claim_expiry_window_above_max_panics() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&15_552_001);
}

#[test]
#[should_panic]
fn test_unauthorized_set_keeper() {
    let env = Env::default();
    // No mock_all_auths — owner check fails.
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let usdc_admin_addr = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr);

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &Address::generate(&env)),
    );
    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &usdc_id.address(), &vault_addr),
    );
    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &usdc_id.address(),
            &Address::generate(&env), // keeper
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);

    ctrl.set_keeper(&stranger);
}

// =========================================================================
// buy_insurance happy paths
// =========================================================================

#[test]
fn test_buy_insurance_first_traveler_registers_flight() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);

    let (sold, collected, _) = t.ctrl.get_stats();
    assert_eq!(sold, 1);
    assert_eq!(collected, PREMIUM);

    // Premium transferred from traveler to FlightPoolManager.
    assert_eq!(t.usdc.balance(&traveler), 0);
    assert_eq!(t.usdc.balance(&t.pool_addr), PREMIUM);

    // Vault collateral locked.
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    // FlightPoolManager has the registered flight.
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.premium, PREMIUM);
    assert_eq!(cfg.payoff, PAYOFF);
    assert_eq!(cfg.delay_hours, DELAY_HOURS);
    assert_eq!(cfg.buyer_count, 1);

    // Per-traveler index updated.
    let flights = t.ctrl.get_flights_for_traveler(&traveler);
    assert_eq!(flights.len(), 1);
    assert_eq!(
        flights.get(0).unwrap(),
        (symbol_short!("AA100"), FLIGHT_DATE)
    );
}

#[test]
fn test_buy_insurance_second_traveler_skips_register() {
    let t = setup();
    let traveler1 = Address::generate(&t.env);
    let traveler2 = Address::generate(&t.env);

    buy(&t, &traveler1);
    buy(&t, &traveler2);

    // FlightPoolManager has both buyers on the same flight (single registration).
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.buyer_count, 2);

    // Pool USDC = 2 × premium, vault locked = 2 × payoff.
    assert_eq!(t.usdc.balance(&t.pool_addr), 2 * PREMIUM);
    assert_eq!(t.vault.get_locked_capital(), 2 * PAYOFF);

    // Each traveler has their own per-traveler index entry.
    assert_eq!(t.ctrl.get_flights_for_traveler(&traveler1).len(), 1);
    assert_eq!(t.ctrl.get_flights_for_traveler(&traveler2).len(), 1);
}

#[test]
fn test_buy_insurance_traveler_index_for_multiple_flights() {
    let t = setup();
    let traveler = Address::generate(&t.env);

    // Whitelist a second route.
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    buy(&t, &traveler);

    t.usdc_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &(FLIGHT_DATE + 1),
    );

    let flights = t.ctrl.get_flights_for_traveler(&traveler);
    assert_eq!(flights.len(), 2);
    assert_eq!(
        flights.get(0).unwrap(),
        (symbol_short!("AA100"), FLIGHT_DATE)
    );
    assert_eq!(
        flights.get(1).unwrap(),
        (symbol_short!("UA200"), FLIGHT_DATE + 1)
    );
}

#[test]
fn test_get_flights_for_traveler_empty_for_unknown_address() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    let flights = t.ctrl.get_flights_for_traveler(&stranger);
    assert_eq!(flights.len(), 0);
}

// =========================================================================
// buy_insurance gate panics
// =========================================================================

#[test]
#[should_panic(expected = "route is disabled")]
fn test_buy_insurance_panics_on_disabled_route() {
    let t = setup();
    t.gov.disable_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
}

#[test]
#[should_panic(expected = "route not whitelisted")]
fn test_buy_insurance_panics_on_unknown_route() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.usdc_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("ZZ999"),
        &symbol_short!("XXX"),
        &symbol_short!("YYY"),
        &FLIGHT_DATE,
    );
}

#[test]
#[should_panic(expected = "departure too soon")]
fn test_buy_insurance_panics_on_short_lead_time() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.usdc_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &(INITIAL_TIMESTAMP + 100), // way under 3600s lead time
    );
}

#[test]
#[should_panic(expected = "insufficient vault capital")]
fn test_buy_insurance_panics_on_solvency_gate() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let oracle_account = Address::generate(&env);
    let usdc_admin_addr = Address::generate(&env);

    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr);
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_id.address());

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &oracle_account),
    );
    let oracle = oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);

    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &usdc_id.address(), &vault_addr),
    );
    let pool = flight_pool_manager::FlightPoolManagerClient::new(&env, &pool_addr);

    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &usdc_id.address(),
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);

    vault.set_controller(&ctrl_addr);
    oracle.set_controller(&ctrl_addr);
    pool.set_controller(&ctrl_addr);

    gov.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // NO underwriter capital — vault has 0 free capital.
    let traveler = Address::generate(&env);
    usdc_admin.mint(&traveler, &PREMIUM);
    ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

// =========================================================================
// classify_flights
// =========================================================================

#[test]
fn test_classify_flights_on_time() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_on_time(&t);

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledOnTime
    );
}

#[test]
fn test_classify_flights_delayed() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_delayed(&t);

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledDelayed
    );
}

#[test]
fn test_classify_flights_cancelled() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_cancelled(&t);

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledCancelled
    );
}

#[test]
fn test_classify_flights_skips_unready_flights() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    // No oracle activity — flight is NotInitiated.

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::NotInitiated);
}

#[test]
fn test_classify_flights_emits_ttl_miss_for_not_initiated() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    // Skip oracle data push — flight stays NotInitiated.

    t.ctrl.classify_flights(&t.keeper);

    // Event log holds events from the most recent invocation only — assert
    // immediately, before any subsequent contract call. Look for an event
    // emitted by the controller with topic prefix ["sentinel", "ttl_miss"]
    // and a third indexed `flight_id` topic equal to AA100.
    let mut found = false;
    for (event_addr, topics, _data) in collect_events(&t.env).iter() {
        if event_addr != t.ctrl_addr {
            continue;
        }
        if topics.len() < 3 {
            continue;
        }
        let t0 = Symbol::try_from_val(&t.env, &topics.get(0).unwrap()).ok();
        let t1 = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()).ok();
        let t2 = Symbol::try_from_val(&t.env, &topics.get(2).unwrap()).ok();
        if t0 == Some(symbol_short!("sentinel"))
            && t1 == Some(symbol_short!("ttl_miss"))
            && t2 == Some(symbol_short!("AA100"))
        {
            found = true;
            break;
        }
    }
    assert!(found, "expected sentinel.ttl_miss event for AA100");
}

#[test]
#[should_panic(expected = "not authorized keeper")]
fn test_classify_flights_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl.classify_flights(&stranger);
}

// =========================================================================
// execute_settlements
// =========================================================================

#[test]
fn test_execute_settlements_on_time_flow() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_on_time(&t);
    t.ctrl.classify_flights(&t.keeper);

    let tma_before = t.vault.get_total_managed_assets();
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    t.ctrl.execute_settlements(&t.keeper);

    // On-time settlement: premium transferred to vault as yield, collateral unlocked.
    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before + PREMIUM);

    // Pool's USDC drained to vault.
    assert_eq!(t.usdc.balance(&t.pool_addr), 0);

    // Oracle marks Settled with settled_at recorded.
    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);
    assert!(data.settled_at != 0);

    // Pool's flight status is SettledOnTime.
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledOnTime
    );
}

#[test]
fn test_execute_settlements_delayed_flow() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_delayed(&t);
    t.ctrl.classify_flights(&t.keeper);

    assert_eq!(t.usdc.balance(&t.pool_addr), PREMIUM);

    t.ctrl.execute_settlements(&t.keeper);

    // Delayed: vault sends (payoff - premium) to pool, collateral unlocked.
    assert_eq!(t.vault.get_locked_capital(), 0);
    // Pool now holds the full payoff for the buyer to claim.
    assert_eq!(t.usdc.balance(&t.pool_addr), PAYOFF);

    let (_, _, distributed) = t.ctrl.get_stats();
    assert_eq!(distributed, PAYOFF);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledDelayed
    );
    assert_eq!(cfg.claim_expiry, INITIAL_TIMESTAMP + CLAIM_EXPIRY_WINDOW);
}

#[test]
fn test_execute_settlements_cancelled_flow() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_cancelled(&t);
    t.ctrl.classify_flights(&t.keeper);

    t.ctrl.execute_settlements(&t.keeper);

    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.usdc.balance(&t.pool_addr), PAYOFF);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledCancelled
    );
}

#[test]
fn test_execute_settlements_skips_unclassified_flights() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    // No oracle activity — flight is NotInitiated. Skip classify.

    let tma_before = t.vault.get_total_managed_assets();
    t.ctrl.execute_settlements(&t.keeper);

    // No money movement: flight wasn't classified.
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before);
}

#[test]
fn test_run_queue_maintenance_processes_withdrawal_queue() {
    // M-03: queue drain is no longer coupled to execute_settlements.
    // After settlements free up capital, the keeper calls
    // run_queue_maintenance to actually drain the queue.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);

    let underwriter_shares = t.vault.balance(&t.underwriter);
    let withdraw_shares = underwriter_shares / 2;
    t.vault.request_withdrawal(&t.underwriter, &withdraw_shares);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    oracle_on_time(&t);
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);
    // Settlement alone does NOT drain the queue.
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    t.ctrl.run_queue_maintenance(&t.keeper);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
    assert!(t.vault.get_claimable_balance(&t.underwriter) > 0);
}

#[test]
#[should_panic(expected = "not authorized keeper")]
fn test_run_queue_maintenance_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl.run_queue_maintenance(&stranger);
}

#[test]
#[should_panic(expected = "not authorized keeper")]
fn test_execute_settlements_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl.execute_settlements(&stranger);
}

// =========================================================================
// End-to-end lifecycle
// =========================================================================

#[test]
fn test_end_to_end_delayed_lifecycle() {
    let t = setup();
    let traveler = Address::generate(&t.env);

    buy(&t, &traveler);
    assert_eq!(t.usdc.balance(&traveler), 0);

    oracle_delayed(&t);
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    // Traveler claims payoff from FlightPoolManager.
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);

    assert_eq!(t.usdc.balance(&traveler), PAYOFF);
    assert!(t
        .pool
        .has_claimed(&symbol_short!("AA100"), &FLIGHT_DATE, &traveler));
}

#[test]
fn test_end_to_end_on_time_lifecycle_no_payout() {
    let t = setup();
    let traveler = Address::generate(&t.env);

    buy(&t, &traveler);
    oracle_on_time(&t);
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    // Traveler keeps no USDC (already paid premium); on-time = no claim.
    assert_eq!(t.usdc.balance(&traveler), 0);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledOnTime
    );
}

#[test]
fn test_extend_ttl_is_callable() {
    let t = setup();
    t.ctrl.extend_ttl();
}
