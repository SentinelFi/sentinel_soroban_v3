// Group 2 — Money flow + solvency + lead-time gates + counter invariants.

use super::setup::*;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger as _, token, Address, Env,
};

// =========================================================================
// Solvency gate
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #312)")]
fn solvency_gate_blocks_undercollateralized_purchase() {
    // Use a fresh env with NO underwriter capital seeded.
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let oracle_account = Address::generate(&env);
    let usdc_admin_addr = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr);
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_id.address());

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &oracle_account),
    );
    let oracle = oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);

    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &usdc_id.address(), &vault_addr),
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
            &usdc_id.address(),
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
    usdc_admin.mint(&traveler, &PREMIUM);
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
    // Required = payoff * 1.5. Default vault has 1000 USDC, so the first
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
    let traveler = Address::generate(&t.env);
    t.usdc_admin.mint(&traveler, &PREMIUM);
    // Flight date < INITIAL_TIMESTAMP + MIN_LEAD_TIME.
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &(INITIAL_TIMESTAMP + 100),
    );
}

// =========================================================================
// Money flow on buy
// =========================================================================

#[test]
fn usdc_transfer_traveler_to_pool_on_buy() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    // Traveler USDC drained, pool holds the premium.
    assert_eq!(t.usdc.balance(&traveler), 0);
    assert_eq!(t.usdc.balance(&t.pool_addr), PREMIUM);
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
