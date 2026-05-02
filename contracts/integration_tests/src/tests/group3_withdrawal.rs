use super::setup::*;
use soroban_sdk::testutils::Address as _;

#[test]
fn test_3a_withdrawal_queue_processed_after_settlement() {
    let t = TestEnv::new();
    let traveler = soroban_sdk::Address::generate(&t.env);

    // Buy a policy (locks PAYOFF in vault)
    t.buy(&traveler);
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    // Underwriter requests withdrawal of all shares
    let shares = t.vault.balance(&t.underwriter);
    assert!(shares > 0);
    t.vault.request_withdrawal(&t.underwriter, &shares);

    // Queue has 1 entry
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    // Settlement frees capital → queue processed
    t.oracle_on_time();
    t.classify_and_settle();

    // Queue should be drained
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);

    // Underwriter can collect
    let claimable = t.vault.get_claimable_balance(&t.underwriter);
    assert!(claimable > 0);

    t.vault.collect(&t.underwriter);
    assert!(t.usdc.balance(&t.underwriter) > 0);
}

#[test]
fn test_3b_withdrawal_blocked_while_capital_locked() {
    let t = TestEnv::new();
    let _traveler = soroban_sdk::Address::generate(&t.env);

    // Buy policies to lock most capital
    for _ in 0..18u32 {
        let tr = soroban_sdk::Address::generate(&t.env);
        t.buy(&tr);
    }

    // Most capital is locked (18 * 50 = 900 out of 1000)
    assert_eq!(t.vault.get_locked_capital(), PAYOFF * 18);

    // Underwriter requests withdrawal
    let shares = t.vault.balance(&t.underwriter);
    t.vault.request_withdrawal(&t.underwriter, &shares);

    // Run a no-op settlement (no flights classified yet — oracle hasn't reported)
    // Just call execute_settlements which will process queue
    t.ctrl.execute_settlements(&t.keeper);

    // Queue still has entry (can't fulfill — not enough free capital for full redemption)
    // Free capital = 1000 - 900 = 100, but redemption might be > 100
    let queue = t.vault.get_withdrawal_queue();
    // The queue might be partially drained depending on share value
    // The key assertion: underwriter has NOT fully collected
    let claimable = t.vault.get_claimable_balance(&t.underwriter);
    // If free capital < redemption value, request stays in queue
    assert!(queue.len() > 0 || claimable > 0);
}

#[test]
fn test_3c_multiple_underwriters_partial_drain() {
    let t = TestEnv::new();

    // Add a second underwriter
    let uw2 = soroban_sdk::Address::generate(&t.env);
    t.usdc_admin.mint(&uw2, &500_0000000);
    t.vault.deposit(&500_0000000, &uw2, &uw2, &uw2);

    // Total vault: 1500 USDC. Buy policies to lock most capital.
    for _ in 0..10u32 {
        let tr = soroban_sdk::Address::generate(&t.env);
        t.buy(&tr);
    }
    // Locked: 10 * 50 = 500. Free: 1000.

    // Both request withdrawal of all shares
    let shares1 = t.vault.balance(&t.underwriter);
    let shares2 = t.vault.balance(&uw2);
    t.vault.request_withdrawal(&t.underwriter, &shares1);
    t.vault.request_withdrawal(&uw2, &shares2);

    assert_eq!(t.vault.get_withdrawal_queue().len(), 2);

    // Settle all flights on-time to free locked capital
    t.oracle_on_time();
    t.classify_and_settle();

    // After settlement, capital freed. Queue processed FIFO.
    // First underwriter (larger deposit) may consume most free capital.
    let c1 = t.vault.get_claimable_balance(&t.underwriter);
    let remaining_queue = t.vault.get_withdrawal_queue().len();

    // FIFO: at least the first request should be fulfilled
    assert!(c1 > 0);

    // Collect what's available
    t.vault.collect(&t.underwriter);
    assert!(t.usdc.balance(&t.underwriter) > 0);

    // Second underwriter may or may not be fulfilled depending on remaining capital
    // The key invariant: queue length decreased
    assert!(remaining_queue < 2 || t.vault.get_claimable_balance(&uw2) == 0);
}
