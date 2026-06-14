use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

#[test]
fn version_initialized_to_one() {
    let (_env, client, ..) = setup();
    assert_eq!(client.version(), 1);
}

fn setup() -> (Env, MockUSDCClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let contract_id = env.register(MockUSDC, (&admin,));
    let client = MockUSDCClient::new(&env, &contract_id);

    (env, client, admin, user)
}

#[test]
fn test_initialize() {
    let (_env, client, _admin, _user) = setup();

    assert_eq!(client.name(), String::from_str(&_env, "Mock USDC"));
    assert_eq!(client.symbol(), String::from_str(&_env, "USDC"));
    assert_eq!(client.decimals(), 7);
}

#[test]
fn test_mint() {
    let (_env, client, _admin, user) = setup();

    client.mint(&user, &1_000_0000000);

    assert_eq!(client.balance(&user), 1_000_0000000);
    assert_eq!(client.total_supply(), 1_000_0000000);
}

#[test]
fn test_transfer() {
    let (_env, client, _admin, user) = setup();
    let recipient = Address::generate(&_env);

    client.mint(&user, &1_000_0000000);
    client.transfer(&user, &recipient, &400_0000000);

    assert_eq!(client.balance(&user), 600_0000000);
    assert_eq!(client.balance(&recipient), 400_0000000);
}

#[test]
fn test_approve_and_transfer_from() {
    let (_env, client, _admin, user) = setup();
    let spender = Address::generate(&_env);
    let recipient = Address::generate(&_env);

    client.mint(&user, &1_000_0000000);
    client.approve(&user, &spender, &500_0000000, &1000);

    assert_eq!(client.allowance(&user, &spender), 500_0000000);

    client.transfer_from(&spender, &user, &recipient, &200_0000000);

    assert_eq!(client.balance(&user), 800_0000000);
    assert_eq!(client.balance(&recipient), 200_0000000);
    assert_eq!(client.allowance(&user, &spender), 300_0000000);
}

#[test]
fn test_burn() {
    let (_env, client, _admin, user) = setup();

    client.mint(&user, &1_000_0000000);
    client.burn(&user, &300_0000000);

    assert_eq!(client.balance(&user), 700_0000000);
    assert_eq!(client.total_supply(), 700_0000000);
}

#[test]
fn test_permissionless_mint() {
    let env = Env::default();
    // No mock_all_auths — mint is permissionless
    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let contract_id = env.register(MockUSDC, (&admin,));
    let client = MockUSDCClient::new(&env, &contract_id);

    // Anyone can mint to any address
    client.mint(&user, &1_000_0000000);
    assert_eq!(client.balance(&user), 1_000_0000000);
}
