// Group 3 — Underwriter withdrawal lifecycle + recover_uncollected.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, token, Address};

// =========================================================================
// Standard underwriter exit
// =========================================================================

#[test]
fn queued_exit_drains_when_capital_free() {
    let t = TestEnv::new();
    // The default underwriter already entered 1000 asset during setup.
    // Pre-purchase, all capital is free.
    assert_eq!(t.vault.get_free_capital(), DEPOSIT_AMOUNT);

    let shares = t.vault.balance(&t.underwriter);
    assert!(shares > 0);

    // Exit half through the queue — prices as soon as the request matures,
    // because no capital is locked.
    let half = shares / 2;
    t.vault.request_withdrawal(&t.underwriter, &half);
    t.mature_requests();
    t.ctrl.run_queue_maintenance(&t.keeper);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
    assert!(t.vault.get_claimable_balance(&t.underwriter) > 0);
}

#[test]
fn queued_exit_starved_while_capital_locked() {
    let t = TestEnv::new();
    // Lock all capital by buying many policies.
    for _ in 0..20 {
        let buyer = Address::generate(&t.env);
        t.buy_flight(
            &buyer,
            &symbol_short!("AA100"),
            FLIGHT_DATE + SECONDS_PER_DAY,
        );
    }
    // 20 buys × 50 asset payoff = 1000 asset locked. Free is now 0: a
    // matured exit request stays queued with nothing credited.
    let shares = t.vault.balance(&t.underwriter);
    t.vault.request_withdrawal(&t.underwriter, &shares);
    t.mature_requests();
    t.ctrl.run_queue_maintenance(&t.keeper);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);
    assert_eq!(t.vault.get_claimable_balance(&t.underwriter), 0);
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
    t.mature_requests();

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
    t.mature_requests();
    t.oracle_on_time();
    t.classify_and_settle();

    let claimable = t.vault.get_claimable_balance(&t.underwriter);
    assert!(claimable > 0);

    let asset_before = t.asset.balance(&t.underwriter);
    t.vault.collect(&t.underwriter);
    assert_eq!(t.asset.balance(&t.underwriter), asset_before + claimable);
    assert_eq!(t.vault.get_claimable_balance(&t.underwriter), 0);
}

#[test]
fn cancel_withdrawal_returns_shares() {
    let t = TestEnv::new();
    let shares = t.vault.balance(&t.underwriter);

    let request_id = t.vault.request_withdrawal(&t.underwriter, &shares);
    assert_eq!(t.vault.balance(&t.underwriter), 0); // shares escrowed

    t.vault.cancel_withdrawal(&t.underwriter, &request_id);
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

    // The recredited amount must be covered by asset the vault holds beyond
    // TMA — model the archived credit's asset still sitting in the vault.
    let asset_admin = token::StellarAssetClient::new(&t.env, &t.asset_addr);
    asset_admin.mint(&t.vault_addr, &500_0000000);

    t.vault
        .recover_uncollected(&user, &500_0000000, &risk_vault::RecoveryMode::Recredit);
    assert_eq!(t.vault.get_claimable_balance(&user), 500_0000000);

    // User can collect.
    t.vault.collect(&user);
    assert_eq!(t.asset.balance(&user), 500_0000000);
}

#[test]
fn recover_uncollected_transfer_path() {
    let t = TestEnv::new();
    let user = Address::generate(&t.env);

    // Seed vault with asset for the transfer.
    let asset_admin = token::StellarAssetClient::new(&t.env, &t.asset_addr);
    asset_admin.mint(&t.vault_addr, &200_0000000);

    // Transfer is gated on a prior credit; seed via Recredit first.
    t.vault
        .recover_uncollected(&user, &50_0000000, &risk_vault::RecoveryMode::Recredit);
    t.vault
        .recover_uncollected(&user, &50_0000000, &risk_vault::RecoveryMode::Transfer);
    // Credit settled; balance cleared.
    assert_eq!(t.vault.get_claimable_balance(&user), 0);
    assert_eq!(t.asset.balance(&user), 50_0000000);
}

#[test]
#[should_panic]
fn recover_uncollected_unauthorized_panics() {
    use soroban_sdk::Env;
    let env = Env::default();
    // No mock_all_auths — owner check fails.
    let owner = Address::generate(&env);
    let asset_admin_addr = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin_addr);
    // Oracle never consulted on this path — any address satisfies the
    // constructor.
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &asset_id.address(), &Address::generate(&env)),
    );
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    let stranger = Address::generate(&env);
    vault.recover_uncollected(&stranger, &100_0000000, &risk_vault::RecoveryMode::Recredit);
}
