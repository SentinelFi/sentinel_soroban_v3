// Group 1 — Flight lifecycle: three settlement outcomes (on-time / delayed
// / cancelled) plus claim variants and panic guards.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Address};

// =========================================================================
// On-time lifecycle — premium → vault as yield, no payout
// =========================================================================

#[test]
fn lifecycle_on_time() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    t.buy(&traveler);
    let tma_before = t.vault.get_total_managed_assets();
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    t.oracle_on_time();
    t.classify_and_settle();

    // Premium recorded as yield, collateral released.
    assert_eq!(t.vault.get_total_managed_assets(), tma_before + PREMIUM);
    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.asset.balance(&t.pool_addr), 0);
    assert_eq!(t.asset.balance(&traveler), 0);

    // Oracle settled.
    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);
    assert!(data.settled_at != 0);
}

// =========================================================================
// Delayed lifecycle — vault funds payout, traveler claims
// =========================================================================

#[test]
fn lifecycle_delayed() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();

    // Pool now holds the full payoff for the traveler to claim.
    assert_eq!(t.asset.balance(&t.pool_addr), PAYOFF);
    assert_eq!(t.vault.get_locked_capital(), 0);

    // Traveler claims.
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&traveler), PAYOFF);
}

// =========================================================================
// Cancelled lifecycle — same money flow as delayed; oracle path differs
// =========================================================================

#[test]
fn lifecycle_cancelled() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    t.buy(&traveler);
    t.oracle_cancelled();
    t.classify_and_settle();

    assert_eq!(t.asset.balance(&t.pool_addr), PAYOFF);
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledCancelled
    );

    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&traveler), PAYOFF);
}

#[test]
fn lifecycle_cancelled_before_eta_recorded() {
    // A cancellation can become known before the executor ever stored an ETA
    // (NotInitiated → Cancelled, no set_estimated_arrival). The existing
    // policy must still settle and pay out through the normal pipeline, and
    // later buyers must be rejected the moment the cancellation is recorded.
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    t.oracle
        .set_cancelled(&t.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);

    // A second buyer can no longer join the cancelled flight.
    let late = Address::generate(&t.env);
    t.asset_admin.mint(&late, &PREMIUM);
    assert!(t
        .ctrl
        .try_buy_insurance(
            &late,
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &FLIGHT_DATE,
        )
        .is_err());

    t.classify_and_settle();
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&traveler), PAYOFF);
}

#[test]
fn preemptive_cancellation_blocks_all_purchases_without_jamming_protocol() {
    // A flight publicly cancelled before ANY purchase has no oracle record to
    // close — the oracle writes the cancellation first, creating a
    // purchase-blocking record. Every would-be buyer (Sybil sets included) is
    // rejected, so nobody converts the known cancellation into a guaranteed
    // claim. Because no policy exists, the record must not enter the
    // settlement pipeline: no pending outcome blocks LP entry/exit, keeper
    // cycles stay clean, and unrelated flights settle normally.
    let t = TestEnv::new();

    t.oracle
        .set_cancelled(&t.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);

    // First buyer and a second (Sybil) address are both rejected.
    for _ in 0..2 {
        let buyer = Address::generate(&t.env);
        t.asset_admin.mint(&buyer, &PREMIUM);
        assert!(t
            .ctrl
            .try_buy_insurance(
                &buyer,
                &symbol_short!("AA100"),
                &symbol_short!("JFK"),
                &symbol_short!("LAX"),
                &FLIGHT_DATE,
            )
            .is_err());
    }

    // No policies → no pending PnL: the vault's settlement barrier stays
    // lifted and LPs can still enter.
    assert!(!t.oracle.has_pending_outcomes());
    let lp = Address::generate(&t.env);
    t.asset_admin.mint(&lp, &DEPOSIT_AMOUNT);
    t.vault.deposit(&DEPOSIT_AMOUNT, &lp, &lp, &lp);

    // Keeper cycles run clean and an unrelated flight completes its full
    // cancelled lifecycle alongside the tombstoned one.
    let other = symbol_short!("UA200");
    t.gov.whitelist_route(
        &t.owner,
        &other,
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    let traveler = Address::generate(&t.env);
    t.buy_flight(&traveler, &other, FLIGHT_DATE);
    t.oracle
        .set_estimated_arrival(&t.oracle_account, &other, &FLIGHT_DATE, &EST_ARRIVAL);
    t.oracle
        .set_cancelled(&t.oracle_account, &other, &FLIGHT_DATE);
    t.classify_and_settle();
    t.pool.claim(&traveler, &other, &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&traveler), PAYOFF);
}

// =========================================================================
// Boundary conditions on delay threshold
// =========================================================================

#[test]
fn lifecycle_marginal_on_time() {
    // delay = (3h - 1s) → on-time path
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    t.buy(&traveler);

    let est = EST_ARRIVAL;
    let actual = est + (DELAY_HOURS as u64) * 3600 - 1;
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &est,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &actual,
    );
    t.classify_and_settle();

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
fn lifecycle_marginal_delayed() {
    // delay = exactly delay_hours → delayed path (>= threshold)
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    t.buy(&traveler);

    let est = EST_ARRIVAL;
    let actual = est + (DELAY_HOURS as u64) * 3600;
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &est,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &actual,
    );
    t.classify_and_settle();

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledDelayed
    );
}

// =========================================================================
// Claim happy paths and guards
// =========================================================================

#[test]
fn claim_after_delayed_succeeds() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();

    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
    assert!(t
        .pool
        .has_claimed(&symbol_short!("AA100"), &FLIGHT_DATE, &traveler));
}

#[test]
fn claim_after_cancelled_succeeds() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_cancelled();
    t.classify_and_settle();

    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
    assert!(t
        .pool
        .has_claimed(&symbol_short!("AA100"), &FLIGHT_DATE, &traveler));
}

#[test]
#[should_panic(expected = "Error(Contract, #412)")]
fn claim_panics_on_time() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.classify_and_settle();
    // Status is SettledOnTime — claim must panic.
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #415)")]
fn claim_panics_double_claim() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
    // Second call panics.
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #413)")]
fn claim_panics_after_expiry() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();
    // Advance past claim_expiry (60 days + 1 second).
    t.advance_time(CLAIM_EXPIRY_WINDOW + 1);
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);
}
