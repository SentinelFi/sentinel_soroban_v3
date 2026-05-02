use super::setup::*;
use soroban_sdk::testutils::Address as _;

#[test]
#[should_panic(expected = "not authorized keeper")]
fn test_6a_non_keeper_classify() {
    let t = TestEnv::new();
    let stranger = soroban_sdk::Address::generate(&t.env);
    t.ctrl.classify_flights(&stranger);
}

#[test]
#[should_panic(expected = "not authorized keeper")]
fn test_6a_non_keeper_settle() {
    let t = TestEnv::new();
    let stranger = soroban_sdk::Address::generate(&t.env);
    t.ctrl.execute_settlements(&stranger);
}

#[test]
#[should_panic]
fn test_6b_non_owner_set_keeper() {
    let env = soroban_sdk::Env::default();
    // No mock_all_auths — auth will fail
    let owner = soroban_sdk::Address::generate(&env);
    let keeper = soroban_sdk::Address::generate(&env);
    let usdc_admin = soroban_sdk::Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let gov = soroban_sdk::Address::generate(&env);
    let vault = soroban_sdk::Address::generate(&env);
    let oracle = soroban_sdk::Address::generate(&env);
    let recovery = soroban_sdk::Address::generate(&env);
    let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);

    let ctrl_addr = env.register(
        controller::Controller,
        (
            &owner,
            &gov,
            &vault,
            &oracle,
            &recovery,
            &usdc_id.address(),
            &wasm_hash,
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = controller::ControllerClient::new(&env, &ctrl_addr);
    let new_keeper = soroban_sdk::Address::generate(&env);
    ctrl.set_keeper(&new_keeper); // should fail — no auth
}

#[test]
fn test_6c_keeper_migration() {
    let t = TestEnv::new();
    let new_keeper = soroban_sdk::Address::generate(&t.env);

    // Old keeper works
    let traveler = soroban_sdk::Address::generate(&t.env);
    t.buy(&traveler);
    t.oracle_on_time();
    t.ctrl.classify_flights(&t.keeper); // old keeper succeeds

    // Owner migrates keeper
    t.ctrl.set_keeper(&new_keeper);
    assert_eq!(t.ctrl.get_keeper(), new_keeper);

    // Old keeper fails
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.ctrl.execute_settlements(&t.keeper);
    }));
    assert!(result.is_err());

    // New keeper succeeds
    t.ctrl.execute_settlements(&new_keeper);

    // Settlement completed
    assert_eq!(t.ctrl.get_active_pools().len(), 0);
}
