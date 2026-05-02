use super::setup::*;
use soroban_sdk::testutils::{Address as _, Ledger};

#[test]
fn test_1a_on_time_lifecycle() {
    let t = TestEnv::new();
    let t1 = soroban_sdk::Address::generate(&t.env);
    let t2 = soroban_sdk::Address::generate(&t.env);

    t.buy(&t1);
    t.buy(&t2);
    t.oracle_on_time();
    t.classify_and_settle();

    // Vault received premiums back, locked = 0
    assert_eq!(t.vault.get_locked_capital(), 0);

    // Premium income recorded: TMA increased by premiums
    let tma = t.vault.get_total_managed_assets();
    assert_eq!(tma, DEPOSIT_AMOUNT + PREMIUM * 2); // original deposit + premiums

    // No active pools
    assert_eq!(t.ctrl.get_active_pools().len(), 0);

    // Stats
    let (sold, collected, distributed) = t.ctrl.get_stats();
    assert_eq!(sold, 2);
    assert_eq!(collected, PREMIUM * 2);
    assert_eq!(distributed, 0); // on-time = no payout
}

#[test]
fn test_1b_delayed_lifecycle() {
    let t = TestEnv::new();
    let t1 = soroban_sdk::Address::generate(&t.env);
    let t2 = soroban_sdk::Address::generate(&t.env);

    t.buy(&t1);
    t.buy(&t2);

    let pool_addr = t.pool_addr();

    t.oracle_delayed();
    t.classify_and_settle();

    // Pool holds payoff * 2 for travelers
    assert_eq!(t.usdc.balance(&pool_addr), PAYOFF * 2);

    // Both claim
    let pool = t.pool_client(&pool_addr);
    pool.claim(&t1);
    pool.claim(&t2);

    assert_eq!(t.usdc.balance(&t1), PAYOFF);
    assert_eq!(t.usdc.balance(&t2), PAYOFF);
    assert_eq!(t.usdc.balance(&pool_addr), 0);

    // Vault locked = 0
    assert_eq!(t.vault.get_locked_capital(), 0);
}

#[test]
fn test_1c_cancelled_lifecycle() {
    let t = TestEnv::new();
    let traveler = soroban_sdk::Address::generate(&t.env);

    t.buy(&traveler);
    let pool_addr = t.pool_addr();

    t.oracle_cancelled();
    t.classify_and_settle();

    let pool = t.pool_client(&pool_addr);
    pool.claim(&traveler);

    assert_eq!(t.usdc.balance(&traveler), PAYOFF);
    assert_eq!(t.vault.get_locked_capital(), 0);
}

#[test]
fn test_1d_partial_claim_and_sweep() {
    let t = TestEnv::new();
    let t1 = soroban_sdk::Address::generate(&t.env);
    let t2 = soroban_sdk::Address::generate(&t.env);
    let sweeper = soroban_sdk::Address::generate(&t.env);

    t.buy(&t1);
    t.buy(&t2);
    let pool_addr = t.pool_addr();

    t.oracle_delayed();
    t.classify_and_settle();

    // Only t1 claims
    let pool = t.pool_client(&pool_addr);
    pool.claim(&t1);
    assert_eq!(t.usdc.balance(&t1), PAYOFF);
    assert_eq!(t.usdc.balance(&pool_addr), PAYOFF); // t2's unclaimed

    // Advance past claim expiry
    let claim_expiry = pool.get_claim_expiry();
    t.env.ledger().with_mut(|l| l.timestamp = claim_expiry + 1);

    // Sweep
    pool.sweep_expired(&sweeper);

    assert_eq!(t.usdc.balance(&pool_addr), 0);
    assert_eq!(t.usdc.balance(&t.recovery_addr), PAYOFF);
}
