use super::*;
use soroban_sdk::{
    testutils::Address as _, testutils::Events as _, testutils::Ledger, Env, Symbol, TryFromVal,
    Val, Vec as SVec,
};

// Decode the testutils ContractEvents wrapper (soroban-sdk 25+) back into the
// pre-25 `(Address, Vec<Val>, Val)` tuple shape the assertions below rely on.
fn collect_events(env: &Env) -> SVec<(Address, SVec<Val>, Val)> {
    use soroban_sdk::xdr::{ContractEventBody, ScAddress, ScVal};
    let mut out: SVec<(Address, SVec<Val>, Val)> = SVec::new(env);
    for e in env.events().all().events() {
        let cid = e.contract_id.clone().unwrap();
        let addr =
            Address::try_from_val(env, &ScVal::Address(ScAddress::Contract(cid))).unwrap();
        let ContractEventBody::V0(body) = &e.body;
        let mut topics: SVec<Val> = SVec::new(env);
        for sv in body.topics.iter() {
            topics.push_back(Val::try_from_val(env, sv).unwrap());
        }
        let data = Val::try_from_val(env, &body.data).unwrap();
        out.push_back((addr, topics, data));
    }
    out
}

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
    let (env, client, _owner, controller, depositor) = setup();

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // Real flow: pool transfers USDC to vault FIRST, then controller calls.
    // The balance floor check inside record_premium_income enforces this.
    let usdc_admin = token::StellarAssetClient::new(&env, &client.asset());
    usdc_admin.mint(&client.address, &50_0000000);

    client.record_premium_income(&controller, &50_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_050_0000000);
}

#[test]
#[should_panic(expected = "premium not received")]
fn test_record_premium_income_rejects_when_usdc_not_received() {
    // Regression for M-06: caller-stated amount must be backed by actual USDC.
    let (_env, client, _owner, controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    // No USDC was transferred to the vault — credit must fail.
    client.record_premium_income(&controller, &50_0000000);
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
fn test_pause_and_unpause_gate_state_mutations() {
    // Regression for H-03: paused contract rejects deposit / withdrawal /
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
#[should_panic]
fn test_pause_by_non_owner_panics() {
    let env = Env::default();
    // No mock_all_auths — owner auth will fail under stranger.
    let owner = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let contract_id = env.register(RiskVault, (&owner, usdc_id.address()));
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
    // Regression for M-04: cancelling the FIRST request after a later one
    // has been processed must still cancel the right request, even though
    // queue indices shifted.
    let (env, client, _owner, controller, depositor) = setup();
    let other = Address::generate(&env);
    let usdc_admin = token::StellarAssetClient::new(&env, &client.asset());
    usdc_admin.mint(&other, &500_0000000);

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
    assert_eq!(
        client.get_withdrawal_queue().get(0).unwrap().owner,
        other,
    );
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

fn count_events_with_topic(
    env: &Env,
    contract_addr: &Address,
    prefix0: Symbol,
    prefix1: Symbol,
) -> u32 {
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
            if s0 == prefix0 && s1 == prefix1 {
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
    assert!(
        count_events_with_topic(
            &env,
            &client.address,
            symbol_short!("vault"),
            symbol_short!("credited"),
        ) >= 1
    );
}

#[test]
fn test_claimable_balance_collected_event_fires() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, controller, depositor) = setup();

    run_credit_flow(&env, &client, &controller, &depositor);
    // Now collect — `Collected` event fires on this most-recent call.
    client.collect(&depositor);

    assert!(
        count_events_with_topic(
            &env,
            &client.address,
            symbol_short!("vault"),
            symbol_short!("collected"),
        ) >= 1
    );
}

#[test]
fn test_recover_uncollected_recredit_sets_balance() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, _controller, _depositor) = setup();
    let user = Address::generate(&env);

    client.recover_uncollected(&user, &500_0000000, &RecoveryMode::Recredit);

    // Event check FIRST — env.events().all() returns only the most-recent
    // invocation's events; any subsequent client call clears the log.
    assert!(
        count_events_with_topic(
            &env,
            &client.address,
            symbol_short!("vault"),
            symbol_short!("recovered"),
        ) >= 1
    );

    // SET semantics: balance is now 500.
    assert_eq!(client.get_claimable_balance(&user), 500_0000000);
}

#[test]
#[should_panic(expected = "Recredit would underpay")]
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
fn test_recover_uncollected_transfer_moves_usdc() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, _controller, depositor) = setup();
    let usdc = token::Client::new(&env, &client.asset());
    let usdc_admin = token::StellarAssetClient::new(&env, &client.asset());

    // Seed vault with USDC so the transfer has funds to move.
    usdc_admin.mint(&client.address, &200_0000000);

    // Seed a claimable balance via Recredit; Transfer is now gated on this.
    client.recover_uncollected(&depositor, &50_0000000, &RecoveryMode::Recredit);

    let vault_balance_before = usdc.balance(&client.address);
    let user_balance_before = usdc.balance(&depositor);

    client.recover_uncollected(&depositor, &50_0000000, &RecoveryMode::Transfer);

    // Event check FIRST — env.events().all() returns only the most-recent
    // invocation's events.
    assert!(
        count_events_with_topic(
            &env,
            &client.address,
            symbol_short!("vault"),
            symbol_short!("recovered"),
        ) >= 1
    );

    // Vault USDC down by 50, user up by 50, claimable cleared.
    assert_eq!(usdc.balance(&client.address), vault_balance_before - 50_0000000);
    assert_eq!(usdc.balance(&depositor), user_balance_before + 50_0000000);
    assert_eq!(client.get_claimable_balance(&depositor), 0);
}

#[test]
#[should_panic(expected = "amount exceeds claimable balance")]
fn test_recover_uncollected_transfer_without_prior_credit_panics() {
    let (env, client, _owner, _controller, depositor) = setup();
    let usdc_admin = token::StellarAssetClient::new(&env, &client.asset());

    // Vault has USDC but the user was never credited — Transfer must refuse.
    usdc_admin.mint(&client.address, &200_0000000);
    client.recover_uncollected(&depositor, &50_0000000, &RecoveryMode::Transfer);
}

#[test]
#[should_panic(expected = "amount exceeds claimable balance")]
fn test_recover_uncollected_transfer_exceeding_credit_panics() {
    let (env, client, _owner, _controller, depositor) = setup();
    let usdc_admin = token::StellarAssetClient::new(&env, &client.asset());
    usdc_admin.mint(&client.address, &200_0000000);

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
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let contract_id = env.register(RiskVault, (&owner, usdc_id.address()));
    let client = RiskVaultClient::new(&env, &contract_id);

    let stranger = Address::generate(&env);
    client.recover_uncollected(&stranger, &100_0000000, &RecoveryMode::Recredit);
}

#[test]
#[should_panic(expected = "amount must be positive")]
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
fn test_snapshot_emits_no_event() {
    let (env, client, _owner, _controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);

    env.ledger().with_mut(|li| li.timestamp = 200_000);
    client.snapshot();

    // `snapshot()` is intentionally event-free — snapshots aren't in the
    // indexer pipeline. The most-recent invocation's event log should be
    // empty for the snapshot path.
    let events = collect_events(&env);
    let mut snapshot_events = 0u32;
    for (event_addr, _topics, _data) in events.iter() {
        if event_addr == client.address {
            snapshot_events += 1;
        }
    }
    assert_eq!(snapshot_events, 0);
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
    let usdc = token::Client::new(&env, &client.asset());

    let initial_usdc = usdc.balance(&depositor);
    let target_shares = 100_0000000_000i128;
    let assets_in = client.mint_shares(&target_shares, &depositor, &depositor, &depositor);

    assert!(assets_in > 0, "mint_shares should pull non-zero assets");
    assert_eq!(usdc.balance(&depositor), initial_usdc - assets_in);
    assert_eq!(client.balance(&depositor), target_shares);
    assert_eq!(client.get_total_managed_assets(), assets_in);
}

#[test]
fn test_max_withdraw_clamped_by_locked_capital() {
    let (_env, client, _owner, controller, depositor) = setup();

    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
    // Before locking, max_withdraw == full deposit.
    assert_eq!(client.max_withdraw(&depositor), 1_000_0000000);

    // Lock 600 USDC; max_withdraw clamps to remaining free capital.
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
