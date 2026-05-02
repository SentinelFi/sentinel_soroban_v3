use super::setup::*;
use soroban_sdk::testutils::Address as _;

#[test]
fn test_2a_capital_accounting_on_time() {
    let t = TestEnv::new();
    let t1 = soroban_sdk::Address::generate(&t.env);

    // Track initial state: vault has DEPOSIT_AMOUNT of USDC
    let initial_vault_usdc = t.usdc.balance(&t.vault_addr);
    assert_eq!(initial_vault_usdc, DEPOSIT_AMOUNT);

    t.buy(&t1);
    let pool_addr = t.pool_addr();

    // After buy: vault has DEPOSIT_AMOUNT, pool has PREMIUM, traveler has 0
    assert_eq!(t.usdc.balance(&t.vault_addr), DEPOSIT_AMOUNT);
    assert_eq!(t.usdc.balance(&pool_addr), PREMIUM);
    assert_eq!(t.usdc.balance(&t1), 0);

    t.oracle_on_time();
    t.classify_and_settle();

    // After on-time settlement: pool sent premiums to vault
    assert_eq!(t.usdc.balance(&pool_addr), 0);
    assert_eq!(t.usdc.balance(&t.vault_addr), DEPOSIT_AMOUNT + PREMIUM);
    assert_eq!(t.usdc.balance(&t1), 0);

    // Total USDC = DEPOSIT_AMOUNT + PREMIUM (minted to traveler, now in vault)
    let total = t.usdc.balance(&t.vault_addr) + t.usdc.balance(&pool_addr) + t.usdc.balance(&t1);
    assert_eq!(total, DEPOSIT_AMOUNT + PREMIUM);
}

#[test]
fn test_2b_capital_accounting_delayed() {
    let t = TestEnv::new();
    let t1 = soroban_sdk::Address::generate(&t.env);

    t.buy(&t1);
    let pool_addr = t.pool_addr();

    t.oracle_delayed();
    t.classify_and_settle();

    // Vault sent (PAYOFF - PREMIUM) to pool, pool holds PAYOFF total
    assert_eq!(t.usdc.balance(&pool_addr), PAYOFF);

    // Vault TMA decreased by payout
    let vault_tma = t.vault.get_total_managed_assets();
    // TMA = DEPOSIT_AMOUNT - (PAYOFF - PREMIUM) = DEPOSIT_AMOUNT - 40
    assert_eq!(vault_tma, DEPOSIT_AMOUNT - (PAYOFF - PREMIUM));
    assert_eq!(t.vault.get_locked_capital(), 0);

    // Traveler claims
    let pool = t.pool_client(&pool_addr);
    pool.claim(&t1);

    // Accounting: vault_usdc + pool_usdc + traveler_usdc = DEPOSIT + PREMIUM (total minted)
    let total = t.usdc.balance(&t.vault_addr) + t.usdc.balance(&pool_addr) + t.usdc.balance(&t1);
    assert_eq!(total, DEPOSIT_AMOUNT + PREMIUM);
}

#[test]
#[should_panic(expected = "insufficient vault capital")]
fn test_2c_solvency_gate_blocks_purchase() {
    let t = TestEnv::new();

    // Vault has 1000 USDC, each policy locks 50 → max 20
    for _ in 0..20u32 {
        let traveler = soroban_sdk::Address::generate(&t.env);
        t.buy(&traveler);
    }

    // 21st fails
    let traveler = soroban_sdk::Address::generate(&t.env);
    t.buy(&traveler);
}

#[test]
fn test_2d_solvency_restored_after_settlement() {
    let t = TestEnv::new();

    // Fill vault to capacity (20 policies on same flight)
    for _ in 0..20u32 {
        let traveler = soroban_sdk::Address::generate(&t.env);
        t.buy(&traveler);
    }

    // Settle on-time → frees all locked capital
    t.oracle_on_time();
    t.classify_and_settle();

    assert_eq!(t.vault.get_locked_capital(), 0);

    // Whitelist a new route for a new flight
    t.gov.whitelist_route(
        &t.owner,
        &soroban_sdk::symbol_short!("BB200"),
        &soroban_sdk::symbol_short!("JFK"),
        &soroban_sdk::symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Now buying succeeds again
    let traveler = soroban_sdk::Address::generate(&t.env);
    t.buy_flight(&traveler, &soroban_sdk::symbol_short!("BB200"), FLIGHT_DATE + 100000);

    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 21);
}
