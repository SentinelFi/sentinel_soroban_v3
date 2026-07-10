// Group 4 — Multi-actor / multi-flight scenarios.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, token, Address};

// =========================================================================
// Multiple buyers on the same flight
// =========================================================================

#[test]
fn multiple_buyers_same_flight() {
    let t = TestEnv::new();
    let t1 = Address::generate(&t.env);
    let t2 = Address::generate(&t.env);
    let t3 = Address::generate(&t.env);

    t.buy(&t1);
    t.buy(&t2);
    t.buy(&t3);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.buyer_count, 3);

    // Pool asset = 3 × premium, vault locked = 3 × payoff.
    assert_eq!(t.asset.balance(&t.pool_addr), 3 * PREMIUM);
    assert_eq!(t.vault.get_locked_capital(), 3 * PAYOFF);
}

// =========================================================================
// Multiple flights, independent settlements
// =========================================================================

#[test]
fn multiple_flights_independent_settlements() {
    let t = TestEnv::new();

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

    let traveler_a = Address::generate(&t.env);
    let traveler_b = Address::generate(&t.env);

    // Buy on both flights.
    t.buy(&traveler_a);
    t.asset_admin.mint(&traveler_b, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler_b,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
    );

    // Flight A → delayed; flight B → on-time. Flight B departs a day later,
    // so its arrival timestamps shift by a day too (arrivals must not precede
    // the departure date).
    t.oracle_delayed();
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("UA200"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
        &(EST_ARRIVAL + SECONDS_PER_DAY),
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("UA200"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
        &(ACTUAL_ON_TIME + SECONDS_PER_DAY),
    );

    t.classify_and_settle();

    // Flight A: pool holds payoff for traveler_a to claim.
    assert!(t.asset.balance(&t.pool_addr) > 0);
    let cfg_a = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg_a.status,
        flight_pool_manager::SettlementStatus::SettledDelayed
    );

    // Flight B: settled on-time.
    let cfg_b = t
        .pool
        .get_flight_config(&symbol_short!("UA200"), &(FLIGHT_DATE + SECONDS_PER_DAY))
        .unwrap();
    assert_eq!(
        cfg_b.status,
        flight_pool_manager::SettlementStatus::SettledOnTime
    );
}

// =========================================================================
// Per-traveler index across multiple flights
// =========================================================================

#[test]
fn traveler_index_across_multiple_flights() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    // Whitelist additional routes.
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    t.buy(&traveler);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
    );

    let flights = t.ctrl.get_flights_for_traveler(&traveler);
    assert_eq!(flights.len(), 2);
    assert_eq!(
        flights.get(0).unwrap(),
        (symbol_short!("AA100"), FLIGHT_DATE)
    );
    assert_eq!(
        flights.get(1).unwrap(),
        (symbol_short!("UA200"), FLIGHT_DATE + SECONDS_PER_DAY)
    );
}

#[test]
fn traveler_with_multiple_routes() {
    // Same traveler across 3 different routes — all show in their index.
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);

    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("DL300"),
        &symbol_short!("ATL"),
        &symbol_short!("BOS"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    t.buy(&traveler);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
    );
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("DL300"),
        &symbol_short!("ATL"),
        &symbol_short!("BOS"),
        &(FLIGHT_DATE + 2 * SECONDS_PER_DAY),
    );

    assert_eq!(t.ctrl.get_flights_for_traveler(&traveler).len(), 3);
}

#[test]
#[should_panic(expected = "Error(Contract, #411)")]
fn same_traveler_double_buy_same_flight_panics() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.buy(&traveler);
}

#[test]
fn concurrent_underwriters_share_payout_burden() {
    let t = TestEnv::new();
    let asset_admin = token::StellarAssetClient::new(&t.env, &t.asset_addr);

    // Add a second underwriter with a smaller deposit.
    let underwriter2 = Address::generate(&t.env);
    asset_admin.mint(&underwriter2, &500_0000000);
    t.vault
        .deposit(&500_0000000, &underwriter2, &underwriter2, &underwriter2);

    let tma_before = t.vault.get_total_managed_assets();
    assert_eq!(tma_before, DEPOSIT_AMOUNT + 500_0000000);

    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_delayed();
    t.classify_and_settle();

    // Delayed settlement: vault sends (payoff - premium) × buyers to pool.
    // Premium stays in pool. So TMA decreases by (payoff - premium) × 1.
    // Both underwriters' shares are proportionally diluted in value.
    assert_eq!(
        t.vault.get_total_managed_assets(),
        tma_before - (PAYOFF - PREMIUM)
    );
}

#[test]
fn five_travelers_same_flight_lifecycle() {
    let t = TestEnv::new();

    let mut travelers = Vec::new();
    for _ in 0..5 {
        let tr = Address::generate(&t.env);
        t.buy(&tr);
        travelers.push(tr);
    }

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.buyer_count, 5);
    assert_eq!(t.asset.balance(&t.pool_addr), 5 * PREMIUM);
    assert_eq!(t.vault.get_locked_capital(), 5 * PAYOFF);

    t.oracle_delayed();
    t.classify_and_settle();

    // Pool now has 5 × payoff for all 5 travelers to claim.
    assert_eq!(t.asset.balance(&t.pool_addr), 5 * PAYOFF);

    // Each travels claims, balance increases by payoff.
    for tr in &travelers {
        t.pool.claim(tr, &symbol_short!("AA100"), &FLIGHT_DATE);
        assert_eq!(t.asset.balance(tr), PAYOFF);
    }
    assert_eq!(t.asset.balance(&t.pool_addr), 0);
}
