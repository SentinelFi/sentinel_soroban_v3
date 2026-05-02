use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger, Env};

fn setup() -> (Env, RiskVaultClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_client = token::StellarAssetClient::new(&env, &usdc_id.address());

    let contract_id = env.register(RiskVault, (&owner, usdc_id.address()));
    let client = RiskVaultClient::new(&env, &contract_id);

    // Set up a controller
    let controller = Address::generate(&env);
    client.set_controller(&controller);

    // Mint USDC to a depositor
    let depositor = Address::generate(&env);
    usdc_client.mint(&depositor, &10_000_0000000);

    (env, client, owner, controller, depositor)
}

#[test]
fn test_constructor() {
    let (env, client, owner, _controller, _depositor) = setup();

    assert_eq!(client.get_owner(), Some(owner));
    assert_eq!(client.name(), String::from_str(&env, "RiskVault Share"));
    assert_eq!(client.symbol(), String::from_str(&env, "RVS"));
    assert_eq!(client.decimals(), 10);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(client.get_locked_capital(), 0);
    assert_eq!(client.get_free_capital(), 0);
    assert_eq!(client.total_assets(), 0);
}

#[test]
fn test_deposit_and_redeem() {
    let (env, client, _owner, _controller, depositor) = setup();
    let usdc = token::Client::new(&env, &client.asset());

    // Deposit 1000 USDC
    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert!(shares > 0);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);
    assert_eq!(client.total_assets(), 1_000_0000000);
    assert_eq!(usdc.balance(&client.address), 1_000_0000000);

    // Redeem all shares
    let assets = client.redeem(&shares, &depositor, &depositor, &depositor);
    assert_eq!(assets, 1_000_0000000);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(usdc.balance(&depositor), 10_000_0000000); // back to original
}

#[test]
fn test_locked_capital_gates_withdrawal() {
    let (_env, client, _owner, controller, depositor) = setup();

    // Deposit 1000 USDC
    let _shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // Lock 800 → free = 200
    client.increase_locked(&controller, &800_0000000);
    assert_eq!(client.get_locked_capital(), 800_0000000);
    assert_eq!(client.get_free_capital(), 200_0000000);

    // Can redeem up to 200 worth of shares
    let max_w = client.max_withdraw(&depositor);
    assert_eq!(max_w, 200_0000000);

    // Decrease locked by 300 → free = 500
    client.decrease_locked(&controller, &300_0000000);
    assert_eq!(client.get_free_capital(), 500_0000000);
}

#[test]
#[should_panic(expected = "exceeds free capital")]
fn test_redeem_exceeds_free_capital() {
    let (_env, client, _owner, controller, depositor) = setup();

    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // Lock all capital
    client.increase_locked(&controller, &1_000_0000000);

    // Try to redeem — should panic
    client.redeem(&shares, &depositor, &depositor, &depositor);
}

#[test]
fn test_record_premium_income() {
    let (_env, client, _owner, controller, depositor) = setup();

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // Record premium income — TMA increases but raw balance stays the same
    // (In real flow, FlightPool transfers USDC to vault first, then controller calls this)
    client.record_premium_income(&controller, &50_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_050_0000000);
}

#[test]
fn test_send_payout() {
    let (env, client, _owner, controller, depositor) = setup();
    let usdc = token::Client::new(&env, &client.asset());
    let recipient = Address::generate(&env);

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    client.send_payout(&controller, &recipient, &200_0000000);
    assert_eq!(client.get_total_managed_assets(), 800_0000000);
    assert_eq!(usdc.balance(&recipient), 200_0000000);
    assert_eq!(usdc.balance(&client.address), 800_0000000);
}

#[test]
#[should_panic(expected = "not controller")]
fn test_unauthorized_controller_function() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let stranger = Address::generate(&env);

    client.increase_locked(&stranger, &100_0000000);
}

#[test]
#[should_panic(expected = "controller already set")]
fn test_set_controller_twice() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let new_controller = Address::generate(&env);

    client.set_controller(&new_controller);
}

#[test]
fn test_withdrawal_queue_request_process_collect() {
    let (env, client, _owner, controller, depositor) = setup();
    let usdc = token::Client::new(&env, &client.asset());

    // Deposit 1000 USDC
    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // Lock all capital
    client.increase_locked(&controller, &1_000_0000000);

    // Request withdrawal (shares get escrowed)
    client.request_withdrawal(&depositor, &shares);
    assert_eq!(client.balance(&depositor), 0); // shares escrowed
    assert_eq!(client.get_withdrawal_queue().len(), 1);

    // Can't process yet — no free capital
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 1); // still in queue

    // Unlock capital (settlement happened)
    client.decrease_locked(&controller, &1_000_0000000);

    // Now process — should fulfill
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    assert!(client.get_claimable_balance(&depositor) > 0);

    // Collect USDC
    let claimable = client.get_claimable_balance(&depositor);
    client.collect(&depositor);
    assert_eq!(usdc.balance(&depositor), 9_000_0000000 + claimable);
    assert_eq!(client.get_claimable_balance(&depositor), 0);
}

#[test]
fn test_cancel_withdrawal() {
    let (_env, client, _owner, controller, depositor) = setup();

    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    client.increase_locked(&controller, &1_000_0000000);

    client.request_withdrawal(&depositor, &shares);
    assert_eq!(client.balance(&depositor), 0);

    // Cancel — shares returned
    client.cancel_withdrawal(&depositor, &0);
    assert_eq!(client.balance(&depositor), shares);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
}

#[test]
fn test_snapshot() {
    let (env, client, _owner, _controller, depositor) = setup();

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // Set ledger timestamp
    env.ledger().with_mut(|li| {
        li.timestamp = 100_000;
    });

    client.snapshot();

    let day = 100_000 / SECONDS_PER_DAY;
    let price = client.get_snapshot_price(&day);
    assert!(price > 0);
}

#[test]
fn test_snapshot_noop_if_too_soon() {
    let (env, client, _owner, _controller, depositor) = setup();

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    env.ledger().with_mut(|li| {
        li.timestamp = 100_000;
    });
    client.snapshot();

    // Call again immediately — should be a no-op (not panic)
    env.ledger().with_mut(|li| {
        li.timestamp = 100_001;
    });
    client.snapshot();

    // First snapshot price should still be set
    let day = 100_000 / 86400;
    let price = client.get_snapshot_price(&day);
    assert!(price > 0);
}

#[test]
fn test_tma_tracking_through_operations() {
    let (env, client, _owner, controller, depositor) = setup();
    let usdc_client = token::StellarAssetClient::new(&env, &client.asset());

    // Deposit 1000
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // Record premium income +50 (simulate USDC arriving from FlightPool)
    usdc_client.mint(&client.address, &50_0000000);
    client.record_premium_income(&controller, &50_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_050_0000000);

    // Send payout -200
    client.send_payout(&controller, &Address::generate(&env), &200_0000000);
    assert_eq!(client.get_total_managed_assets(), 850_0000000);

    // Withdraw 100
    client.withdraw(&100_0000000, &depositor, &depositor, &depositor);
    assert_eq!(client.get_total_managed_assets(), 750_0000000);
}

#[test]
fn test_multiple_depositors() {
    let (env, client, _owner, _controller, depositor) = setup();
    let usdc_client = token::StellarAssetClient::new(&env, &client.asset());

    let depositor2 = Address::generate(&env);
    usdc_client.mint(&depositor2, &5_000_0000000);

    // First depositor: 1000 USDC
    let shares1 = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // Second depositor: 500 USDC
    let shares2 = client.deposit(&500_0000000, &depositor2, &depositor2, &depositor2);

    assert_eq!(client.get_total_managed_assets(), 1_500_0000000);
    assert!(shares1 > 0);
    assert!(shares2 > 0);
    // First depositor should have ~2x the shares of second
    assert_eq!(shares1, shares2 * 2);
}
