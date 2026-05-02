use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger},
    Env,
};

const PREMIUM: i128 = 10_0000000; // 10 USDC (7 decimals)
const PAYOFF: i128 = 50_0000000; // 50 USDC
const DELAY_HOURS: u32 = 3;
const FLIGHT_DATE: u64 = 1710400000;
const CLAIM_EXPIRY: u64 = 1715584000; // ~60 days after FLIGHT_DATE

struct TestSetup {
    env: Env,
    client: FlightPoolClient<'static>,
    controller: Address,
    usdc_addr: Address,
    usdc_client: token::StellarAssetClient<'static>,
    vault_addr: Address,
    recovery_addr: Address,
}

fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let controller = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_client = token::StellarAssetClient::new(&env, &usdc_id.address());

    // Register real RecoveryPool for cross-contract sweep tests
    let recovery_addr = env.register(
        recovery_pool::RecoveryPool,
        (&owner, &usdc_id.address()),
    );

    // Register real RiskVault for settle_on_time tests
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &usdc_id.address()),
    );

    let contract_id = env.register(
        FlightPool,
        (
            &controller,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &PREMIUM,
            &PAYOFF,
            &DELAY_HOURS,
            &usdc_id.address(),
            &vault_addr,
            &recovery_addr,
        ),
    );
    let client = FlightPoolClient::new(&env, &contract_id);

    TestSetup {
        env,
        client,
        controller,
        usdc_addr: usdc_id.address(),
        usdc_client,
        vault_addr,
        recovery_addr,
    }
}

fn buy_policy(s: &TestSetup, traveler: &Address) {
    // Mint USDC to traveler and transfer premium to pool (simulating Controller)
    s.usdc_client.mint(traveler, &PREMIUM);
    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    usdc.transfer(traveler, &s.client.address, &PREMIUM);
    s.client.buy_insurance(&s.controller, traveler);
}

// --- Constructor and read functions ---

#[test]
fn test_constructor_and_read() {
    let s = setup();

    let (flight_id, date, premium, payoff, delay_hours) = s.client.get_flight_info();
    assert_eq!(flight_id, symbol_short!("AA100"));
    assert_eq!(date, FLIGHT_DATE);
    assert_eq!(premium, PREMIUM);
    assert_eq!(payoff, PAYOFF);
    assert_eq!(delay_hours, DELAY_HOURS);

    assert_eq!(s.client.get_buyer_count(), 0);
    assert_eq!(s.client.get_settlement_status(), SettlementStatus::Active);
    assert_eq!(s.client.get_controller(), s.controller);
}

// --- buy_insurance ---

#[test]
fn test_buy_insurance_single() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);

    assert_eq!(s.client.get_buyer_count(), 1);
    assert!(s.client.has_policy(&traveler));
    assert!(!s.client.has_claimed(&traveler));

    // Pool should hold the premium
    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&s.client.address), PREMIUM);
}

#[test]
fn test_buy_insurance_multiple() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);
    let t3 = Address::generate(&s.env);

    buy_policy(&s, &t1);
    buy_policy(&s, &t2);
    buy_policy(&s, &t3);

    assert_eq!(s.client.get_buyer_count(), 3);
    assert!(s.client.has_policy(&t1));
    assert!(s.client.has_policy(&t2));
    assert!(s.client.has_policy(&t3));

    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&s.client.address), PREMIUM * 3);
}

#[test]
#[should_panic(expected = "already has policy")]
fn test_buy_insurance_duplicate() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    // Second buy should fail
    s.client.buy_insurance(&s.controller, &traveler);
}

// --- settle_on_time ---

#[test]
fn test_settle_on_time() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);

    buy_policy(&s, &t1);
    buy_policy(&s, &t2);

    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    let total_premiums = PREMIUM * 2;

    // Pool holds premiums before settlement
    assert_eq!(usdc.balance(&s.client.address), total_premiums);

    s.client.settle_on_time(&s.controller);

    assert_eq!(s.client.get_settlement_status(), SettlementStatus::SettledOnTime);
    // Premiums transferred to vault
    assert_eq!(usdc.balance(&s.client.address), 0);
    assert_eq!(usdc.balance(&s.vault_addr), total_premiums);
}

// --- settle_delayed + claim ---

#[test]
fn test_settle_delayed_and_claim() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);

    buy_policy(&s, &t1);
    buy_policy(&s, &t2);

    // Simulate Controller sending payout funds from vault
    // (payoff - premium) * buyer_count = (50 - 10) * 2 = 80
    let payout_from_vault = (PAYOFF - PREMIUM) * 2;
    s.usdc_client.mint(&s.client.address, &payout_from_vault);

    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    // Pool now holds: premiums (20) + vault payout (80) = 100
    assert_eq!(usdc.balance(&s.client.address), PAYOFF * 2);

    // Set ledger timestamp within claim window
    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);

    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);
    assert_eq!(s.client.get_settlement_status(), SettlementStatus::SettledDelayed);
    assert_eq!(s.client.get_claim_expiry(), CLAIM_EXPIRY);

    // Traveler 1 claims
    s.client.claim(&t1);
    assert!(s.client.has_claimed(&t1));
    assert_eq!(usdc.balance(&t1), PAYOFF);
    assert_eq!(usdc.balance(&s.client.address), PAYOFF); // one claim remaining

    // Traveler 2 claims
    s.client.claim(&t2);
    assert!(s.client.has_claimed(&t2));
    assert_eq!(usdc.balance(&t2), PAYOFF);
    assert_eq!(usdc.balance(&s.client.address), 0);
}

#[test]
#[should_panic(expected = "already claimed")]
fn test_double_claim() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);

    let payout_from_vault = PAYOFF - PREMIUM;
    s.usdc_client.mint(&s.client.address, &payout_from_vault);

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);
    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);

    s.client.claim(&traveler);
    // Second claim should fail
    s.client.claim(&traveler);
}

// --- settle_cancelled + claim ---

#[test]
fn test_settle_cancelled_and_claim() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);

    let payout_from_vault = PAYOFF - PREMIUM;
    s.usdc_client.mint(&s.client.address, &payout_from_vault);

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);

    s.client.settle_cancelled(&s.controller, &CLAIM_EXPIRY);
    assert_eq!(s.client.get_settlement_status(), SettlementStatus::SettledCancelled);

    s.client.claim(&traveler);

    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&traveler), PAYOFF);
    assert!(s.client.has_claimed(&traveler));
}

// --- Claim expiry and sweep ---

#[test]
fn test_sweep_expired() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);
    let sweeper = Address::generate(&s.env);

    buy_policy(&s, &t1);
    buy_policy(&s, &t2);

    let payout_from_vault = (PAYOFF - PREMIUM) * 2;
    s.usdc_client.mint(&s.client.address, &payout_from_vault);

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);
    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);

    // Only t1 claims
    s.client.claim(&t1);

    let usdc = token::Client::new(&s.env, &s.usdc_addr);
    assert_eq!(usdc.balance(&s.client.address), PAYOFF); // t2's unclaimed payoff

    // Advance past claim expiry
    s.env.ledger().with_mut(|l| l.timestamp = CLAIM_EXPIRY + 1);

    s.client.sweep_expired(&sweeper);

    // All remaining USDC sent to RecoveryPool
    assert_eq!(usdc.balance(&s.client.address), 0);
    assert_eq!(usdc.balance(&s.recovery_addr), PAYOFF);
}

#[test]
#[should_panic(expected = "claim window still open")]
fn test_sweep_before_expiry() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    let sweeper = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.usdc_client.mint(&s.client.address, &(PAYOFF - PREMIUM));

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);
    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);

    // Try to sweep before expiry
    s.env.ledger().with_mut(|l| l.timestamp = CLAIM_EXPIRY);
    s.client.sweep_expired(&sweeper);
}

#[test]
#[should_panic(expected = "claim expired")]
fn test_claim_after_expiry() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.usdc_client.mint(&s.client.address, &(PAYOFF - PREMIUM));

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);
    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);

    // Advance past expiry
    s.env.ledger().with_mut(|l| l.timestamp = CLAIM_EXPIRY + 1);
    s.client.claim(&traveler);
}

// --- Authorization tests ---

#[test]
#[should_panic]
fn test_unauthorized_buy() {
    let env = Env::default();
    // No mock_all_auths
    let controller = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let vault = Address::generate(&env);
    let recovery = Address::generate(&env);

    let contract_id = env.register(
        FlightPool,
        (
            &controller,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &PREMIUM,
            &PAYOFF,
            &DELAY_HOURS,
            &usdc_id.address(),
            &vault,
            &recovery,
        ),
    );
    let client = FlightPoolClient::new(&env, &contract_id);
    let traveler = Address::generate(&env);

    // No auth — should panic
    client.buy_insurance(&controller, &traveler);
}

#[test]
#[should_panic(expected = "not controller")]
fn test_non_controller_buy() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let traveler = Address::generate(&s.env);

    s.client.buy_insurance(&stranger, &traveler);
}

#[test]
#[should_panic(expected = "not controller")]
fn test_non_controller_settle() {
    let s = setup();
    let stranger = Address::generate(&s.env);

    s.client.settle_on_time(&stranger);
}

#[test]
#[should_panic]
fn test_unauthorized_claim() {
    let env = Env::default();
    // No mock_all_auths
    let controller = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let vault = Address::generate(&env);
    let recovery = Address::generate(&env);

    let contract_id = env.register(
        FlightPool,
        (
            &controller,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &PREMIUM,
            &PAYOFF,
            &DELAY_HOURS,
            &usdc_id.address(),
            &vault,
            &recovery,
        ),
    );
    let client = FlightPoolClient::new(&env, &contract_id);
    let traveler = Address::generate(&env);

    // No auth — should panic
    client.claim(&traveler);
}

// --- Invalid state transition tests ---

#[test]
#[should_panic(expected = "not settled for payout")]
fn test_claim_before_settlement() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);

    // Try to claim while still Active
    s.client.claim(&traveler);
}

#[test]
#[should_panic(expected = "not settled for payout")]
fn test_claim_after_on_time_settlement() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.client.settle_on_time(&s.controller);

    // Can't claim after on-time — no payout
    s.client.claim(&traveler);
}

#[test]
#[should_panic(expected = "already settled")]
fn test_settle_twice() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.client.settle_on_time(&s.controller);
    // Can't settle again
    s.client.settle_on_time(&s.controller);
}

#[test]
#[should_panic(expected = "pool is settled")]
fn test_buy_after_settlement() {
    let s = setup();
    let t1 = Address::generate(&s.env);
    let t2 = Address::generate(&s.env);

    buy_policy(&s, &t1);
    s.client.settle_on_time(&s.controller);

    // Can't buy after settlement
    buy_policy(&s, &t2);
}

#[test]
#[should_panic(expected = "no policy")]
fn test_claim_without_policy() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.usdc_client.mint(&s.client.address, &(PAYOFF - PREMIUM));

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);
    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);

    // Stranger has no policy
    s.client.claim(&stranger);
}

// --- Event emission tests ---

#[test]
fn test_event_on_buy() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);

    let events = s.env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, s.client.address);
}

#[test]
fn test_event_on_settle() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.client.settle_on_time(&s.controller);

    let events = s.env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, s.client.address);
}

#[test]
fn test_event_on_claim() {
    let s = setup();
    let traveler = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.usdc_client.mint(&s.client.address, &(PAYOFF - PREMIUM));

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);
    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);
    s.client.claim(&traveler);

    let events = s.env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, s.client.address);
}

#[test]
fn test_event_on_sweep() {
    let s = setup();
    let traveler = Address::generate(&s.env);
    let sweeper = Address::generate(&s.env);

    buy_policy(&s, &traveler);
    s.usdc_client.mint(&s.client.address, &(PAYOFF - PREMIUM));

    s.env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE + 100);
    s.client.settle_delayed(&s.controller, &CLAIM_EXPIRY);

    // Don't claim, sweep after expiry
    s.env.ledger().with_mut(|l| l.timestamp = CLAIM_EXPIRY + 1);
    s.client.sweep_expired(&sweeper);

    let events = s.env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, s.client.address);
}
