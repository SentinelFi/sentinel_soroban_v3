use super::*;
use soroban_sdk::{testutils::Address as _, Env};

fn setup() -> (Env, RecoveryPoolClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_client = token::StellarAssetClient::new(&env, &usdc_id.address());

    let contract_id = env.register(RecoveryPool, (&owner, &usdc_id.address()));
    let client = RecoveryPoolClient::new(&env, &contract_id);

    // Mint USDC to a source pool for testing
    let source_pool = Address::generate(&env);
    usdc_client.mint(&source_pool, &10_000_0000000);

    (env, client, owner, source_pool, usdc_id.address())
}

#[test]
fn test_constructor() {
    let (_env, client, owner, _source_pool, usdc_addr) = setup();

    assert_eq!(client.get_owner(), Some(owner));
    assert_eq!(client.get_usdc_token(), usdc_addr);
    assert_eq!(client.get_total_balance(), 0);
}

#[test]
fn test_receive() {
    let (env, client, _owner, source_pool, usdc_addr) = setup();
    let usdc = token::Client::new(&env, &usdc_addr);

    client.receive(&source_pool, &1_000_0000000);

    assert_eq!(client.get_balance(&source_pool), 1_000_0000000);
    assert_eq!(client.get_total_balance(), 1_000_0000000);
    assert_eq!(usdc.balance(&client.address), 1_000_0000000);
    assert_eq!(usdc.balance(&source_pool), 9_000_0000000);
}

#[test]
fn test_receive_multiple_from_same_source() {
    let (env, client, _owner, source_pool, usdc_addr) = setup();
    let usdc = token::Client::new(&env, &usdc_addr);

    client.receive(&source_pool, &500_0000000);
    client.receive(&source_pool, &300_0000000);

    assert_eq!(client.get_balance(&source_pool), 800_0000000);
    assert_eq!(client.get_total_balance(), 800_0000000);
    assert_eq!(usdc.balance(&client.address), 800_0000000);
}

#[test]
fn test_receive_multiple_sources() {
    let (env, client, _owner, source_pool, usdc_addr) = setup();
    let usdc_client = token::StellarAssetClient::new(&env, &usdc_addr);
    let usdc = token::Client::new(&env, &usdc_addr);

    let source_pool_2 = Address::generate(&env);
    usdc_client.mint(&source_pool_2, &5_000_0000000);

    client.receive(&source_pool, &1_000_0000000);
    client.receive(&source_pool_2, &2_000_0000000);

    assert_eq!(client.get_balance(&source_pool), 1_000_0000000);
    assert_eq!(client.get_balance(&source_pool_2), 2_000_0000000);
    assert_eq!(client.get_total_balance(), 3_000_0000000);
    assert_eq!(usdc.balance(&client.address), 3_000_0000000);
}

#[test]
fn test_withdraw() {
    let (env, client, _owner, source_pool, usdc_addr) = setup();
    let usdc = token::Client::new(&env, &usdc_addr);
    let destination = Address::generate(&env);

    client.receive(&source_pool, &1_000_0000000);
    client.withdraw(&destination, &400_0000000);

    assert_eq!(client.get_total_balance(), 600_0000000);
    assert_eq!(usdc.balance(&client.address), 600_0000000);
    assert_eq!(usdc.balance(&destination), 400_0000000);
}

#[test]
#[should_panic]
fn test_unauthorized_withdraw() {
    let env = Env::default();
    // Do NOT mock_all_auths — let auth fail
    let owner = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());

    let contract_id = env.register(RecoveryPool, (&owner, &usdc_id.address()));
    let client = RecoveryPoolClient::new(&env, &contract_id);

    let destination = Address::generate(&env);
    // No auth — should panic
    client.withdraw(&destination, &100_0000000);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn test_withdraw_exceeds_balance() {
    let (_env, client, _owner, source_pool, _usdc_addr) = setup();

    client.receive(&source_pool, &500_0000000);
    client.withdraw(&Address::generate(&_env), &600_0000000);
}

#[test]
fn test_get_balance_unknown_source() {
    let (env, client, _owner, _source_pool, _usdc_addr) = setup();
    let unknown = Address::generate(&env);

    assert_eq!(client.get_balance(&unknown), 0);
}
