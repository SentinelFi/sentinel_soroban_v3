// Group 2 — Money flow + solvency + lead-time gates + counter invariants.

use super::setup::*;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger as _, token, Address, Env,
};

// =========================================================================
// Solvency gate
// =========================================================================

#[test]
fn solvency_ratio_enforced_on_aggregate_liabilities() {
    // With a 200% solvency ratio and 1000 asset of capital, the vault may back
    // at most 500 asset of aggregate payoff exposure. Each buyer
    // locks PAYOFF (50); the 10th buy reaches 500 locked (required TMA =
    // 500 * 2 = 1000 == capital) and succeeds, the 11th would need 1100 and is
    // rejected — proving the ratio holds across the whole book, not just the
    // newest payoff.
    let t = TestEnv::new();
    t.ctrl.set_solvency_ratio(&200);

    // 10 distinct buyers on the same flight → 10 * PAYOFF = 500 locked.
    for _ in 0..10 {
        let buyer = Address::generate(&t.env);
        t.buy(&buyer);
    }
    assert_eq!(t.vault.get_locked_capital(), 10 * PAYOFF);

    // The 11th purchase must be rejected by the aggregate solvency check.
    let late = Address::generate(&t.env);
    t.asset_admin.mint(&late, &PREMIUM);
    let res = t.ctrl.try_buy_insurance(
        &late,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
    assert!(
        res.is_err(),
        "11th buy should breach the 200% aggregate ratio"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #312)")]
fn solvency_gate_blocks_undercollateralized_purchase() {
    // Use a fresh env with NO underwriter capital seeded.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let oracle_account = Address::generate(&env);
    let asset_admin_addr = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin_addr);
    let asset_admin = token::StellarAssetClient::new(&env, &asset_id.address());

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &asset_id.address()));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &oracle_account),
    );
    let oracle = oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);

    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &asset_id.address(), &vault_addr),
    );
    let pool = flight_pool_manager::FlightPoolManagerClient::new(&env, &pool_addr);

    let ctrl_addr = env.register(
        controller::Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &asset_id.address(),
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = controller::ControllerClient::new(&env, &ctrl_addr);

    vault.set_controller(&ctrl_addr);
    oracle.set_controller(&ctrl_addr);
    pool.set_controller(&ctrl_addr);

    gov.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Vault has 0 free capital — purchase must panic.
    let traveler = Address::generate(&env);
    asset_admin.mint(&traveler, &PREMIUM);
    ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

#[test]
fn solvency_gate_with_ratio_150() {
    // Required = payoff * 1.5. Default vault has 1000 asset, so the first
    // buy locks 50 * 1.5 = 75 required → fits. We'll buy enough to push
    // free below the next required.
    let t = TestEnv::new();
    t.ctrl.set_solvency_ratio(&150u32);
    assert_eq!(t.ctrl.get_solvency_ratio(), 150);

    // First buy: passes (free = 1000, required = 75).
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
}

#[test]
#[should_panic(expected = "Error(Contract, #309)")]
fn lead_time_gate_blocks_short_notice() {
    let t = TestEnv::new();
    // Raise the lead requirement above the ~0.7-day gap to FLIGHT_DATE so a
    // day-aligned date (required by the alignment check, which runs first) still
    // lands inside the "too soon" window and trips the lead-time gate (#309).
    t.ctrl.set_min_lead_time(&(2 * SECONDS_PER_DAY));
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    // FLIGHT_DATE is ~0.7 days out, under the 2-day lead requirement.
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

// =========================================================================
// Settlement barrier — no LP entry/exit while an outcome is unsettled
// =========================================================================

#[test]
fn lp_cannot_transact_at_stale_price_during_pending_outcome() {
    // After an outcome is public (oracle Cancelled) but before the keeper
    // settles, the vault's share price still reflects the pre-loss state. An LP
    // must not be able to exit at that stale price (dumping the loss on passive
    // LPs), nor deposit to capture not-yet-booked income. Both are blocked until
    // settlement recognizes the PnL.
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler); // locks collateral against the underwriter capital

    // Outcome is public but not yet classified/settled.
    t.oracle_cancelled();

    // Exit at the stale (pre-loss) price is rejected.
    let shares = t.vault.balance(&t.underwriter);
    let redeem = t
        .vault
        .try_redeem(&shares, &t.underwriter, &t.underwriter, &t.underwriter);
    assert!(
        redeem.is_err(),
        "redeem must be blocked while an outcome is unsettled"
    );

    // Entry at the stale (pre-income) price is likewise rejected.
    let newcomer = Address::generate(&t.env);
    t.asset_admin.mint(&newcomer, &DEPOSIT_AMOUNT);
    let deposit = t
        .vault
        .try_deposit(&DEPOSIT_AMOUNT, &newcomer, &newcomer, &newcomer);
    assert!(
        deposit.is_err(),
        "deposit must be blocked while an outcome is unsettled"
    );

    // Once the keeper settles, the PnL is recognized and the barrier lifts.
    t.classify_and_settle();
    let out = t
        .vault
        .redeem(&shares, &t.underwriter, &t.underwriter, &t.underwriter);
    assert!(
        out > 0,
        "redeem should succeed at the post-settlement price"
    );
}

#[test]
fn withdrawal_queue_stays_open_during_pending_outcome() {
    // The barrier blocks direct exits during a pending outcome but must NOT
    // freeze exits entirely: the queued path stays open, and it is priced only
    // after settlement (never at the stale pre-loss rate).
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_cancelled(); // outcome public, not yet settled

    let shares = t.vault.balance(&t.underwriter);
    // Direct exit blocked, but request_withdrawal is allowed (no price locked).
    assert!(t
        .vault
        .try_redeem(&shares, &t.underwriter, &t.underwriter, &t.underwriter)
        .is_err());
    t.vault.request_withdrawal(&t.underwriter, &shares);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    // Draining is a no-op while the outcome is unsettled (would price stale).
    t.ctrl.run_queue_maintenance(&t.keeper);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);
    assert_eq!(t.vault.get_claimable_balance(&t.underwriter), 0);

    // After settlement recognizes the loss, the queue drains at the correct rate.
    t.classify_and_settle();
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
    assert!(t.vault.get_claimable_balance(&t.underwriter) > 0);
}

// =========================================================================
// Money flow on buy
// =========================================================================

#[test]
fn asset_transfer_traveler_to_pool_on_buy() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    // Traveler asset drained, pool holds the premium.
    assert_eq!(t.asset.balance(&traveler), 0);
    assert_eq!(t.asset.balance(&t.pool_addr), PREMIUM);
}

#[test]
fn vault_locks_collateral_on_buy() {
    let t = TestEnv::new();
    assert_eq!(t.vault.get_locked_capital(), 0);

    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    // Second buy on the same flight — locked goes to 2x.
    let traveler2 = Address::generate(&t.env);
    t.buy(&traveler2);
    assert_eq!(t.vault.get_locked_capital(), 2 * PAYOFF);
}

#[test]
fn vault_unlocks_collateral_on_settle() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    t.oracle_on_time();
    t.classify_and_settle();
    assert_eq!(t.vault.get_locked_capital(), 0);
}

// =========================================================================
// Total managed assets invariant
// =========================================================================

#[test]
fn total_managed_assets_invariant_through_lifecycle() {
    let t = TestEnv::new();
    let initial_tma = t.vault.get_total_managed_assets();
    assert_eq!(initial_tma, DEPOSIT_AMOUNT);

    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    // TMA does NOT change on buy — premium stays in pool, not vault.
    assert_eq!(t.vault.get_total_managed_assets(), initial_tma);

    t.oracle_on_time();
    t.classify_and_settle();
    // On-time settlement records premium income.
    assert_eq!(t.vault.get_total_managed_assets(), initial_tma + PREMIUM);
}

#[test]
fn payouts_distributed_counter_tracks_payouts() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    let (_, _, distributed_before) = t.ctrl.get_stats();
    assert_eq!(distributed_before, 0);

    t.oracle_delayed();
    t.classify_and_settle();

    let (_, _, distributed_after) = t.ctrl.get_stats();
    assert_eq!(distributed_after, PAYOFF);
}
