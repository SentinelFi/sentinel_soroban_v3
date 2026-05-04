// Group 3 — Underwriter withdrawal lifecycle + recover_uncollected.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, token, Address};

// =========================================================================
// Standard underwriter exit
// =========================================================================

#[test]
fn deposit_then_immediate_redeem_within_free_capital() {
    let t = TestEnv::new();
    // The default underwriter already deposited 1000 USDC during setup.
    // Pre-purchase, all capital is free.
    assert_eq!(t.vault.get_free_capital(), DEPOSIT_AMOUNT);

    let shares = t.vault.balance(&t.underwriter);
    assert!(shares > 0);

    // Redeem half — succeeds because no capital is locked.
    let half = shares / 2;
    let assets = t.vault.redeem(
        &half,
        &t.underwriter,
        &t.underwriter,
        &t.underwriter,
    );
    assert!(assets > 0);
}

#[test]
#[should_panic(expected = "exceeds free capital")]
fn redeem_blocked_when_capital_locked() {
    let t = TestEnv::new();
    // Lock all capital by buying many policies until free is below the
    // redemption.
    for _ in 0..20 {
        let buyer = Address::generate(&t.env);
        t.buy_flight(
            &buyer,
            &symbol_short!("AA100"),
            FLIGHT_DATE + 1,
        );
    }
    // 20 buys × 50 USDC payoff = 1000 USDC locked. Free is now 0.
    let shares = t.vault.balance(&t.underwriter);
    t.vault
        .redeem(&shares, &t.underwriter, &t.underwriter, &t.underwriter);
}

#[test]
fn request_withdrawal_processed_after_settle() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    let shares = t.vault.balance(&t.underwriter);
    let half = shares / 2;
    t.vault.request_withdrawal(&t.underwriter, &half);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    t.oracle_on_time();
    t.classify_and_settle();

    // Queue processed; ClaimableBalance credited.
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
    assert!(t.vault.get_claimable_balance(&t.underwriter) > 0);
}

#[test]
fn collect_after_credit() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    let shares = t.vault.balance(&t.underwriter);
    let half = shares / 2;
    t.vault.request_withdrawal(&t.underwriter, &half);
    t.oracle_on_time();
    t.classify_and_settle();

    let claimable = t.vault.get_claimable_balance(&t.underwriter);
    assert!(claimable > 0);

    let usdc_before = t.usdc.balance(&t.underwriter);
    t.vault.collect(&t.underwriter);
    assert_eq!(t.usdc.balance(&t.underwriter), usdc_before + claimable);
    assert_eq!(t.vault.get_claimable_balance(&t.underwriter), 0);
}

#[test]
fn cancel_withdrawal_returns_shares() {
    let t = TestEnv::new();
    let shares = t.vault.balance(&t.underwriter);

    t.vault.request_withdrawal(&t.underwriter, &shares);
    assert_eq!(t.vault.balance(&t.underwriter), 0); // shares escrowed

    t.vault.cancel_withdrawal(&t.underwriter, &0u32);
    assert_eq!(t.vault.balance(&t.underwriter), shares);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
}

// =========================================================================
// recover_uncollected — both modes + auth
// =========================================================================

#[test]
fn recover_uncollected_recredit_path() {
    let t = TestEnv::new();
    let user = Address::generate(&t.env);

    // No prior credit.
    assert_eq!(t.vault.get_claimable_balance(&user), 0);

    t.vault.recover_uncollected(
        &user,
        &500_0000000,
        &risk_vault::RecoveryMode::Recredit,
    );
    assert_eq!(t.vault.get_claimable_balance(&user), 500_0000000);

    // User can collect.
    let usdc_admin = token::StellarAssetClient::new(&t.env, &t.usdc_addr);
    // Vault needs USDC liquidity for collect; mint it.
    usdc_admin.mint(&t.vault_addr, &500_0000000);
    t.vault.collect(&user);
    assert_eq!(t.usdc.balance(&user), 500_0000000);
}

#[test]
fn recover_uncollected_transfer_path() {
    let t = TestEnv::new();
    let user = Address::generate(&t.env);

    // Seed vault with USDC for the transfer.
    let usdc_admin = token::StellarAssetClient::new(&t.env, &t.usdc_addr);
    usdc_admin.mint(&t.vault_addr, &200_0000000);

    t.vault.recover_uncollected(
        &user,
        &50_0000000,
        &risk_vault::RecoveryMode::Transfer,
    );
    // Direct transfer; no claimable balance.
    assert_eq!(t.vault.get_claimable_balance(&user), 0);
    assert_eq!(t.usdc.balance(&user), 50_0000000);
}

#[test]
#[should_panic]
fn recover_uncollected_unauthorized_panics() {
    use soroban_sdk::Env;
    let env = Env::default();
    // No mock_all_auths — owner check fails.
    let owner = Address::generate(&env);
    let usdc_admin_addr = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr);
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    let stranger = Address::generate(&env);
    vault.recover_uncollected(
        &stranger,
        &100_0000000,
        &risk_vault::RecoveryMode::Recredit,
    );
}
