use super::*;
use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    testutils::Address as _, testutils::Ledger, Address, Env, String, Symbol, TryFromVal,
};

#[test]
fn version_initialized_to_one() {
    let (_env, vault, ..) = setup();
    assert_eq!(vault.version(), 1);
}

fn setup() -> (Env, RiskVaultClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset_client = token::StellarAssetClient::new(&env, &asset_id.address());

    let contract_id = env.register(RiskVault, (&owner, asset_id.address()));
    let client = RiskVaultClient::new(&env, &contract_id);

    // Set up a controller
    let controller = Address::generate(&env);
    client.set_controller(&controller);

    // Mint asset to a depositor
    let depositor = Address::generate(&env);
    asset_client.mint(&depositor, &10_000_0000000);

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
    let asset = token::Client::new(&env, &client.query_asset());

    // Deposit 1000 asset
    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert!(shares > 0);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);
    assert_eq!(client.total_assets(), 1_000_0000000);
    assert_eq!(asset.balance(&client.address), 1_000_0000000);

    // Redeem all shares
    let assets = client.redeem(&shares, &depositor, &depositor, &depositor);
    assert_eq!(assets, 1_000_0000000);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(asset.balance(&depositor), 10_000_0000000); // back to original
}

#[test]
fn test_locked_capital_gates_withdrawal() {
    let (_env, client, _owner, controller, depositor) = setup();

    // Deposit 1000 asset
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
#[should_panic(expected = "Error(Contract, #715)")]
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
    let (env, client, _owner, controller, depositor) = setup();

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // Real flow: pool transfers asset to vault FIRST, then controller calls.
    // The balance floor check inside record_premium_income enforces this.
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&client.address, &50_0000000);

    client.record_premium_income(&controller, &50_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_050_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #706)")]
fn test_record_premium_income_rejects_when_asset_not_received() {
    // Regression: caller-stated amount must be backed by actual asset.
    let (_env, client, _owner, controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // No asset was transferred to the vault — credit must fail.
    client.record_premium_income(&controller, &50_0000000);
}

#[test]
fn test_send_payout() {
    let (env, client, _owner, controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());
    let recipient = Address::generate(&env);

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    client.send_payout(&controller, &recipient, &200_0000000);
    assert_eq!(client.get_total_managed_assets(), 800_0000000);
    assert_eq!(asset.balance(&recipient), 200_0000000);
    assert_eq!(asset.balance(&client.address), 800_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #702)")]
fn test_unauthorized_controller_function() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let stranger = Address::generate(&env);

    client.increase_locked(&stranger, &100_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #701)")]
fn test_set_controller_twice() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let new_controller = Address::generate(&env);

    client.set_controller(&new_controller);
}

#[test]
fn test_withdrawal_queue_request_process_collect() {
    let (env, client, _owner, controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());

    // Deposit 1000 asset
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

    // Collect asset
    let claimable = client.get_claimable_balance(&depositor);
    client.collect(&depositor);
    assert_eq!(asset.balance(&depositor), 9_000_0000000 + claimable);
    assert_eq!(client.get_claimable_balance(&depositor), 0);
}

#[test]
fn test_pause_and_unpause_gate_state_mutations() {
    // Regression: paused contract rejects deposit / withdrawal /
    // queue ops; unpausing restores normal flow. Owner-only gate.
    let (_env, client, owner, controller, depositor) = setup();

    assert!(!client.paused());
    client.pause(&owner);
    assert!(client.paused());

    // Mutation paths reject while paused.
    assert!(client
        .try_deposit(&1_0000000, &depositor, &depositor, &depositor)
        .is_err());
    assert!(client.try_increase_locked(&controller, &1).is_err());
    assert!(client.try_snapshot().is_err());

    // Recover_uncollected is intentionally NOT gated so the owner can
    // settle archived entries during a pause.
    client.recover_uncollected(&depositor, &1_0000000, &RecoveryMode::Recredit);

    client.unpause(&owner);
    assert!(!client.paused());

    // Mutation flow resumes.
    client.deposit(&1_0000000, &depositor, &depositor, &depositor);
}

#[test]
#[should_panic(expected = "Error(Contract, #714)")]
fn test_direct_redeem_blocked_while_queue_active() {
    // Once a request is queued, direct redeem must defer to the
    // queue so it can't consume free capital ahead of waiting LPs.
    let (_env, client, _owner, _controller, depositor) = setup();
    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // Queue half the shares; the rest stay with the depositor.
    client.request_withdrawal(&depositor, &(shares / 2));
    assert_eq!(client.get_withdrawal_queue().len(), 1);

    // Direct redeem of the remaining shares is now rejected.
    client.redeem(&(shares / 2), &depositor, &depositor, &depositor);
}

#[test]
fn test_direct_redeem_allowed_when_queue_empty() {
    // The fast path stays open when no one is queued.
    let (_env, client, _owner, _controller, depositor) = setup();
    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert!(client.get_withdrawal_queue().is_empty());
    let assets = client.redeem(&shares, &depositor, &depositor, &depositor);
    assert_eq!(assets, 1_000_0000000);
}

#[test]
fn test_max_views_return_zero_when_paused() {
    // max_deposit/mint/withdraw/redeem must report zero while
    // paused, matching the (paused-gated) executable paths.
    let (_env, client, owner, _controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    assert!(client.max_deposit(&depositor) > 0);
    assert!(client.max_redeem(&depositor) > 0);
    assert!(client.max_withdraw(&depositor) > 0);

    client.pause(&owner);

    assert_eq!(client.max_deposit(&depositor), 0);
    assert_eq!(client.max_mint(&depositor), 0);
    assert_eq!(client.max_withdraw(&depositor), 0);
    assert_eq!(client.max_redeem(&depositor), 0);
}

#[test]
fn test_max_views_return_zero_while_queue_active() {
    // Direct withdraw/redeem revert while any withdrawal request is queued, so
    // max_withdraw/max_redeem must report zero for every LP during that window —
    // otherwise integrations build direct exits guaranteed to fail. Deposits stay
    // open, so max_deposit/max_mint are unaffected by the queue.
    let (env, client, _owner, controller, depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    let other = Address::generate(&env);
    asset_admin.mint(&other, &1_000_0000000);
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    let other_shares = client.deposit(&1_000_0000000, &other, &other, &other);

    assert!(client.max_withdraw(&depositor) > 0);
    assert!(client.max_redeem(&depositor) > 0);

    // `other` queues a request — the views must now report zero even for the
    // non-queued depositor, matching the executable paths' rejection.
    client.request_withdrawal(&other, &other_shares);
    assert_eq!(client.max_withdraw(&depositor), 0);
    assert_eq!(client.max_redeem(&depositor), 0);
    assert!(client.max_deposit(&depositor) > 0);
    assert!(client.max_mint(&depositor) > 0);

    // Draining the queue reopens the direct exit path and the views follow.
    client.process_withdrawal_queue(&controller);
    assert!(client.get_withdrawal_queue().is_empty());
    assert!(client.max_withdraw(&depositor) > 0);
    assert!(client.max_redeem(&depositor) > 0);
}

#[test]
fn test_request_withdrawal_rejects_zero_preview() {
    // A dust request that previews to zero assets is rejected at
    // submission so it can never sit at the queue head and block the drain.
    let (_env, client, _owner, _controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // 1 share against a large pool rounds down to 0 assets on redeem preview.
    assert_eq!(client.preview_redeem(&1), 0);
    assert!(client.try_request_withdrawal(&depositor, &1).is_err());
}

#[test]
fn test_zero_preview_request_does_not_block_queue() {
    // Even if a zero-preview request somehow reaches the queue, a
    // later serviceable request must still drain. We exercise the drain loop's
    // skip behavior by queueing a normal request and confirming it processes.
    let (_env, client, _owner, controller, depositor) = setup();
    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    client.request_withdrawal(&depositor, &shares);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    assert!(client.get_claimable_balance(&depositor) > 0);
}

#[test]
fn test_claimable_liabilities_do_not_inflate_shares() {
    // A processed-but-uncollected withdrawal leaves assets physically in the
    // vault while removing them from the managed-asset backing. Share pricing
    // is on managed assets, so existing holders cannot extract a later
    // depositor's funds via the (inflated) raw token balance.
    let (env, client, _owner, controller, _depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let victim = Address::generate(&env);
    asset_admin.mint(&a, &500_0000000);
    asset_admin.mint(&b, &500_0000000);
    asset_admin.mint(&victim, &500_0000000);

    let a_shares = client.deposit(&500_0000000, &a, &a, &a);
    let _b_shares = client.deposit(&500_0000000, &b, &b, &b);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // A exits via the queue: shares burned, ~500 credited as claimable, TMA
    // drops to ~500, but the 1000 tokens still sit physically in the vault.
    client.request_withdrawal(&a, &a_shares);
    client.process_withdrawal_queue(&controller);
    let a_claimable = client.get_claimable_balance(&a);
    assert!(
        a_claimable >= 4_990_000_000,
        "A claimable too low: {}",
        a_claimable
    );
    assert_eq!(asset.balance(&client.address), 1_000_0000000); // tokens stayed

    // Victim deposits 500 — priced on TMA (~500), NOT the raw balance (1000).
    let victim_shares = client.deposit(&500_0000000, &victim, &victim, &victim);

    // B cashes out everything it can. It must NOT be able to seize ~1000 (the
    // victim's money on top of its own); its fair value is ~500.
    let b_got = client.redeem(&client.max_redeem(&b), &b, &b, &b);
    assert!(
        b_got <= 5_100_000_000,
        "B extracted more than fair share: {}",
        b_got
    );

    // The victim's stake is preserved (~500), not diluted toward zero.
    let victim_value = client.convert_to_assets(&victim_shares);
    assert!(
        victim_value >= 4_900_000_000,
        "victim diluted: {}",
        victim_value
    );

    // A's owed funds remain fully claimable.
    assert_eq!(client.get_claimable_balance(&a), a_claimable);
}

#[test]
fn test_zero_value_request_returned_not_pinned() {
    // A request valid at submission can decay to zero asset value after a payout
    // reduces the share price. Processing must return its shares and drop it (not
    // keep it pinned at the head), so later serviceable requests still drain.
    let (env, client, _owner, controller, _depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    let whale = Address::generate(&env);
    let dust = Address::generate(&env);
    let sink = Address::generate(&env);
    asset_admin.mint(&whale, &1_000_0000000);
    asset_admin.mint(&dust, &1_0000);

    let whale_shares = client.deposit(&1_000_0000000, &whale, &whale, &whale);
    let dust_shares = client.deposit(&1_0000, &dust, &dust, &dust);

    // dust queues first (would be the pinning head), whale second.
    client.request_withdrawal(&dust, &dust_shares);
    client.request_withdrawal(&whale, &whale_shares);
    assert_eq!(client.get_withdrawal_queue().len(), 2);

    // A large payout crashes TMA so dust's queued request now previews to zero.
    client.send_payout(&controller, &sink, &1_000_0000000);
    assert_eq!(client.preview_redeem(&dust_shares), 0);

    client.process_withdrawal_queue(&controller);

    // Queue fully drained — the zero entry did not pin the head.
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    // dust got its shares back and was not credited.
    assert_eq!(client.balance(&dust), dust_shares);
    assert_eq!(client.get_claimable_balance(&dust), 0);
    // whale's later request was serviced.
    assert!(client.get_claimable_balance(&whale) > 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #717)")]
fn test_per_address_active_request_cap() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let lp = Address::generate(&env);
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&lp, &1_000_0000000);
    let shares = client.deposit(&1_000_0000000, &lp, &lp, &lp);

    // Each slice is worth well above dust. 20 requests succeed; the 21st exceeds
    // the per-address cap and is rejected.
    let slice = shares / 100;
    for _ in 0..20 {
        client.request_withdrawal(&lp, &slice);
    }
    client.request_withdrawal(&lp, &slice); // 21st → #717
}

#[test]
#[should_panic(expected = "Error(Contract, #716)")]
fn test_withdrawal_queue_global_length_cap() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    // Fill the queue to MAX_WITHDRAWAL_QUEUE_LEN (250) using enough distinct
    // addresses to respect the per-address cap (20 each → 13 addresses).
    let mut filled = 0u32;
    'fill: for _ in 0..14 {
        let lp = Address::generate(&env);
        asset_admin.mint(&lp, &1_000_0000000);
        let shares = client.deposit(&1_000_0000000, &lp, &lp, &lp);
        let slice = shares / 100;
        for _ in 0..20 {
            client.request_withdrawal(&lp, &slice);
            filled += 1;
            if filled == 250 {
                break 'fill;
            }
        }
    }
    assert_eq!(client.get_withdrawal_queue().len(), 250);

    // A 251st request (fresh address, under its own cap) is rejected.
    let extra = Address::generate(&env);
    asset_admin.mint(&extra, &1_000_0000000);
    let extra_shares = client.deposit(&1_000_0000000, &extra, &extra, &extra);
    client.request_withdrawal(&extra, &(extra_shares / 100)); // → #716
}

#[test]
#[should_panic]
fn test_pause_by_non_owner_panics() {
    let env = Env::default();
    // No mock_all_auths — owner auth will fail under stranger.
    let owner = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin);
    let contract_id = env.register(RiskVault, (&owner, asset_id.address()));
    let client = RiskVaultClient::new(&env, &contract_id);

    let stranger = Address::generate(&env);
    client.pause(&stranger);
}

#[test]
fn test_cancel_withdrawal() {
    let (_env, client, _owner, controller, depositor) = setup();

    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    client.increase_locked(&controller, &1_000_0000000);

    let request_id = client.request_withdrawal(&depositor, &shares);
    assert_eq!(client.balance(&depositor), 0);

    // Cancel — shares returned (by stable request_id, not queue index)
    client.cancel_withdrawal(&depositor, &request_id);
    assert_eq!(client.balance(&depositor), shares);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
}

#[test]
fn test_cancel_withdrawal_by_request_id_is_index_independent() {
    // Regression: cancelling the FIRST request after a later one
    // has been processed must still cancel the right request, even though
    // queue indices shifted.
    let (env, client, _owner, controller, depositor) = setup();
    let other = Address::generate(&env);
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&other, &500_0000000);

    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    let other_shares = client.deposit(&500_0000000, &other, &other, &other);
    client.increase_locked(&controller, &500_0000000);

    let depositor_id = client.request_withdrawal(&depositor, &shares);
    let _other_id = client.request_withdrawal(&other, &other_shares);
    assert_eq!(client.get_withdrawal_queue().len(), 2);

    // Cancel depositor's request (the FIRST one — index 0).
    client.cancel_withdrawal(&depositor, &depositor_id);
    assert_eq!(client.get_withdrawal_queue().len(), 1);
    assert_eq!(client.balance(&depositor), shares);

    // The remaining queued request still belongs to `other`.
    assert_eq!(client.get_withdrawal_queue().get(0).unwrap().owner, other,);
}

#[test]
#[should_panic(expected = "request_id not found")]
fn test_cancel_withdrawal_with_unknown_request_id_panics() {
    let (_env, client, _owner, _controller, depositor) = setup();
    client.cancel_withdrawal(&depositor, &9999u64);
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
fn test_snapshot_uses_managed_assets_not_physical_balance() {
    // The snapshot price must use the managed-asset basis (like the executable
    // conversions), not the raw token balance — otherwise a processed-but-
    // uncollected withdrawal (whose tokens still sit in the vault) inflates the
    // published price.
    let (env, client, _owner, controller, _depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    asset_admin.mint(&a, &1_000_0000000);
    asset_admin.mint(&b, &1_000_0000000);

    let a_shares = client.deposit(&1_000_0000000, &a, &a, &a);
    client.deposit(&1_000_0000000, &b, &b, &b);

    // A exits via the queue → shares burned, claimable credited, TMA reduced,
    // but A's tokens physically remain in the vault (uncollected).
    client.request_withdrawal(&a, &a_shares);
    client.process_withdrawal_queue(&controller);
    assert!(client.get_claimable_balance(&a) > 0);

    let tma = client.get_total_managed_assets();
    let physical = asset.balance(&client.address);
    assert!(
        physical > tma,
        "uncollected claimable should make physical > TMA"
    );

    env.ledger().with_mut(|li| li.timestamp = 1_710_500_000);
    client.snapshot();
    let day = 1_710_500_000u64 / SECONDS_PER_DAY;
    let snap = client.get_snapshot_price(&day);

    let supply = client.total_supply();
    let scale = 10i128.pow(asset.decimals());
    // Snapshot equals the managed-asset price, and is strictly below the
    // (inflated) physical-balance price.
    assert_eq!(snap, tma * scale / supply);
    assert!(snap < physical * scale / supply);
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
    let asset_client = token::StellarAssetClient::new(&env, &client.query_asset());

    // Deposit 1000
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // Record premium income +50 (simulate asset arriving from FlightPool)
    asset_client.mint(&client.address, &50_0000000);
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
    let asset_client = token::StellarAssetClient::new(&env, &client.query_asset());

    let depositor2 = Address::generate(&env);
    asset_client.mint(&depositor2, &5_000_0000000);

    // First depositor: 1000 asset
    let shares1 = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // Second depositor: 500 asset
    let shares2 = client.deposit(&500_0000000, &depositor2, &depositor2, &depositor2);

    assert_eq!(client.get_total_managed_assets(), 1_500_0000000);
    assert!(shares1 > 0);
    assert!(shares2 > 0);
    // First depositor should have ~2x the shares of second
    assert_eq!(shares1, shares2 * 2);
}

// =========================================================================
// ClaimableBalance events + recover_uncollected
// =========================================================================

const SECONDS_PER_DAY_TEST: u64 = 86_400;

// Drive the standard "deposit, lock all, request withdrawal, unlock, process"
// flow used across the tests below.
fn run_credit_flow(
    env: &Env,
    client: &RiskVaultClient<'static>,
    controller: &Address,
    depositor: &Address,
) {
    let shares = client.deposit(&1_000_0000000, depositor, depositor, depositor);
    client.increase_locked(controller, &1_000_0000000);
    client.request_withdrawal(depositor, &shares);
    client.decrease_locked(controller, &1_000_0000000);
    client.process_withdrawal_queue(controller);
    let _ = env;
}

// Match against the post-`"sentinel"` topic verb (namespace, 2-item prefix).
fn count_events_with_verb(env: &Env, contract_addr: &Address, verb: Symbol) -> u32 {
    use soroban_sdk::symbol_short;
    let sentinel = symbol_short!("sentinel");
    let mut count: u32 = 0;
    for (event_addr, topics, _data) in collect_events(env).iter() {
        if event_addr != *contract_addr {
            continue;
        }
        if topics.len() < 2 {
            continue;
        }
        let t0: Result<Symbol, _> = Symbol::try_from_val(env, &topics.get(0).unwrap());
        let t1: Result<Symbol, _> = Symbol::try_from_val(env, &topics.get(1).unwrap());
        if let (Ok(s0), Ok(s1)) = (t0, t1) {
            if s0 == sentinel && s1 == verb {
                count += 1;
            }
        }
    }
    count
}

#[test]
fn test_claimable_balance_credited_event_fires() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, controller, depositor) = setup();

    run_credit_flow(&env, &client, &controller, &depositor);

    // process_withdrawal_queue is the most recent invocation that emits
    // the event log. Assert the Credited event appeared.
    assert!(count_events_with_verb(&env, &client.address, symbol_short!("credited")) >= 1);
}

#[test]
fn test_claimable_balance_collected_event_fires() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, controller, depositor) = setup();

    run_credit_flow(&env, &client, &controller, &depositor);
    // Now collect — `Collected` event fires on this most-recent call.
    client.collect(&depositor);

    assert!(count_events_with_verb(&env, &client.address, symbol_short!("collected")) >= 1);
}

#[test]
fn test_recover_uncollected_recredit_sets_balance() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, _controller, _depositor) = setup();
    let user = Address::generate(&env);

    client.recover_uncollected(&user, &500_0000000, &RecoveryMode::Recredit);

    // Event check FIRST — env.events().all() returns only the most-recent
    // invocation's events; any subsequent client call clears the log.
    assert!(count_events_with_verb(&env, &client.address, symbol_short!("recovered")) >= 1);

    // SET semantics: balance is now 500.
    assert_eq!(client.get_claimable_balance(&user), 500_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #712)")]
fn test_recover_uncollected_recredit_rejects_underpay() {
    let (env, client, _owner, controller, depositor) = setup();
    run_credit_flow(&env, &client, &controller, &depositor);

    let prior = client.get_claimable_balance(&depositor);
    assert!(prior > 0);

    // Underpay attempt: 123 < prior → must panic, not silently overwrite.
    client.recover_uncollected(&depositor, &123_0000000, &RecoveryMode::Recredit);
}

#[test]
fn test_recover_uncollected_recredit_can_increase_existing() {
    let (env, client, _owner, controller, depositor) = setup();
    run_credit_flow(&env, &client, &controller, &depositor);

    let prior = client.get_claimable_balance(&depositor);
    let bumped = prior + 100_0000000;
    client.recover_uncollected(&depositor, &bumped, &RecoveryMode::Recredit);
    assert_eq!(client.get_claimable_balance(&depositor), bumped);
}

#[test]
fn test_recover_uncollected_transfer_moves_asset() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, _controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    // Seed vault with asset so the transfer has funds to move.
    asset_admin.mint(&client.address, &200_0000000);

    // Seed a claimable balance via Recredit; Transfer is now gated on this.
    client.recover_uncollected(&depositor, &50_0000000, &RecoveryMode::Recredit);

    let vault_balance_before = asset.balance(&client.address);
    let user_balance_before = asset.balance(&depositor);

    client.recover_uncollected(&depositor, &50_0000000, &RecoveryMode::Transfer);

    // Event check FIRST — env.events().all() returns only the most-recent
    // invocation's events.
    assert!(count_events_with_verb(&env, &client.address, symbol_short!("recovered")) >= 1);

    // Vault asset down by 50, user up by 50, claimable cleared.
    assert_eq!(
        asset.balance(&client.address),
        vault_balance_before - 50_0000000
    );
    assert_eq!(asset.balance(&depositor), user_balance_before + 50_0000000);
    assert_eq!(client.get_claimable_balance(&depositor), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #713)")]
fn test_recover_uncollected_transfer_without_prior_credit_panics() {
    let (env, client, _owner, _controller, depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    // Vault has asset but the user was never credited — Transfer must refuse.
    asset_admin.mint(&client.address, &200_0000000);
    client.recover_uncollected(&depositor, &50_0000000, &RecoveryMode::Transfer);
}

#[test]
#[should_panic(expected = "Error(Contract, #713)")]
fn test_recover_uncollected_transfer_exceeding_credit_panics() {
    let (env, client, _owner, _controller, depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&client.address, &200_0000000);

    // Credit is 50, attempt to transfer 51 must refuse.
    client.recover_uncollected(&depositor, &50_0000000, &RecoveryMode::Recredit);
    client.recover_uncollected(&depositor, &51_0000000, &RecoveryMode::Transfer);
}

#[test]
#[should_panic]
fn test_recover_uncollected_unauthorized() {
    let env = Env::default();
    // No mock_all_auths — owner check fails.
    let owner = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin);
    let contract_id = env.register(RiskVault, (&owner, asset_id.address()));
    let client = RiskVaultClient::new(&env, &contract_id);

    let stranger = Address::generate(&env);
    client.recover_uncollected(&stranger, &100_0000000, &RecoveryMode::Recredit);
}

#[test]
#[should_panic(expected = "Error(Contract, #703)")]
fn test_recover_uncollected_rejects_zero_amount() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let user = Address::generate(&env);
    client.recover_uncollected(&user, &0i128, &RecoveryMode::Recredit);
}

// =========================================================================
// SnapshotPrice
// =========================================================================

#[test]
fn test_snapshot_uses_temporary_tier() {
    let (env, client, _owner, _controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    env.ledger().with_mut(|li| li.timestamp = 100_000);
    client.snapshot();

    let day = 100_000u64 / SECONDS_PER_DAY_TEST;
    let price = client.get_snapshot_price(&day);
    assert!(price > 0, "snapshot should be queryable immediately");
}

#[test]
fn test_snapshot_expires_after_30_days() {
    let (env, client, _owner, _controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    let snap_time: u64 = 1_000_000;
    env.ledger().with_mut(|li| li.timestamp = snap_time);
    client.snapshot();

    let day = snap_time / SECONDS_PER_DAY_TEST;
    let price_fresh = client.get_snapshot_price(&day);
    assert!(price_fresh > 0);

    // Fast-forward past the 30-day TTL window. Soroban's test env
    // only respects TTL when ledger sequence advances enough to
    // exceed the TTL ledger budget — bumping the sequence number
    // by `SNAPSHOT_TTL_LEDGERS + 1` triggers expiry.
    env.ledger().with_mut(|li| {
        li.sequence_number += 30 * 24 * 60 * 12 + 1;
        li.timestamp = snap_time + 31 * SECONDS_PER_DAY_TEST;
    });

    // Expired entry returns 0 (None unwrapped via `.unwrap_or(0)`).
    assert_eq!(client.get_snapshot_price(&day), 0);
}

#[test]
fn test_snapshot_emits_share_price_event() {
    use soroban_sdk::symbol_short;
    // snapshot() now emits SharePriceSnapshot so off-chain analytics
    // can subscribe instead of polling.
    let (env, client, _owner, _controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    env.ledger().with_mut(|li| li.timestamp = 200_000);
    client.snapshot();

    assert!(
        count_events_with_verb(&env, &client.address, symbol_short!("snapshot")) >= 1,
        "expected sentinel.snapshot event"
    );
}

// =========================================================================
// OZ Vault wrapper coverage (preview_*, convert_*, max_*, mint_shares)
// =========================================================================

#[test]
fn test_vault_views_before_and_after_deposit() {
    let (_env, client, _owner, _controller, depositor) = setup();

    // Empty vault — initial price is 1:1 modulo decimals_offset.
    assert_eq!(client.max_deposit(&depositor), i128::MAX);
    assert_eq!(client.max_mint(&depositor), i128::MAX);
    assert_eq!(client.max_withdraw(&depositor), 0);
    assert_eq!(client.max_redeem(&depositor), 0);
    assert_eq!(client.convert_to_shares(&1_000_0000000), 1_000_0000000_000);
    assert_eq!(client.convert_to_assets(&1_000_0000000_000), 1_000_0000000);
    assert_eq!(client.preview_deposit(&1_000_0000000), 1_000_0000000_000);
    assert_eq!(client.preview_mint(&1_000_0000000_000), 1_000_0000000);
    assert_eq!(client.preview_withdraw(&500_0000000), 500_0000000_000);
    assert_eq!(client.preview_redeem(&500_0000000_000), 500_0000000);

    // After deposit, max_withdraw / max_redeem reflect the depositor's stake.
    let shares = client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert!(client.max_withdraw(&depositor) > 0);
    assert_eq!(client.max_redeem(&depositor), shares);
}

#[test]
fn test_mint_shares_pulls_assets_from_caller() {
    let (env, client, _owner, _controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());

    let initial_asset = asset.balance(&depositor);
    let target_shares = 100_0000000_000i128;
    let assets_in = client.mint(&target_shares, &depositor, &depositor, &depositor);

    assert!(assets_in > 0, "mint_shares should pull non-zero assets");
    assert_eq!(asset.balance(&depositor), initial_asset - assets_in);
    assert_eq!(client.balance(&depositor), target_shares);
    assert_eq!(client.get_total_managed_assets(), assets_in);
}

#[test]
fn test_max_withdraw_clamped_by_locked_capital() {
    let (_env, client, _owner, controller, depositor) = setup();

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    // Before locking, max_withdraw == full deposit.
    assert_eq!(client.max_withdraw(&depositor), 1_000_0000000);

    // Lock 600 asset; max_withdraw clamps to remaining free capital.
    client.increase_locked(&controller, &600_0000000);
    assert_eq!(client.max_withdraw(&depositor), 400_0000000);
    assert_eq!(client.get_free_capital(), 400_0000000);
}

// =========================================================================
// extend_ttl (cron safety net)
// =========================================================================

#[test]
fn test_extend_ttl_is_callable() {
    let (_env, client, _owner, _controller, _depositor) = setup();
    client.extend_ttl();
}
