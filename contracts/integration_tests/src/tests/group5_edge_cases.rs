// Group 5 — Edge cases: prune_settled, sweep_expired, withdraw_recovered,
// snapshot expiry, ttl_miss diagnostic.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, testutils::Ledger as _, Address};

const SECONDS_PER_DAY: u64 = 86_400;

// =========================================================================
// prune_settled
// =========================================================================

#[test]
fn prune_settled_after_30d_evicts_aged_flights() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.classify_and_settle();

    // Flight is settled but still in the active list.
    assert_eq!(t.oracle.get_active_flights().len(), 1);

    // Advance well past the settled-flight retention window.
    t.advance_time(30 * SECONDS_PER_DAY + 1);

    t.oracle.prune_settled();
    assert_eq!(t.oracle.get_active_flights().len(), 0);
}

#[test]
fn prune_settled_idempotent() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.classify_and_settle();

    t.advance_time(30 * SECONDS_PER_DAY + 1);
    t.oracle.prune_settled();
    t.oracle.prune_settled(); // second call is a no-op
    assert_eq!(t.oracle.get_active_flights().len(), 0);
}

#[test]
fn prune_settled_callable_by_anyone() {
    // The function takes no caller arg — anyone with gas pays.
    // Just confirm the call succeeds in the non-keeper context.
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.classify_and_settle();
    t.advance_time(30 * SECONDS_PER_DAY + 1);
    // No specific caller passed — same client, same env, no panic.
    t.oracle.prune_settled();
}

#[test]
fn prune_settled_no_op_before_retention_window() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.classify_and_settle();

    // Only advance 6 days — still within the retention window, flight stays.
    t.advance_time(6 * SECONDS_PER_DAY);
    t.oracle.prune_settled();
    assert_eq!(t.oracle.get_active_flights().len(), 1);
}

// =========================================================================
// sweep_expired + withdraw_recovered
// =========================================================================

#[test]
fn sweep_expired_after_claim_window() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();

    // Skip the claim — wait out the claim window.
    t.advance_time(CLAIM_EXPIRY_WINDOW + 1);

    let recovered_before = t.pool.get_recovered_balance();
    assert_eq!(recovered_before, 0);

    t.pool.sweep_expired(&symbol_short!("AA100"), &FLIGHT_DATE);

    // RecoveredBalance now holds the unclaimed payoff.
    assert_eq!(t.pool.get_recovered_balance(), PAYOFF);
}

#[test]
fn sweep_expired_idempotent() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();

    t.advance_time(CLAIM_EXPIRY_WINDOW + 1);

    t.pool.sweep_expired(&symbol_short!("AA100"), &FLIGHT_DATE);
    let after_first = t.pool.get_recovered_balance();

    // Second sweep is a no-op.
    t.pool.sweep_expired(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(t.pool.get_recovered_balance(), after_first);
}

#[test]
fn withdraw_recovered_by_owner() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();

    t.advance_time(CLAIM_EXPIRY_WINDOW + 1);
    t.pool.sweep_expired(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(t.pool.get_recovered_balance(), PAYOFF);

    let owner_balance_before = t.asset.balance(&t.owner);
    t.pool.withdraw_recovered(&PAYOFF);

    assert_eq!(t.asset.balance(&t.owner), owner_balance_before + PAYOFF);
    assert_eq!(t.pool.get_recovered_balance(), 0);
}

// =========================================================================
// SnapshotPrice expiry
// =========================================================================

#[test]
fn snapshot_expires_after_30d() {
    let t = TestEnv::new();
    // Trigger a snapshot via a settle pass.
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.classify_and_settle();

    let day = INITIAL_TIMESTAMP / SECONDS_PER_DAY;
    let price_fresh = t.vault.get_snapshot_price(&day);
    assert!(price_fresh > 0);

    // Advance time + ledger sequence past the 30-day TTL.
    t.env.ledger().with_mut(|li| {
        li.sequence_number += 30 * 24 * 60 * 12 + 1;
        li.timestamp = INITIAL_TIMESTAMP + 31 * SECONDS_PER_DAY;
    });
    assert_eq!(t.vault.get_snapshot_price(&day), 0);
}

// =========================================================================
// ttl_miss diagnostic
// =========================================================================

#[test]
fn ttl_miss_emitted_on_classify_with_missing_oracle_data() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    // Flight is registered in oracle (NotInitiated) but no oracle data
    // pushed — classify should emit ttl_miss.

    t.ctrl.classify_flights(&t.keeper);

    assert!(
        count_events_with_single_prefix(&t.env, &t.ctrl_addr, symbol_short!("ttl_miss"),) >= 1,
        "expected sentinel.ttl_miss event for NotInitiated flight"
    );
}
