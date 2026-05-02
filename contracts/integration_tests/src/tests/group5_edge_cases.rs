use super::setup::*;
use soroban_sdk::testutils::Address as _;

#[test]
#[should_panic]
fn test_5a_buy_after_settlement_fails() {
    let t = TestEnv::new();
    let t1 = soroban_sdk::Address::generate(&t.env);

    t.buy(&t1);
    t.oracle_on_time();
    t.classify_and_settle();

    // After settlement, Controller removes pool from active list.
    // Buying again tries to deploy a new pool + register_flight in oracle,
    // but oracle rejects ("flight already registered").
    let t2 = soroban_sdk::Address::generate(&t.env);
    t.buy(&t2);
}

#[test]
#[should_panic]
fn test_5b_claim_without_policy() {
    let t = TestEnv::new();
    let traveler = soroban_sdk::Address::generate(&t.env);
    let stranger = soroban_sdk::Address::generate(&t.env);

    t.buy(&traveler);
    let pool_addr = t.pool_addr();

    t.oracle_delayed();
    t.classify_and_settle();

    // FlightPool deployed via WASM — panics as WasmVm error, not assert message
    let pool = t.pool_client(&pool_addr);
    pool.claim(&stranger);
}

#[test]
#[should_panic]
fn test_5c_double_claim() {
    let t = TestEnv::new();
    let traveler = soroban_sdk::Address::generate(&t.env);

    t.buy(&traveler);
    let pool_addr = t.pool_addr();

    t.oracle_delayed();
    t.classify_and_settle();

    let pool = t.pool_client(&pool_addr);
    pool.claim(&traveler);
    pool.claim(&traveler);
}

#[test]
#[should_panic]
fn test_5d_sweep_before_expiry() {
    let t = TestEnv::new();
    let traveler = soroban_sdk::Address::generate(&t.env);
    let sweeper = soroban_sdk::Address::generate(&t.env);

    t.buy(&traveler);
    let pool_addr = t.pool_addr();

    t.oracle_delayed();
    t.classify_and_settle();

    let pool = t.pool_client(&pool_addr);
    pool.sweep_expired(&sweeper);
}

#[test]
fn test_5e_classify_no_ready_flights() {
    let t = TestEnv::new();
    let traveler = soroban_sdk::Address::generate(&t.env);

    t.buy(&traveler);

    // Oracle has NOT reported any data yet (flight still NotInitiated in oracle)
    // But wait — the oracle sets estimated arrival, not Controller.
    // The flight is registered as NotInitiated. classify_flights should skip it.

    // This should be a no-op — no panic
    t.ctrl.classify_flights(&t.keeper);

    // Flight still active
    assert_eq!(t.ctrl.get_active_pools().len(), 1);

    // Now set oracle to Active (estimated arrival set, but not yet landed)
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &soroban_sdk::symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );

    // Still a no-op — Active flights are not classified, only Landed/Cancelled
    t.ctrl.classify_flights(&t.keeper);
    assert_eq!(t.ctrl.get_active_pools().len(), 1);
}
