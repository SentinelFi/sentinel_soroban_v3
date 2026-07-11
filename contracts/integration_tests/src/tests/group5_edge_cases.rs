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

// =========================================================================
// Stale unconfirmed flight — void path
// =========================================================================

#[test]
fn stale_unconfirmed_flight_voided_and_collateral_released() {
    // A purchase for a date that never matches a physical flight leaves the
    // oracle row NotInitiated forever: no outcome can arrive, so without a
    // timeout the payoff collateral and the policy bucket would be pinned
    // indefinitely. Once the flight is well past departure with still no
    // data, the keeper voids it — settled like an on-time flight: premiums
    // become vault yield, collateral is released, and nothing is payable
    // (paying out on a flight that provably never flew would let anyone mint
    // guaranteed claims from bogus dates).
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler); // no oracle data will ever follow
    let tma_before = t.vault.get_total_managed_assets();
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    // Within the stale window the keeper leaves the flight alone.
    t.classify_and_settle();
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    // Past departure + stale timeout, the next keeper cycle voids it.
    t.advance_time(FLIGHT_DATE - INITIAL_TIMESTAMP + 14 * SECONDS_PER_DAY + 1);
    t.classify_and_settle();

    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before + PREMIUM);
    assert_eq!(
        t.oracle
            .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Settled
    );
    assert!(!t.oracle.has_pending_outcomes());
    assert!(t
        .pool
        .try_claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE)
        .is_err());
}

#[test]
fn stale_flight_void_releases_full_sybil_collateral() {
    // The capital-lockup attack is Sybil-amplified: N addresses each buy one
    // policy for the same bogus date, locking N × payoff. The void must
    // release the FULL locked amount and credit every premium — a partial
    // release would leave phantom locked capital shrinking free capital
    // forever.
    let t = TestEnv::new();
    let buyers: [Address; 3] = [
        Address::generate(&t.env),
        Address::generate(&t.env),
        Address::generate(&t.env),
    ];
    for b in buyers.iter() {
        t.buy(b);
    }
    let tma_before = t.vault.get_total_managed_assets();
    assert_eq!(t.vault.get_locked_capital(), 3 * PAYOFF);

    t.advance_time(FLIGHT_DATE - INITIAL_TIMESTAMP + 14 * SECONDS_PER_DAY + 1);
    t.classify_and_settle();

    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before + 3 * PREMIUM);
    for b in buyers.iter() {
        assert!(t
            .pool
            .try_claim(b, &symbol_short!("AA100"), &FLIGHT_DATE)
            .is_err());
    }
}

#[test]
fn settlement_barrier_holds_through_void_classification_window() {
    // Voiding a flight is a public disclosure of unrecognized vault PnL
    // (its premiums become yield at settlement). Between classification and
    // settlement the LP entry/exit barrier must be up — otherwise an LP could
    // exit or enter at the pre-income share price — and must lift once the
    // void settles.
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.advance_time(FLIGHT_DATE - INITIAL_TIMESTAMP + 14 * SECONDS_PER_DAY + 1);

    // Classify only — the void is now pending but unsettled.
    t.ctrl.classify_flights(&t.keeper);
    assert!(t.oracle.has_pending_outcomes());
    let lp = Address::generate(&t.env);
    t.asset_admin.mint(&lp, &DEPOSIT_AMOUNT);
    assert!(t.vault.try_deposit(&DEPOSIT_AMOUNT, &lp, &lp, &lp).is_err());

    // Settlement recognizes the PnL and the barrier lifts.
    t.ctrl.execute_settlements(&t.keeper);
    assert!(!t.oracle.has_pending_outcomes());
    t.vault.deposit(&DEPOSIT_AMOUNT, &lp, &lp, &lp);
}

#[test]
fn active_flight_not_voided_before_terminal_timeout() {
    // The NotInitiated stale-void never applies once an estimated arrival is
    // recorded: the flight is real and must wait for a genuine outcome — a
    // delayed data feed must not convert a possibly-delayed flight into an
    // on-time settlement. The wait is bounded, not infinite: the row holds
    // through the entire active timeout past its scheduled arrival, and only
    // then does the terminal-liveness fallback void it (see
    // lifecycle_active_timeout_void in group 1).
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );

    // One second short of the active timeout — long past the stale timeout
    // that voids dataless rows.
    let now = t.env.ledger().timestamp();
    t.advance_time(EST_ARRIVAL + sentinel_types::timeouts::ACTIVE_FLIGHT_TIMEOUT_SECS - 1 - now);
    t.classify_and_settle();

    // Untouched: still Active, collateral still locked, awaiting an outcome.
    assert_eq!(
        t.oracle
            .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Active
    );
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);
}
