// Group 7 — Governance flows (end-to-end).

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Address};

// =========================================================================
// whitelist + buy
// =========================================================================

#[test]
fn whitelist_route_then_buy_succeeds() {
    let t = TestEnv::new();
    // setup() already whitelisted AA100. Test that a fresh whitelist
    // (different route) also lets buy_insurance succeed.
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    let traveler = Address::generate(&t.env);
    t.open_sale(&symbol_short!("UA200"), FLIGHT_DATE + SECONDS_PER_DAY);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
    );
}

// =========================================================================
// disable / enable / unknown
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #307)")]
fn disable_route_blocks_new_purchase() {
    let t = TestEnv::new();
    t.gov.disable_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
}

#[test]
fn enable_after_disable_unblocks_purchase() {
    let t = TestEnv::new();
    t.gov.disable_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );
    t.gov.enable_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );
    let traveler = Address::generate(&t.env);
    t.buy(&traveler); // should succeed
}

#[test]
#[should_panic(expected = "Error(Contract, #308)")]
fn unknown_route_blocks_purchase() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("ZZ999"),
        &symbol_short!("XXX"),
        &symbol_short!("YYY"),
        &FLIGHT_DATE,
    );
}

// =========================================================================
// Term updates: locked at registration
// =========================================================================

#[test]
fn update_terms_doesnt_affect_existing_flights() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    // After registration, change the route's terms drastically.
    t.gov.update_route_terms(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &governance_module::PremiumUpdate::Set(99_0000000),
        &governance_module::PayoffUpdate::Set(999_0000000),
        &governance_module::DelayHoursUpdate::Set(1u32),
    );

    // Existing flight uses the OLD terms (locked at registration).
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.premium, PREMIUM);
    assert_eq!(cfg.payoff, PAYOFF);
    assert_eq!(cfg.delay_hours, DELAY_HOURS);
}

// =========================================================================
// Defaults change resolution
// =========================================================================

#[test]
fn set_defaults_changes_resolved_terms_for_use_default_routes() {
    let t = TestEnv::new();
    // The default route uses default terms (None for premium/payoff/delay).
    // route_status should resolve to setup defaults.
    match t.gov.route_status(
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    ) {
        governance_module::RouteStatus::Active(t1) => {
            assert_eq!(t1.premium, PREMIUM);
        }
        _ => panic!("expected Active"),
    }

    // Owner changes defaults.
    t.gov.set_defaults(&100_0000000, &1000_0000000, &4u32);

    // route_status now resolves to NEW defaults (UseDefault routes track gov).
    match t.gov.route_status(
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    ) {
        governance_module::RouteStatus::Active(t2) => {
            assert_eq!(t2.premium, 100_0000000);
            assert_eq!(t2.payoff, 1000_0000000);
            assert_eq!(t2.delay_hours, 4);
        }
        _ => panic!("expected Active"),
    }
}

// =========================================================================
// Admin role
// =========================================================================

#[test]
fn admin_can_whitelist_and_disable() {
    let t = TestEnv::new();
    let admin = Address::generate(&t.env);
    t.gov.add_admin(&admin);
    assert!(t.gov.is_admin(&admin));

    // Admin whitelists a new route.
    t.gov.whitelist_route(
        &admin,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Admin disables the same route.
    t.gov.disable_route(
        &admin,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
    );

    assert_eq!(
        t.gov.route_status(
            &symbol_short!("UA200"),
            &symbol_short!("SFO"),
            &symbol_short!("ORD"),
        ),
        governance_module::RouteStatus::Disabled
    );
}

// =========================================================================
// remove_route strict — must be disabled first
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #508)")]
fn remove_route_panics_on_active_route() {
    let t = TestEnv::new();
    // Route is still Active (whitelisted in setup) — remove must panic.
    t.gov.remove_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );
}

#[test]
fn remove_route_succeeds_after_disable() {
    let t = TestEnv::new();
    t.gov.disable_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );
    t.gov.remove_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );

    // Status is Unknown after removal.
    assert_eq!(
        t.gov.route_status(
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
        ),
        governance_module::RouteStatus::Unknown
    );
}
