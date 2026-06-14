// Group 6 — Auth panics across the contract surface.
//
// These confirm that the right address is required for each restricted
// function. We use the integration-test fixture so the controller's
// downstream auth (vault/oracle/pool require_controller) is wired
// realistically, then attempt the call from a non-authorized address.

use super::setup::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

// =========================================================================
// Keeper-gated controller functions
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #304)")]
fn non_keeper_classify_panics() {
    let t = TestEnv::new();
    let stranger = Address::generate(&t.env);
    t.ctrl.classify_flights(&stranger);
}

#[test]
#[should_panic(expected = "Error(Contract, #304)")]
fn non_keeper_execute_panics() {
    let t = TestEnv::new();
    let stranger = Address::generate(&t.env);
    t.ctrl.execute_settlements(&stranger);
}

// =========================================================================
// Oracle-gated functions
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #604)")]
fn non_oracle_set_estimated_panics() {
    let t = TestEnv::new();
    // Flight must be registered first so the call path reaches require_oracle.
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);

    let stranger = Address::generate(&t.env);
    t.oracle.set_estimated_arrival(
        &stranger,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #604)")]
fn non_oracle_set_landed_panics() {
    let t = TestEnv::new();
    let traveler = Address::generate(&t.env);
    t.buy(&traveler);
    // Need the flight in Active state for set_landed to reach require_oracle.
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );

    let stranger = Address::generate(&t.env);
    t.oracle.set_landed(
        &stranger,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &ACTUAL_ON_TIME,
    );
}

// =========================================================================
// Owner-gated functions
// =========================================================================

#[test]
#[should_panic]
fn non_owner_set_keeper_panics() {
    // Fresh env without mock_all_auths so #[only_owner] guard fails.
    let env = Env::default();
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let usdc_admin_addr = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr);

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &Address::generate(&env)),
    );
    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &usdc_id.address(), &vault_addr),
    );
    let ctrl_addr = env.register(
        controller::Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &usdc_id.address(),
            &Address::generate(&env),
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = controller::ControllerClient::new(&env, &ctrl_addr);

    ctrl.set_keeper(&stranger);
}

#[test]
#[should_panic]
fn non_owner_recover_uncollected_panics() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let usdc_admin_addr = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr);
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    let stranger = Address::generate(&env);
    vault.recover_uncollected(&stranger, &100_0000000, &risk_vault::RecoveryMode::Recredit);
}

#[test]
#[should_panic]
fn non_owner_set_defaults_panics() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

    gov.set_defaults(&100_0000000, &1000_0000000, &4u32);
}

// =========================================================================
// Controller-gated downstream functions
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #401)")]
fn non_controller_register_flight_on_pool_panics() {
    let t = TestEnv::new();
    let stranger = Address::generate(&t.env);
    t.pool.register_flight(
        &stranger,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &PREMIUM,
        &PAYOFF,
        &DELAY_HOURS,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #702)")]
fn non_controller_increase_locked_on_vault_panics() {
    let t = TestEnv::new();
    let stranger = Address::generate(&t.env);
    t.vault.increase_locked(&stranger, &PAYOFF);
}

// =========================================================================
// One-time set_controller writes
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #402)")]
fn pool_set_controller_one_time_write_panics_on_second_call() {
    let t = TestEnv::new();
    let new_ctrl = Address::generate(&t.env);
    t.pool.set_controller(&new_ctrl);
}

#[test]
#[should_panic(expected = "Error(Contract, #601)")]
fn oracle_set_controller_one_time_write_panics_on_second_call() {
    let t = TestEnv::new();
    let new_ctrl = Address::generate(&t.env);
    t.oracle.set_controller(&new_ctrl);
}
