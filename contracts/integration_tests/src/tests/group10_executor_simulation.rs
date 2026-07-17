// Group 10 — Executor cron-tick orchestration.
//
// These tests simulate the centralized cron executor's behaviour against the
// real contracts, in pure Rust, with no network or TypeScript layer. The TS
// executor at `executor/centralized_cron/` is a thin RPC shim over the same
// contract entry points; the contract semantics under cron-style activation
// are what these tests pin down.
//
// What's distinctive vs other groups:
//   - Mixed multi-flight portfolio in one orchestration cycle.
//   - Explicit 5-cron tick sequence (Fetcher → Classifier → Settler →
//     QueueMaintainer → TTL/Prune) over multiple simulated ticks.
//   - Settler MUST NOT drain the underwriter queue;
//     QueueMaintainer is the sole drainer.
//   - The fetcher's contract-side effect (set_estimated_arrival / set_landed /
//     set_cancelled) is replayed deterministically since the AeroAPI fetch
//     itself is off-chain. The Layer-2 mock-api test at
//     `executor/mock-api/test.sh` covers the AeroAPI parsing path separately.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Symbol};

const SECONDS_PER_DAY: u64 = 86_400;

// Three additional flight idents alongside the default AA100 fixture.
fn flight_delayed() -> Symbol {
    symbol_short!("UAL456")
}
fn flight_cancelled() -> Symbol {
    symbol_short!("DL789")
}
fn flight_pending() -> Symbol {
    symbol_short!("SW333")
}

fn whitelist_extra_routes(t: &TestEnv) {
    // The default fixture only whitelists AA100/JFK→LAX. Add the rest so
    // we can simulate a realistic multi-flight portfolio.
    for (id, origin, dest) in [
        (flight_delayed(), symbol_short!("ORD"), symbol_short!("SFO")),
        (
            flight_cancelled(),
            symbol_short!("ATL"),
            symbol_short!("BOS"),
        ),
        (flight_pending(), symbol_short!("DEN"), symbol_short!("LAS")),
    ] {
        t.gov.whitelist_route(
            &t.owner,
            &id,
            &origin,
            &dest,
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        );
    }
}

fn buy_on(t: &TestEnv, traveler: &Address, flight_id: &Symbol, origin: Symbol, dest: Symbol) {
    t.open_sale(flight_id, FLIGHT_DATE);
    t.asset_admin.mint(traveler, &PREMIUM);
    t.ctrl
        .buy_insurance(traveler, flight_id, &origin, &dest, &FLIGHT_DATE);
}

// =========================================================================
// Tick #1 — Fetcher push (NotInitiated → Active / Landed / Cancelled)
// =========================================================================

#[test]
fn fetcher_tick_simulates_oracle_pushes_for_mixed_portfolio() {
    let t = TestEnv::new();
    whitelist_extra_routes(&t);

    // Three travelers buy three flights with different fates.
    let on_time_buyer = Address::generate(&t.env);
    let delayed_buyer = Address::generate(&t.env);
    let cancelled_buyer = Address::generate(&t.env);

    t.buy(&on_time_buyer); // AA100 → on-time path
    buy_on(
        &t,
        &delayed_buyer,
        &flight_delayed(),
        symbol_short!("ORD"),
        symbol_short!("SFO"),
    );
    buy_on(
        &t,
        &cancelled_buyer,
        &flight_cancelled(),
        symbol_short!("ATL"),
        symbol_short!("BOS"),
    );

    // Simulate the fetcher tick: oracle pushes estimated_arrival, then
    // either set_landed or set_cancelled depending on the AeroAPI outcome.
    // The simulation mirrors the on-chain effect the fetcher would produce.
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

    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &flight_delayed(),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &flight_delayed(),
        &FLIGHT_DATE,
        &ACTUAL_DELAYED,
    );

    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &flight_cancelled(),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle
        .set_cancelled(&t.oracle_account, &flight_cancelled(), &FLIGHT_DATE);

    // After fetcher tick: all three flights have data in the expected status.
    assert_eq!(
        t.oracle
            .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Landed
    );
    assert_eq!(
        t.oracle
            .get_flight_data(&flight_delayed(), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Landed
    );
    assert_eq!(
        t.oracle
            .get_flight_data(&flight_cancelled(), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Cancelled
    );
}

// =========================================================================
// Tick #2 — Classifier tick (Landed/Cancelled → ToBeSettled*)
// =========================================================================

#[test]
fn classifier_tick_advances_all_landed_or_cancelled_flights() {
    let t = TestEnv::new();
    whitelist_extra_routes(&t);

    let a = Address::generate(&t.env);
    let b = Address::generate(&t.env);
    let c = Address::generate(&t.env);
    t.buy(&a);
    buy_on(
        &t,
        &b,
        &flight_delayed(),
        symbol_short!("ORD"),
        symbol_short!("SFO"),
    );
    buy_on(
        &t,
        &c,
        &flight_cancelled(),
        symbol_short!("ATL"),
        symbol_short!("BOS"),
    );

    // Fetcher tick simulation.
    t.oracle_on_time(); // AA100
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &flight_delayed(),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &flight_delayed(),
        &FLIGHT_DATE,
        &ACTUAL_DELAYED,
    );
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &flight_cancelled(),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle
        .set_cancelled(&t.oracle_account, &flight_cancelled(), &FLIGHT_DATE);

    // Classifier tick — single call advances all three flights.
    t.ctrl.classify_flights(&t.keeper);

    assert_eq!(
        t.oracle
            .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::ToBeSettledOnTime
    );
    assert_eq!(
        t.oracle
            .get_flight_data(&flight_delayed(), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::ToBeSettledDelayed
    );
    assert_eq!(
        t.oracle
            .get_flight_data(&flight_cancelled(), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::ToBeSettledCancelled
    );
}

// =========================================================================
// Settler tick — moves money; does NOT drain the queue
// =========================================================================

#[test]
fn settler_tick_does_not_drain_withdrawal_queue() {
    // Pin down: execute_settlements must not touch the
    // underwriter queue. Only run_queue_maintenance (Cron #3b) does.
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    // Underwriter requests a withdrawal — should sit in the queue while
    // settlement processes.
    let shares = t.vault.balance(&t.underwriter) / 2;
    t.vault.request_withdrawal(&t.underwriter, &shares);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    t.oracle_on_time();
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    // Settler advanced flight to Settled but left the queue alone.
    assert_eq!(
        t.oracle
            .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Settled
    );
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);
    assert_eq!(t.vault.get_claimable_balance(&t.underwriter), 0);
}

#[test]
fn queue_maintainer_tick_drains_after_settler_freed_capital() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    let shares = t.vault.balance(&t.underwriter) / 2;
    t.vault.request_withdrawal(&t.underwriter, &shares);

    t.oracle_on_time();
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);
    // Queue still pending here — Cron #3b takes over.
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    t.ctrl.run_queue_maintenance(&t.keeper);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
    assert!(t.vault.get_claimable_balance(&t.underwriter) > 0);
}

// =========================================================================
// Multi-tick — pending flight becomes ready next tick
// =========================================================================

#[test]
fn pending_flight_carries_across_ticks() {
    // Flight is bought but the fetcher's first tick can't get data yet
    // (en_route — no actual_in). Classifier still emits ttl_miss because
    // status is NotInitiated. Next tick the fetcher pushes data and the
    // classifier+settler can clear the flight.
    let t = TestEnv::new();
    whitelist_extra_routes(&t);

    let pending_buyer = Address::generate(&t.env);
    buy_on(
        &t,
        &pending_buyer,
        &flight_pending(),
        symbol_short!("DEN"),
        symbol_short!("LAS"),
    );

    // Tick 1 — fetcher gets no AeroAPI data. Nothing pushed. Classifier
    // sees NotInitiated for an active-listed flight → emits ttl_miss.
    t.ctrl.classify_flights(&t.keeper);
    let ttl_miss_count =
        count_events_with_single_prefix(&t.env, &t.ctrl_addr, symbol_short!("ttl_miss"));
    assert!(ttl_miss_count >= 1, "expected ttl_miss for pending flight");

    // Tick 2 — fetcher now gets data. Push it and run the cycle to completion.
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &flight_pending(),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &flight_pending(),
        &FLIGHT_DATE,
        &ACTUAL_ON_TIME,
    );
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    assert_eq!(
        t.oracle
            .get_flight_data(&flight_pending(), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Settled
    );
}

// =========================================================================
// TTL-extender daily tick — extend_ttl on all 5 + prune_settled
// =========================================================================

#[test]
fn ttl_extender_daily_tick_extends_all_contracts_and_prunes() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.classify_and_settle();

    // Daily tick (start of day): call extend_ttl on every contract. These
    // are no-auth safety nets — none of them should panic.
    t.ctrl.extend_ttl();
    t.gov.extend_ttl();
    t.vault.extend_ttl();
    t.oracle.extend_ttl();
    t.pool.extend_ttl();

    // After 30-day retention window, prune_settled evicts the settled flight.
    t.advance_time(30 * SECONDS_PER_DAY + 1);
    assert_eq!(t.oracle.get_active_flights().len(), 1);
    t.oracle.prune_settled();
    assert_eq!(t.oracle.get_active_flights().len(), 0);
}

// =========================================================================
// Full 5-cron orchestration over a mixed portfolio
// =========================================================================

#[test]
fn full_executor_cycle_settles_all_flights_in_one_pass() {
    let t = TestEnv::new();
    whitelist_extra_routes(&t);

    // Three travelers, three fates, all in flight at once.
    let on_time_buyer = Address::generate(&t.env);
    let delayed_buyer = Address::generate(&t.env);
    let cancelled_buyer = Address::generate(&t.env);
    t.buy(&on_time_buyer);
    buy_on(
        &t,
        &delayed_buyer,
        &flight_delayed(),
        symbol_short!("ORD"),
        symbol_short!("SFO"),
    );
    buy_on(
        &t,
        &cancelled_buyer,
        &flight_cancelled(),
        symbol_short!("ATL"),
        symbol_short!("BOS"),
    );

    // An underwriter has a pending withdrawal — exercises the queue path
    // in the same orchestration cycle.
    let shares = t.vault.balance(&t.underwriter) / 4;
    t.vault.request_withdrawal(&t.underwriter, &shares);

    // ── Cron #1 — Fetcher tick (oracle pushes for all three flights) ──
    t.oracle_on_time();
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &flight_delayed(),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &flight_delayed(),
        &FLIGHT_DATE,
        &ACTUAL_DELAYED,
    );
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &flight_cancelled(),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle
        .set_cancelled(&t.oracle_account, &flight_cancelled(), &FLIGHT_DATE);

    // ── Cron #2 — Classifier tick ──
    t.ctrl.classify_flights(&t.keeper);

    // ── Cron #3 — Settler tick ──
    t.ctrl.execute_settlements(&t.keeper);

    // ── Cron #3b — Queue maintainer tick (offset) ──
    t.ctrl.run_queue_maintenance(&t.keeper);

    // All three flights settled in oracle.
    for id in [symbol_short!("AA100"), flight_delayed(), flight_cancelled()] {
        assert_eq!(
            t.oracle.get_flight_data(&id, &FLIGHT_DATE).status,
            oracle_aggregator::FlightStatus::Settled,
            "flight {:?} should be Settled",
            id,
        );
    }

    // Money flowed correctly:
    // - On-time premium is now vault yield.
    // - Delayed + cancelled buyers can claim the full payoff from the pool.
    // - Underwriter queue drained.
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
    assert!(t.vault.get_claimable_balance(&t.underwriter) > 0);

    // Travelers claim payouts.
    t.pool
        .claim(&delayed_buyer, &flight_delayed(), &FLIGHT_DATE);
    t.pool
        .claim(&cancelled_buyer, &flight_cancelled(), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&delayed_buyer), PAYOFF);
    assert_eq!(t.asset.balance(&cancelled_buyer), PAYOFF);

    // On-time buyer never gets a payout — that's the protocol's revenue.
    assert_eq!(t.asset.balance(&on_time_buyer), 0);

    let (sold, collected, distributed) = t.ctrl.get_stats();
    assert_eq!(sold, 3);
    assert_eq!(collected, 3 * PREMIUM);
    assert_eq!(distributed, 2 * PAYOFF);

    // ── Cron #4 — TTL extender daily tick (no-op effect, just must not panic) ──
    t.ctrl.extend_ttl();
    t.gov.extend_ttl();
    t.vault.extend_ttl();
    t.oracle.extend_ttl();
    t.pool.extend_ttl();
    t.oracle.prune_settled(); // No-op pre-retention; still must not panic.
}
