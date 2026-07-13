// Group 9 — Phase 11 buyer-whitelist end-to-end.
//
// These exercise the whitelist gate through the live cross-contract wiring:
// real GovernanceModule admins gating add/remove on Controller, the toggle
// flipping on/off, and the gate interacting with the existing pausable +
// solvency checks. Unit tests in controller/src/test.rs cover the
// fine-grained branches; here we validate the wiring under realistic
// contract auth + cross-contract calls.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Symbol};

const FLIGHT_DATE_2: u64 = FLIGHT_DATE + 7 * 24 * 60 * 60;

fn add_gov_admin(t: &TestEnv) -> Address {
    let admin = Address::generate(&t.env);
    t.gov.add_admin(&admin);
    admin
}

// =========================================================================
// Toggle off (default) — open buy_insurance
// =========================================================================

#[test]
fn whitelist_off_allows_any_buyer() {
    let t = TestEnv::new();
    assert!(!t.ctrl.whitelist_enabled());

    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    let (sold, collected, _) = t.ctrl.get_stats();
    assert_eq!(sold, 1);
    assert_eq!(collected, PREMIUM);
}

// =========================================================================
// Toggle on — gate blocks unknown buyers, allows whitelisted
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #306)")]
fn whitelist_on_blocks_non_whitelisted() {
    let t = TestEnv::new();
    t.ctrl.set_whitelist_enabled(&true);

    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
}

#[test]
fn whitelist_on_allows_whitelisted_buyer() {
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));

    t.buy(&traveler);
    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 1);
}

// =========================================================================
// Admin gate — governance admin works through Controller; stranger fails
// =========================================================================

#[test]
fn gov_admin_can_manage_whitelist() {
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));

    t.ctrl.remove_whitelisted_buyer(&admin, &traveler);
    assert!(!t.ctrl.is_whitelisted(&traveler));
}

#[test]
#[should_panic(expected = "Error(Contract, #305)")]
fn stranger_cannot_add_whitelisted_buyer() {
    let t = TestEnv::new();
    let stranger = Address::generate(&t.env);
    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&stranger, &traveler);
}

#[test]
#[should_panic(expected = "Error(Contract, #305)")]
fn removed_gov_admin_loses_whitelist_authority() {
    // Admin loses authority the moment governance.remove_admin lands.
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);
    t.gov.remove_admin(&admin);

    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
}

// =========================================================================
// Toggle round-trip across multiple buys
// =========================================================================

#[test]
fn toggle_off_then_on_then_off_buy_cycle() {
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);

    // Off → anyone can buy.
    let traveler1 = Address::generate(&t.env);
    t.buy(&traveler1);

    // Whitelist a second route + flight so we can buy at distinct dates
    // without triggering address-replay issues.
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // On → only whitelisted.
    t.ctrl.set_whitelist_enabled(&true);
    let traveler2 = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler2);
    t.buy_flight(&traveler2, &symbol_short!("AA100"), FLIGHT_DATE_2);

    // Off again → strangers can buy without being on the list.
    t.ctrl.set_whitelist_enabled(&false);
    let traveler3 = Address::generate(&t.env);
    t.open_sale(&symbol_short!("UA200"), FLIGHT_DATE_2);
    t.asset_admin.mint(&traveler3, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler3,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &FLIGHT_DATE_2,
    );

    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 3);
}

// =========================================================================
// Approval lifetime — explicit deadline, not storage TTL
// =========================================================================

/// 180 days — mirrors the controller's buyer-approval window.
const APPROVAL_WINDOW_SECS: u64 = 15_552_000;

/// Next day-aligned date at least `days` days from the current ledger time.
fn future_date(t: &TestEnv, days: u64) -> u64 {
    let now = t.env.ledger().timestamp();
    ((now / SECONDS_PER_DAY) + days) * SECONDS_PER_DAY
}

#[test]
fn dormant_approval_expires_even_though_entry_persists() {
    // The approval deadline is contract-checked state, so it must lapse by
    // the ledger clock alone. The stored entry deliberately survives here
    // (nothing archives in tests) — exactly the state a Protocol 23+
    // restoration produces, where an archived entry comes back with its
    // original value instead of reading as absent.
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));

    // Dormant past the full window: the approval lapses without any write.
    t.advance_time(APPROVAL_WINDOW_SECS + 1);
    assert!(!t.ctrl.is_whitelisted(&traveler));

    let date = future_date(&t, 3);
    t.open_sale(&symbol_short!("AA100"), date);
    t.asset_admin.mint(&traveler, &PREMIUM);
    let res = t.ctrl.try_buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &date,
    );
    assert!(res.is_err(), "lapsed approval must fail closed");

    // Recovery is one admin call — re-attestation restarts the window.
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &date,
    );
}

#[test]
fn active_buyer_approval_slides_forward_on_each_purchase() {
    // An actively-buying approved address must never need re-approval: each
    // gated purchase pushes the deadline a full window past the purchase
    // time, so only genuine dormancy lapses.
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);

    // Buy shortly before the original deadline would hit.
    t.advance_time(APPROVAL_WINDOW_SECS - SECONDS_PER_DAY);
    let date1 = future_date(&t, 3);
    t.open_sale(&symbol_short!("AA100"), date1);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &date1,
    );

    // Well past the ORIGINAL deadline, but inside the slid window: the
    // purchase above renewed the approval, so the buyer is still valid.
    t.advance_time(2 * SECONDS_PER_DAY);
    assert!(t.ctrl.is_whitelisted(&traveler));

    let date2 = future_date(&t, 3);
    t.open_sale(&symbol_short!("AA100"), date2);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &date2,
    );
}

// =========================================================================
// Whitelist persists through end-to-end lifecycle
// =========================================================================

#[test]
fn whitelisted_buyer_completes_delayed_lifecycle() {
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    t.buy(&traveler);

    t.oracle_delayed();
    t.classify_and_settle();
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);

    assert_eq!(t.asset.balance(&traveler), PAYOFF);
}

// =========================================================================
// Whitelist + Pausable — admin paths stay open under pause
// =========================================================================

#[test]
fn admin_can_manage_whitelist_during_pause() {
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);

    t.ctrl.pause(&t.owner);
    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));

    t.ctrl.remove_whitelisted_buyer(&admin, &traveler);
    assert!(!t.ctrl.is_whitelisted(&traveler));
}

#[test]
fn owner_can_toggle_whitelist_during_pause() {
    let t = TestEnv::new();
    t.ctrl.pause(&t.owner);
    t.ctrl.set_whitelist_enabled(&true);
    assert!(t.ctrl.whitelist_enabled());
}

// =========================================================================
// Event emission — events fire through the live wiring
// =========================================================================

#[test]
fn whitelist_events_emit_on_controller() {
    let t = TestEnv::new();
    let admin = add_gov_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    // Third topic is the address — use the single-prefix helper to count by
    // the verb topic alone.
    let added_count = count_events_with_single_prefix(
        &t.env,
        &t.ctrl_addr,
        Symbol::new(&t.env, "buyer_whitelisted"),
    );
    assert_eq!(added_count, 1);

    t.ctrl.remove_whitelisted_buyer(&admin, &traveler);
    let removed_count =
        count_events_with_single_prefix(&t.env, &t.ctrl_addr, Symbol::new(&t.env, "buyer_removed"));
    assert_eq!(removed_count, 1);

    t.ctrl.set_whitelist_enabled(&true);
    let toggled_count = count_events_with_single_prefix(
        &t.env,
        &t.ctrl_addr,
        Symbol::new(&t.env, "whitelist_toggled"),
    );
    assert_eq!(toggled_count, 1);
}
