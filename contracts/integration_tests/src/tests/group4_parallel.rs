use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _};

#[test]
fn test_4a_two_flights_same_batch() {
    let t = TestEnv::new();

    // Whitelist second route
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    let t1 = soroban_sdk::Address::generate(&t.env);
    let t2 = soroban_sdk::Address::generate(&t.env);

    // Buy on two different flights
    t.buy(&t1); // AA100
    t.buy_flight(&t2, &symbol_short!("UA200"), FLIGHT_DATE + 100);

    assert_eq!(t.ctrl.get_active_pools().len(), 2);

    // AA100: on-time
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

    // UA200: delayed
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("UA200"),
        &(FLIGHT_DATE + 100),
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("UA200"),
        &(FLIGHT_DATE + 100),
        &ACTUAL_DELAYED,
    );

    // Single classify + settle batch
    t.classify_and_settle();

    // Both settled
    assert_eq!(t.ctrl.get_active_pools().len(), 0);

    // Stats: 2 sold, only UA200 had payout
    let (sold, _, distributed) = t.ctrl.get_stats();
    assert_eq!(sold, 2);
    assert_eq!(distributed, PAYOFF); // Only UA200
}

#[test]
fn test_4b_staggered_flights() {
    let t = TestEnv::new();

    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("DL300"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    let t1 = soroban_sdk::Address::generate(&t.env);
    let t2 = soroban_sdk::Address::generate(&t.env);
    let t3 = soroban_sdk::Address::generate(&t.env);

    t.buy(&t1); // AA100
    t.buy_flight(&t2, &symbol_short!("UA200"), FLIGHT_DATE + 100);
    t.buy_flight(&t3, &symbol_short!("DL300"), FLIGHT_DATE + 200);

    assert_eq!(t.ctrl.get_active_pools().len(), 3);

    // Only AA100 has oracle data (landed on time)
    t.oracle_on_time();

    // Classify + settle: only AA100 should settle
    t.classify_and_settle();

    // AA100 settled, UA200 + DL300 still active
    assert_eq!(t.ctrl.get_active_pools().len(), 2);

    // Buy more on UA200 (still active)
    let t4 = soroban_sdk::Address::generate(&t.env);
    t.buy_flight(&t4, &symbol_short!("UA200"), FLIGHT_DATE + 100);

    // UA200 now has 2 buyers
    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 4);
}

#[test]
fn test_4c_same_flight_five_travelers() {
    let t = TestEnv::new();

    let travelers: soroban_sdk::Vec<soroban_sdk::Address> = {
        let mut v = soroban_sdk::Vec::new(&t.env);
        for _ in 0..5u32 {
            v.push_back(soroban_sdk::Address::generate(&t.env));
        }
        v
    };

    for i in 0..travelers.len() {
        let tr = travelers.get(i).unwrap();
        t.buy(&tr);
    }

    let pool_addr = t.pool_addr();
    assert_eq!(t.usdc.balance(&pool_addr), PREMIUM * 5);

    t.oracle_delayed();
    t.classify_and_settle();

    // Pool holds payoff * 5
    assert_eq!(t.usdc.balance(&pool_addr), PAYOFF * 5);

    // All 5 claim
    let pool = t.pool_client(&pool_addr);
    for i in 0..travelers.len() {
        let tr = travelers.get(i).unwrap();
        pool.claim(&tr);
        assert_eq!(t.usdc.balance(&tr), PAYOFF);
    }

    // Pool balance = 0
    assert_eq!(t.usdc.balance(&pool_addr), 0);
}
