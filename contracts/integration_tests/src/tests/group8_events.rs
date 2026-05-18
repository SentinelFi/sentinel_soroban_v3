// Group 8 — End-to-end event chain verification.
//
// Each test exercises a complete protocol path and asserts the full event
// chain that the off-chain indexer consumes. Topic-level assertions only —
// payload deserialization is the indexer's job.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, token, Address};

// =========================================================================
// buy_insurance event chain
// =========================================================================

#[test]
fn buy_path_emits_full_chain() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    t.usdc_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );

    // Controller's InsuranceBought event uses ["ctrl"] single-prefix.
    assert!(
        count_events_with_single_prefix(&t.env, &t.ctrl_addr, symbol_short!("ctrl")) >= 1,
        "expected ctrl event from controller"
    );

    // FlightPoolManager's FlightRegistered event uses ["register"].
    assert!(
        count_events_with_single_prefix(&t.env, &t.pool_addr, symbol_short!("register")) >= 1,
        "expected register event from FPM"
    );

    // FlightPoolManager's BuyerAdded event uses ["buyer"].
    assert!(
        count_events_with_single_prefix(&t.env, &t.pool_addr, symbol_short!("buyer")) >= 1,
        "expected buyer event from FPM"
    );

    // OracleAggregator's FlightStatusChange event uses ["flight"].
    assert!(
        count_events_with_single_prefix(&t.env, &t.oracle_addr, symbol_short!("flight")) >= 1,
        "expected flight event from oracle"
    );
}

// =========================================================================
// classify_flights event chain
// =========================================================================

#[test]
fn classify_emits_flight_classified_and_oracle_status_event() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();

    t.ctrl.classify_flights(&t.keeper);

    // Controller's FlightClassified event.
    assert!(
        count_events_with_single_prefix(&t.env, &t.ctrl_addr, symbol_short!("ctrl")) >= 1,
        "expected ctrl event from classify"
    );
    // Oracle's status-change event when set_to_be_settled fires.
    assert!(
        count_events_with_single_prefix(&t.env, &t.oracle_addr, symbol_short!("flight")) >= 1,
        "expected flight event from oracle on status change"
    );
}

// =========================================================================
// execute_settlements event chain
// =========================================================================

#[test]
fn settle_emits_full_chain() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.ctrl.classify_flights(&t.keeper);

    t.ctrl.execute_settlements(&t.keeper);

    // Controller's FlightSettledEvent (ctrl prefix).
    assert!(
        count_events_with_single_prefix(&t.env, &t.ctrl_addr, symbol_short!("ctrl")) >= 1,
        "expected ctrl event from execute_settlements"
    );
    // FPM's FlightSettled (settle prefix).
    assert!(
        count_events_with_single_prefix(&t.env, &t.pool_addr, symbol_short!("settle")) >= 1,
        "expected settle event from FPM"
    );
    // Oracle's status change to Settled.
    assert!(
        count_events_with_single_prefix(&t.env, &t.oracle_addr, symbol_short!("flight")) >= 1,
        "expected flight event from oracle"
    );
}

// =========================================================================
// vault.* event chain through underwriter lifecycle
// =========================================================================

#[test]
fn vault_credited_collected_chain_via_underwriter_lifecycle() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    let shares = t.vault.balance(&t.underwriter);
    t.vault.request_withdrawal(&t.underwriter, &(shares / 2));

    t.oracle_on_time();
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    // execute_settlements is the most-recent invocation. It triggered
    // process_withdrawal_queue → Credited event.
    assert!(
        count_events_with_topic(
            &t.env,
            &t.vault_addr,
            symbol_short!("vault"),
            symbol_short!("credited"),
        ) >= 1,
        "expected vault.credited event"
    );

    // Now collect — this is the next most-recent invocation.
    t.vault.collect(&t.underwriter);
    assert!(
        count_events_with_topic(
            &t.env,
            &t.vault_addr,
            symbol_short!("vault"),
            symbol_short!("collected"),
        ) >= 1,
        "expected vault.collected event"
    );
}

#[test]
fn vault_recovered_recredit_and_transfer_modes_emit_correct_topics() {
    let t = TestEnv::new();
    let user_a = Address::generate(&t.env);
    let user_b = Address::generate(&t.env);

    // Recredit path
    t.vault.recover_uncollected(
        &user_a,
        &100_0000000,
        &risk_vault::RecoveryMode::Recredit,
    );
    assert!(
        count_events_with_topic(
            &t.env,
            &t.vault_addr,
            symbol_short!("vault"),
            symbol_short!("recovered"),
        ) >= 1,
        "expected vault.recovered event for Recredit mode"
    );

    // Transfer path (seed vault with USDC and prior credit first)
    let usdc_admin = token::StellarAssetClient::new(&t.env, &t.usdc_addr);
    usdc_admin.mint(&t.vault_addr, &50_0000000);
    t.vault.recover_uncollected(
        &user_b,
        &50_0000000,
        &risk_vault::RecoveryMode::Recredit,
    );
    t.vault.recover_uncollected(
        &user_b,
        &50_0000000,
        &risk_vault::RecoveryMode::Transfer,
    );
    assert!(
        count_events_with_topic(
            &t.env,
            &t.vault_addr,
            symbol_short!("vault"),
            symbol_short!("recovered"),
        ) >= 1,
        "expected vault.recovered event for Transfer mode"
    );
}

// =========================================================================
// ttl_miss diagnostic event topic shape
// =========================================================================

#[test]
fn ttl_miss_warn_event_topic_shape() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    // Skip oracle data push so flight stays NotInitiated.

    t.ctrl.classify_flights(&t.keeper);

    // The TtlMiss event has 2-symbol prefix ["warn", "ttl_miss"].
    assert!(
        count_events_with_topic(
            &t.env,
            &t.ctrl_addr,
            symbol_short!("warn"),
            symbol_short!("ttl_miss"),
        ) >= 1,
        "expected warn.ttl_miss event"
    );
}
