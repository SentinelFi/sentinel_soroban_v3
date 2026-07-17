use super::*;
use sentinel_types::test_support::{collect_events, MockPendingOracle, MockPendingOracleClient};
use soroban_sdk::{
    testutils::Address as _, testutils::Ledger, Address, Env, String, Symbol, TryFromVal,
};

// Mirrors the on-chain LP_PRICING_DELAY_SECS: queued requests may only be
// priced once they are at least this old.
const PRICING_DELAY: u64 = 6 * 3600;

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

    // The settlement barrier consults the oracle on every queue-processing
    // pass; the mock answers `has_pending_outcomes = false` so the barrier
    // stays open in tests that don't exercise it.
    let oracle_id = env.register(MockPendingOracle, ());

    let contract_id = env.register(RiskVault, (&owner, asset_id.address(), &oracle_id));
    let client = RiskVaultClient::new(&env, &contract_id);

    // Set up a controller
    let controller = Address::generate(&env);
    client.set_controller(&controller);

    // Mint asset to a depositor
    let depositor = Address::generate(&env);
    asset_client.mint(&depositor, &10_000_0000000);

    (env, client, owner, controller, depositor)
}

/// Advance ledger time past the LP pricing delay so every queued request
/// becomes priceable.
fn mature_requests(env: &Env) {
    env.ledger().with_mut(|li| li.timestamp += PRICING_DELAY);
}

/// Two-phase LP entry: request → mature → process. Returns the shares minted
/// to `from` by this entry.
fn lp_deposit(
    env: &Env,
    client: &RiskVaultClient<'static>,
    controller: &Address,
    from: &Address,
    assets: i128,
) -> i128 {
    let before = client.balance(from);
    client.request_deposit(from, &assets);
    mature_requests(env);
    client.process_deposit_queue(controller);
    client.balance(from) - before
}

#[test]
fn test_constructor() {
    let (env, client, owner, controller, _depositor) = setup();

    assert_eq!(client.get_owner(), Some(owner));
    assert_eq!(client.get_controller(), controller);
    assert_eq!(client.name(), String::from_str(&env, "RiskVault Share"));
    assert_eq!(client.symbol(), String::from_str(&env, "RVS"));
    assert_eq!(client.decimals(), 10);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(client.get_locked_capital(), 0);
    assert_eq!(client.get_free_capital(), 0);
    assert_eq!(client.total_assets(), 0);
}

// =========================================================================
// Two-phase entry/exit lifecycle
// =========================================================================

#[test]
fn test_two_phase_entry_and_exit_lifecycle() {
    let (env, client, _owner, controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());

    // Entry: request escrows assets without touching TMA or minting.
    client.request_deposit(&depositor, &1_000_0000000);
    assert_eq!(asset.balance(&client.address), 1_000_0000000);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(client.balance(&depositor), 0);
    assert_eq!(client.get_deposit_queue_len(), 1);

    // Only a matured request is priced.
    mature_requests(&env);
    client.process_deposit_queue(&controller);
    let shares = client.balance(&depositor);
    assert!(shares > 0);
    assert_eq!(client.get_deposit_queue_len(), 0);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);
    assert_eq!(client.total_assets(), 1_000_0000000);

    // Exit: request escrows shares; processing after maturity credits the
    // claimable balance; collect pulls the assets.
    client.request_withdrawal(&depositor, &shares);
    assert_eq!(client.balance(&depositor), 0);
    mature_requests(&env);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    let claimable = client.get_claimable_balance(&depositor);
    assert_eq!(claimable, 1_000_0000000);
    client.collect(&depositor);
    assert_eq!(asset.balance(&depositor), 10_000_0000000); // back to original
    assert_eq!(client.get_total_managed_assets(), 0);
}

#[test]
fn test_immature_requests_are_not_priced() {
    // The pricing delay is the point of the two-phase design: a request may
    // only be priced once every outcome knowable at commitment has reached
    // the chain. Neither queue prices a request younger than the delay.
    let (env, client, _owner, controller, depositor) = setup();

    client.request_deposit(&depositor, &1_000_0000000);
    client.process_deposit_queue(&controller);
    assert_eq!(client.get_deposit_queue_len(), 1);
    assert_eq!(client.balance(&depositor), 0);

    // One second short of maturity — still not priced.
    env.ledger()
        .with_mut(|li| li.timestamp += PRICING_DELAY - 1);
    client.process_deposit_queue(&controller);
    assert_eq!(client.get_deposit_queue_len(), 1);

    // At maturity the entry mints.
    env.ledger().with_mut(|li| li.timestamp += 1);
    client.process_deposit_queue(&controller);
    assert_eq!(client.get_deposit_queue_len(), 0);
    let shares = client.balance(&depositor);
    assert!(shares > 0);

    // Same for the exit side.
    client.request_withdrawal(&depositor, &shares);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 1);
    assert_eq!(client.get_claimable_balance(&depositor), 0);

    env.ledger()
        .with_mut(|li| li.timestamp += PRICING_DELAY - 1);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 1);

    env.ledger().with_mut(|li| li.timestamp += 1);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    assert!(client.get_claimable_balance(&depositor) > 0);
}

#[test]
fn test_informed_exit_cannot_dodge_a_pending_loss() {
    // The stale-NAV scenario the delay exists for: an LP who learns of a
    // payable outcome before the oracle writes it requests an exit
    // immediately. By the time the request matures, the outcome is on-chain
    // (the barrier holds processing until settled) and the exit prices at
    // the post-loss share value — the informed LP bears their share of the
    // loss exactly like the passive LP.
    let (env, client, _owner, controller, _depositor) = setup();
    let oracle = MockPendingOracleClient::new(&env, &client.get_oracle().unwrap());
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    let sink = Address::generate(&env);

    let informed = Address::generate(&env);
    let passive = Address::generate(&env);
    asset_admin.mint(&informed, &1_000_0000000);
    asset_admin.mint(&passive, &1_000_0000000);
    let informed_shares = lp_deposit(&env, &client, &controller, &informed, 1_000_0000000);
    let passive_shares = lp_deposit(&env, &client, &controller, &passive, 1_000_0000000);

    // T0: the outcome is publicly knowable off-chain; the informed LP
    // commits an exit at once. Nothing on-chain has changed yet.
    client.request_withdrawal(&informed, &informed_shares);

    // Well before the request matures, the oracle write lands and the
    // settlement pipeline recognizes a 40-asset loss.
    env.ledger().with_mut(|li| li.timestamp += 3600);
    oracle.set_pending_outcomes(&true);
    // While the outcome is pending, processing refuses to price anything —
    // even a matured request.
    env.ledger().with_mut(|li| li.timestamp += PRICING_DELAY);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 1);
    // Settlement: the vault pays out 40 and the barrier lifts.
    client.send_payout(&controller, &sink, &40_0000000);
    oracle.set_pending_outcomes(&false);

    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);

    // The informed LP exits at the post-loss price: ~980, not 1000.
    let informed_out = client.get_claimable_balance(&informed);
    assert!(
        informed_out < 985_0000000,
        "informed LP escaped the loss: {}",
        informed_out
    );
    // The passive LP holds shares of the same post-loss value — no transfer
    // between them occurred.
    let passive_value = client.convert_to_assets(&passive_shares);
    let diff = (informed_out - passive_value).abs();
    assert!(
        diff < 100,
        "LPs diverged: {} vs {}",
        informed_out,
        passive_value
    );
}

#[test]
fn test_informed_entry_cannot_capture_a_pending_gain() {
    // Entry-side mirror: premium income is about to be recognized; a
    // depositor who knows commits immediately, but the mint prices only
    // after the gain is already in TMA — no dilution of the incumbent LP.
    let (env, client, _owner, controller, depositor) = setup();
    let oracle = MockPendingOracleClient::new(&env, &client.get_oracle().unwrap());
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    let incumbent = Address::generate(&env);
    asset_admin.mint(&incumbent, &1_000_0000000);
    let incumbent_shares = lp_deposit(&env, &client, &controller, &incumbent, 1_000_0000000);

    // The informed entrant commits while the 100-asset premium income is
    // publicly certain but unrecognized.
    client.request_deposit(&depositor, &1_000_0000000);
    oracle.set_pending_outcomes(&true);

    // Barrier holds even at maturity; then settlement recognizes the income.
    mature_requests(&env);
    client.process_deposit_queue(&controller);
    assert_eq!(client.get_deposit_queue_len(), 1);
    asset_admin.mint(&client.address, &100_0000000);
    client.record_premium_income(&controller, &100_0000000);
    oracle.set_pending_outcomes(&false);

    client.process_deposit_queue(&controller);
    assert_eq!(client.get_deposit_queue_len(), 0);

    // The entrant was minted at the post-gain price: their stake is worth
    // their contribution, and the incumbent kept the full premium.
    let entrant_value = client.convert_to_assets(&client.balance(&depositor));
    assert!(
        entrant_value <= 1_000_0000000,
        "entrant captured incumbent gain: {}",
        entrant_value
    );
    let incumbent_value = client.convert_to_assets(&incumbent_shares);
    assert!(
        incumbent_value >= 1_099_0000000,
        "incumbent diluted: {}",
        incumbent_value
    );
}

#[test]
fn test_deposit_request_cancel_returns_escrow() {
    let (env, client, _owner, _controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());

    let id = client.request_deposit(&depositor, &400_0000000);
    assert_eq!(asset.balance(&depositor), 9_600_0000000);
    assert_eq!(client.get_deposit_queue_len(), 1);

    client.cancel_deposit(&depositor, &id);
    // Event check FIRST — collect_events only surfaces the most recent
    // invocation's events, and the balance reads below are invocations.
    assert!(count_events_with_verb(&env, &client.address, Symbol::new(&env, "dep_cancel")) >= 1);
    assert_eq!(asset.balance(&depositor), 10_000_0000000);
    assert_eq!(client.get_deposit_queue_len(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #721)")]
fn test_cancel_deposit_with_unknown_request_id_panics() {
    let (_env, client, _owner, _controller, depositor) = setup();
    client.cancel_deposit(&depositor, &9999u64);
}

#[test]
#[should_panic(expected = "Error(Contract, #710)")]
fn test_cancel_deposit_of_other_owner_panics() {
    let (env, client, _owner, _controller, depositor) = setup();
    let id = client.request_deposit(&depositor, &400_0000000);
    let stranger = Address::generate(&env);
    client.cancel_deposit(&stranger, &id);
}

#[test]
fn test_deposit_request_dropped_when_price_outgrows_it() {
    // A request valid at submission can decay to zero shares if the share
    // price rises sharply before processing. Processing must return the
    // escrow and close the request out instead of minting nothing.
    let (env, client, _owner, controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    lp_deposit(&env, &client, &controller, &depositor, 1_0000000);

    // 1 stroop previews to >0 shares now (the virtual decimals offset keeps
    // share units fine-grained)...
    client.request_deposit(&depositor, &1);
    let balance_after_request = asset.balance(&depositor);

    // ...but once the price per share-stroop exceeds one asset-stroop, the
    // request prices to zero at processing.
    asset_admin.mint(&client.address, &1_000_0000000);
    client.record_premium_income(&controller, &1_000_0000000);
    mature_requests(&env);
    client.process_deposit_queue(&controller);

    assert!(count_events_with_verb(&env, &client.address, Symbol::new(&env, "dep_dropped")) >= 1);
    assert_eq!(client.get_deposit_queue_len(), 0);
    assert_eq!(asset.balance(&depositor), balance_after_request + 1);
}

#[test]
fn test_request_deposit_rejects_nonpositive_and_dust() {
    let (env, client, _owner, controller, depositor) = setup();

    assert!(client.try_request_deposit(&depositor, &0).is_err());
    assert!(client.try_request_deposit(&depositor, &-5).is_err());

    // Inflate the share price: 1 asset in, then 1000 assets of premium
    // income. A 1-stroop request previews to zero shares — rejected early
    // so it can't occupy a queue slot.
    lp_deposit(&env, &client, &controller, &depositor, 1_0000000);
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&client.address, &1000_0000000);
    client.record_premium_income(&controller, &1000_0000000);

    assert_eq!(client.preview_deposit(&1), 0);
    assert!(client.try_request_deposit(&depositor, &1).is_err());
}

#[test]
#[should_panic(expected = "Error(Contract, #717)")]
fn test_deposit_queue_per_address_cap() {
    let (_env, client, _owner, _controller, depositor) = setup();
    for _ in 0..20 {
        client.request_deposit(&depositor, &1_0000000);
    }
    client.request_deposit(&depositor, &1_0000000); // 21st → #717
}

#[test]
#[should_panic(expected = "Error(Contract, #729)")]
fn test_deposit_queue_global_length_cap() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    // Fill the queue to MAX_DEPOSIT_QUEUE_LEN (100) across enough addresses
    // to respect the per-address cap (20 each → 5 addresses).
    for _ in 0..5 {
        let lp = Address::generate(&env);
        asset_admin.mint(&lp, &100_0000000);
        for _ in 0..20 {
            client.request_deposit(&lp, &1_0000000);
        }
    }
    assert_eq!(client.get_deposit_queue_len(), 100);

    let extra = Address::generate(&env);
    asset_admin.mint(&extra, &1_0000000);
    client.request_deposit(&extra, &1_0000000); // 101st → #729
}

#[test]
fn test_deposit_request_event_and_queue_len() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, _controller, depositor) = setup();

    assert_eq!(client.get_deposit_queue_len(), 0);
    client.request_deposit(&depositor, &100_0000000);
    assert!(count_events_with_verb(&env, &client.address, symbol_short!("dep_req")) >= 1);
    assert_eq!(client.get_deposit_queue_len(), 1);
}

#[test]
fn test_deposit_escrow_excluded_from_share_backing() {
    // Escrowed entries sit in the raw balance but back no shares: pricing
    // and premium-income accounting must not see them as managed assets.
    let (env, client, _owner, controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    let incumbent = Address::generate(&env);
    asset_admin.mint(&incumbent, &1_000_0000000);
    let incumbent_shares = lp_deposit(&env, &client, &controller, &incumbent, 1_000_0000000);

    client.request_deposit(&depositor, &1_000_0000000);
    assert_eq!(asset.balance(&client.address), 2_000_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // The incumbent's share value is unchanged by the pending escrow.
    assert_eq!(client.convert_to_assets(&incumbent_shares), 1_000_0000000);
}

// =========================================================================
// Direct (immediate-pricing) operations are disabled
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #727)")]
fn test_direct_deposit_disabled() {
    let (_env, client, _owner, _controller, depositor) = setup();
    client.deposit(&1_000_0000000, &depositor, &depositor, &depositor);
}

#[test]
#[should_panic(expected = "Error(Contract, #728)")]
fn test_direct_redeem_disabled() {
    let (_env, client, _owner, _controller, depositor) = setup();
    client.redeem(&1_000, &depositor, &depositor, &depositor);
}

#[test]
fn test_all_direct_ops_disabled_and_max_views_zero() {
    // The immediate operations priced at call time — stale with respect to
    // any publicly-knowable-but-unwritten outcome — so all four are
    // permanently disabled and their max_* views report zero so
    // integrations never build a doomed transaction.
    let (env, client, _owner, controller, depositor) = setup();
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    assert!(client
        .try_deposit(&1_0000000, &depositor, &depositor, &depositor)
        .is_err());
    assert!(client
        .try_mint(&1_000, &depositor, &depositor, &depositor)
        .is_err());
    assert!(client
        .try_withdraw(&1_0000000, &depositor, &depositor, &depositor)
        .is_err());
    assert!(client
        .try_redeem(&1_000, &depositor, &depositor, &depositor)
        .is_err());

    assert_eq!(client.max_deposit(&depositor), 0);
    assert_eq!(client.max_mint(&depositor), 0);
    assert_eq!(client.max_withdraw(&depositor), 0);
    assert_eq!(client.max_redeem(&depositor), 0);
}

// =========================================================================
// Capital accounting
// =========================================================================

#[test]
fn test_locked_capital_gates_queue_processing() {
    let (env, client, _owner, controller, depositor) = setup();

    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    // Lock 800 → free = 200.
    client.increase_locked(&controller, &800_0000000);
    assert_eq!(client.get_locked_capital(), 800_0000000);
    assert_eq!(client.get_free_capital(), 200_0000000);

    // A full-position exit can only be funded up to free capital: the head
    // partial-fills to ~200 and the remainder stays queued.
    client.request_withdrawal(&depositor, &shares);
    mature_requests(&env);
    client.process_withdrawal_queue(&controller);
    let credited = client.get_claimable_balance(&depositor);
    assert!(credited > 0 && credited <= 200_0000000);
    assert!(200_0000000 - credited < 100);
    assert_eq!(client.get_withdrawal_queue().len(), 1);

    // Releasing collateral lets the remainder drain.
    client.decrease_locked(&controller, &800_0000000);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    assert!(client.get_claimable_balance(&depositor) >= 1_000_0000000 - 100);
}

#[test]
fn test_record_premium_income() {
    let (env, client, _owner, controller, depositor) = setup();

    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
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
    let (env, client, _owner, controller, depositor) = setup();
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    // No asset was transferred to the vault — credit must fail.
    client.record_premium_income(&controller, &50_0000000);
}

#[test]
fn test_send_payout() {
    let (env, client, _owner, controller, depositor) = setup();
    let asset = token::Client::new(&env, &client.query_asset());
    let recipient = Address::generate(&env);

    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

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

    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    // Lock all capital
    client.increase_locked(&controller, &1_000_0000000);

    // Request withdrawal (shares get escrowed)
    client.request_withdrawal(&depositor, &shares);
    assert_eq!(client.balance(&depositor), 0); // shares escrowed
    assert_eq!(client.get_withdrawal_queue().len(), 1);
    mature_requests(&env);

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
fn test_oversized_head_request_partial_fills_instead_of_pinning_queue() {
    // An unfundable head request must not freeze the exit path: free capital
    // is paid to the head as a partial fill, the remainder stays at the head,
    // and every later request keeps its FIFO place. Without this, one
    // oversized request blocked all queued exits while free capital sat idle.
    let (env, client, _owner, controller, depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    // A holds 1000, B holds 100; policies lock 1000, leaving 100 free.
    let other = Address::generate(&env);
    asset_admin.mint(&other, &100_0000000);
    let shares_a = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
    let shares_b = lp_deposit(&env, &client, &controller, &other, 100_0000000);
    client.increase_locked(&controller, &1_000_0000000);
    let free = client.get_free_capital();
    assert_eq!(free, 100_0000000);

    // A queues its full position (priced ~1000, unfundable from 100 free);
    // B queues a smaller request that free capital could cover.
    client.request_withdrawal(&depositor, &shares_a);
    client.request_withdrawal(&other, &(shares_b / 2));
    mature_requests(&env);

    client.process_withdrawal_queue(&controller);
    // (Asserted first: collect_events only surfaces the most recent
    // invocation's events.)
    assert_eq!(
        count_events_with_verb(&env, &client.address, Symbol::new(&env, "wd_partial")),
        1
    );

    // The head was filled up to free capital instead of pinning the queue:
    // A's credit consumes (all but rounding dust of) the free capital, the
    // head keeps A's remainder escrowed, and B stays behind it in FIFO order
    // with no credit — free capital never bypasses the oldest request.
    let credited_a = client.get_claimable_balance(&depositor);
    assert!(credited_a > 0 && credited_a <= free);
    assert!(free - credited_a < 100);
    let queue = client.get_withdrawal_queue();
    assert_eq!(queue.len(), 2);
    let head = queue.get(0).unwrap();
    assert_eq!(head.owner, depositor);
    assert!(head.shares < shares_a);
    assert_eq!(client.get_claimable_balance(&other), 0);
    assert_eq!(client.get_free_capital(), free - credited_a);

    // Settlement releases the collateral; the queue then drains fully in
    // FIFO order — the head remainder first, then B. The remainder kept its
    // original request time, so no fresh maturity wait applies.
    client.decrease_locked(&controller, &1_000_0000000);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    // Both LPs received their full position value (within rounding dust).
    assert!(client.get_claimable_balance(&depositor) >= 1_000_0000000 - 100);
    assert!(client.get_claimable_balance(&other) >= 50_0000000 - 100);
}

#[test]
fn test_solvency_reserve_bounds_withdrawable_capital() {
    // The controller admits policies while TMA covers locked * ratio; exits
    // must preserve that same reserve. With 1000 deposited, 400 locked, and a
    // 200% ratio, the required backing is 800 — only 200 may leave, not the
    // nominal 600 margin.
    let (env, client, _owner, controller, depositor) = setup();
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
    client.increase_locked(&controller, &400_0000000);

    // Until the controller pushes a ratio, the vault reserves nominal
    // backing only — withdrawable equals the free margin.
    assert_eq!(client.get_solvency_ratio(), 100);
    assert_eq!(client.get_withdrawable_capital(), 600_0000000);

    client.set_solvency_ratio(&controller, &200);
    assert_eq!(client.get_solvency_ratio(), 200);
    // The nominal margin is unchanged; the exit bound is not.
    assert_eq!(client.get_free_capital(), 600_0000000);
    assert_eq!(client.get_withdrawable_capital(), 200_0000000);
}

#[test]
fn test_queue_processing_holds_back_solvency_reserve() {
    // Queued exits are funded only from capital above the configured
    // reserve: the head partial-fills to that bound and the remainder waits
    // for collateral to unlock, exactly like the free-capital bound before.
    let (env, client, _owner, controller, depositor) = setup();
    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
    client.increase_locked(&controller, &400_0000000);
    client.set_solvency_ratio(&controller, &200);
    assert_eq!(client.get_withdrawable_capital(), 200_0000000);

    client.request_withdrawal(&depositor, &shares);
    mature_requests(&env);
    client.process_withdrawal_queue(&controller);

    // Only the withdrawable slice was credited (within rounding dust); the
    // remainder stays queued and TMA still covers 200% of locked.
    let credited = client.get_claimable_balance(&depositor);
    assert!(credited > 0 && credited <= 200_0000000);
    assert!(200_0000000 - credited < 100);
    assert_eq!(client.get_withdrawal_queue().len(), 1);
    assert!(client.get_total_managed_assets() >= 2 * client.get_locked_capital());

    // Re-processing without new capital cannot eat into the reserve.
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 1);
    assert!(client.get_total_managed_assets() >= 2 * client.get_locked_capital());

    // Settlement releases the collateral; the queue then drains fully.
    client.decrease_locked(&controller, &400_0000000);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_withdrawal_queue().len(), 0);
    assert!(client.get_claimable_balance(&depositor) >= 1_000_0000000 - 100);
}

#[test]
fn test_set_oracle_refuses_while_outcomes_pending() {
    // Rotating the barrier target while the current oracle still reports
    // public-but-unsettled outcomes would open the barrier at the stale
    // pre-settlement price (a fresh oracle starts with zero pending). The
    // checked rotation must refuse until the old oracle reads clear.
    let (env, client, _owner, _controller, _depositor) = setup();
    let old_oracle = client.get_oracle().unwrap();
    let mock = MockPendingOracleClient::new(&env, &old_oracle);
    mock.set_pending_outcomes(&true);

    let new_oracle = env.register(MockPendingOracle, ());
    assert!(client.try_set_oracle(&new_oracle).is_err());
    assert_eq!(client.get_oracle(), Some(old_oracle));

    // Once the pending PnL is settled, the routine rotation proceeds.
    mock.set_pending_outcomes(&false);
    client.set_oracle(&new_oracle);
    assert_eq!(client.get_oracle(), Some(new_oracle));
}

#[test]
fn test_force_set_oracle_requires_pause() {
    // The forced path exists for an unreachable old oracle, so it skips the
    // pending-outcomes check — but only while the vault is paused, keeping
    // every LP entry/exit blocked until the owner reconciles the old
    // oracle's pending PnL and deliberately unpauses.
    let (env, client, owner, _controller, _depositor) = setup();
    let old_oracle = client.get_oracle().unwrap();
    MockPendingOracleClient::new(&env, &old_oracle).set_pending_outcomes(&true);

    let new_oracle = env.register(MockPendingOracle, ());
    // Unpaused: forced rotation is rejected.
    assert!(client.try_force_set_oracle(&new_oracle).is_err());

    // Paused: the swap goes through even though the old oracle is pending.
    client.pause(&owner);
    client.force_set_oracle(&new_oracle);
    assert_eq!(client.get_oracle(), Some(new_oracle));
}

#[test]
#[should_panic(expected = "Error(Contract, #702)")]
fn test_set_solvency_ratio_rejects_non_controller() {
    let (env, client, _owner, _controller, _depositor) = setup();
    let intruder = Address::generate(&env);
    client.set_solvency_ratio(&intruder, &200);
}

#[test]
fn test_set_solvency_ratio_bounds() {
    // Same bounds as the controller's owner setter — a value the controller
    // could never hold is rejected here too.
    let (_env, client, _owner, controller, _depositor) = setup();
    assert!(client.try_set_solvency_ratio(&controller, &99).is_err());
    assert!(client.try_set_solvency_ratio(&controller, &10_001).is_err());
    client.set_solvency_ratio(&controller, &100);
    client.set_solvency_ratio(&controller, &10_000);
    assert_eq!(client.get_solvency_ratio(), 10_000);
}

#[test]
fn test_pause_and_unpause_gate_state_mutations() {
    // Regression: paused contract rejects entry/exit requests, queue
    // processing, and capital ops; unpausing restores normal flow.
    let (env, client, owner, controller, depositor) = setup();

    assert!(!client.paused());
    client.pause(&owner);
    assert!(client.paused());

    // Mutation paths reject while paused.
    assert!(client.try_request_deposit(&depositor, &1_0000000).is_err());
    assert!(client.try_request_withdrawal(&depositor, &1_000).is_err());
    assert!(client.try_process_deposit_queue(&controller).is_err());
    assert!(client.try_process_withdrawal_queue(&controller).is_err());
    assert!(client.try_increase_locked(&controller, &1).is_err());
    assert!(client.try_snapshot().is_err());

    // Recover_uncollected is intentionally NOT gated so the owner can
    // settle archived entries during a pause. The recredited amount must be
    // physically present beyond TMA — model the archived credit's asset
    // still sitting in the vault.
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&client.address, &1_0000000);
    client.recover_uncollected(&depositor, &1_0000000, &RecoveryMode::Recredit);

    client.unpause(&owner);
    assert!(!client.paused());

    // Mutation flow resumes.
    client.request_deposit(&depositor, &1_0000000);
}

#[test]
fn test_min_request_floor_enforced_on_both_queues() {
    // The owner-configured minimum makes each slot of the bounded queues cost
    // real escrowed value, so neither queue can be cheaply occupied by many
    // small requests. Enforcement is clamped to TMA/2500 at request time, so
    // the floor can never lock ordinary positions out.
    let (env, client, _owner, controller, depositor) = setup();
    // 10,000-asset vault → the clamp caps the effective floor at 4 assets.
    lp_deposit(&env, &client, &controller, &depositor, 10_000_0000000);
    // Fresh spending balance for the deposit-side floor checks below (the
    // full initial balance is now inside the vault).
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&depositor, &100_0000000);

    // Default: no floor — a small (non-dust) request is accepted.
    assert_eq!(client.get_min_withdrawal_request(), 0);
    let small_shares = client.convert_to_shares(&1_0000000);
    let id = client.request_withdrawal(&depositor, &small_shares);
    client.cancel_withdrawal(&depositor, &id);

    // Floor of 2 assets (below the clamp, so it binds): the same 1-asset
    // request is now rejected on both queues...
    client.set_min_withdrawal_request(&2_0000000);
    assert_eq!(client.get_min_withdrawal_request(), 2_0000000);
    assert!(client
        .try_request_withdrawal(&depositor, &small_shares)
        .is_err());
    assert!(client.try_request_deposit(&depositor, &1_0000000).is_err());

    // ...while requests clearly above the floor are accepted.
    let large_shares = client.convert_to_shares(&500_0000000);
    let id = client.request_withdrawal(&depositor, &large_shares);
    client.cancel_withdrawal(&depositor, &id);
    let id = client.request_deposit(&depositor, &5_0000000);
    client.cancel_deposit(&depositor, &id);

    // An absurd configured floor is clamped to TMA/2500 (= 4 assets here):
    // it cannot block a normal-sized request, only sub-clamp dust.
    client.set_min_withdrawal_request(&i128::MAX);
    let id = client.request_withdrawal(&depositor, &large_shares);
    client.cancel_withdrawal(&depositor, &id);
    assert!(client
        .try_request_withdrawal(&depositor, &small_shares)
        .is_err());

    // Setting the floor back to zero re-opens small requests; negative floors
    // are rejected.
    client.set_min_withdrawal_request(&0);
    let id = client.request_withdrawal(&depositor, &small_shares);
    client.cancel_withdrawal(&depositor, &id);
    assert!(client.try_set_min_withdrawal_request(&-1).is_err());
}

#[test]
#[should_panic]
fn test_set_min_withdrawal_request_unauthorized() {
    // The request-value floor is an owner-only lever (it gates queue
    // admission); a stranger must not be able to set it.
    let env = Env::default();
    // No mock_all_auths — the owner auth check must fail.
    let owner = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin);
    // Oracle never consulted on this path — any address satisfies the
    // constructor.
    let contract_id = env.register(
        RiskVault,
        (&owner, asset_id.address(), Address::generate(&env)),
    );
    let client = RiskVaultClient::new(&env, &contract_id);

    client.set_min_withdrawal_request(&1_0000000);
}

#[test]
fn test_queue_len_query_and_request_event() {
    use soroban_sdk::symbol_short;
    // Operators watch queue occupancy via the len query and the per-request
    // event (which carries post-push occupancy), so saturation of the bounded
    // queue is observable before the cap starts rejecting requests.
    let (env, client, _owner, controller, depositor) = setup();
    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    assert_eq!(client.get_withdrawal_queue_len(), 0);
    client.request_withdrawal(&depositor, &shares);
    assert!(count_events_with_verb(&env, &client.address, symbol_short!("wd_req")) >= 1);
    assert_eq!(client.get_withdrawal_queue_len(), 1);
}

#[test]
fn test_request_withdrawal_rejects_zero_preview() {
    // A dust request that previews to zero assets is rejected at
    // submission so it can never sit at the queue head and block the drain.
    let (env, client, _owner, controller, depositor) = setup();
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    // 1 share against a large pool rounds down to 0 assets on redeem preview.
    assert_eq!(client.preview_redeem(&1), 0);
    assert!(client.try_request_withdrawal(&depositor, &1).is_err());
    assert!(client.try_request_withdrawal(&depositor, &0).is_err());
    assert!(client.try_request_withdrawal(&depositor, &-5).is_err());
}

#[test]
fn test_matured_request_drains_after_capacity_returns() {
    // A matured, serviceable request drains the moment processing runs.
    let (env, client, _owner, controller, depositor) = setup();
    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    client.request_withdrawal(&depositor, &shares);
    mature_requests(&env);
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

    let a_shares = lp_deposit(&env, &client, &controller, &a, 500_0000000);
    let b_shares = lp_deposit(&env, &client, &controller, &b, 500_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // A exits via the queue: shares burned, ~500 credited as claimable, TMA
    // drops to ~500, but the 1000 tokens still sit physically in the vault.
    client.request_withdrawal(&a, &a_shares);
    mature_requests(&env);
    client.process_withdrawal_queue(&controller);
    let a_claimable = client.get_claimable_balance(&a);
    assert!(
        a_claimable >= 4_990_000_000,
        "A claimable too low: {}",
        a_claimable
    );
    assert_eq!(asset.balance(&client.address), 1_000_0000000); // tokens stayed

    // Victim enters 500 — priced on TMA (~500), NOT the raw balance (1000).
    let victim_shares = lp_deposit(&env, &client, &controller, &victim, 500_0000000);

    // B cashes out everything via the queue. It must NOT be able to seize
    // ~1000 (the victim's money on top of its own); its fair value is ~500.
    client.request_withdrawal(&b, &b_shares);
    mature_requests(&env);
    client.process_withdrawal_queue(&controller);
    let b_got = client.get_claimable_balance(&b);
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

    let whale_shares = lp_deposit(&env, &client, &controller, &whale, 1_000_0000000);
    let dust_shares = lp_deposit(&env, &client, &controller, &dust, 1_0000);

    // dust queues first (would be the pinning head), whale second.
    client.request_withdrawal(&dust, &dust_shares);
    client.request_withdrawal(&whale, &whale_shares);
    assert_eq!(client.get_withdrawal_queue().len(), 2);

    // A large payout crashes TMA so dust's queued request now previews to zero.
    client.send_payout(&controller, &sink, &1_000_0000000);
    assert_eq!(client.preview_redeem(&dust_shares), 0);

    mature_requests(&env);
    client.process_withdrawal_queue(&controller);

    // The drop is announced (checked before any further contract call —
    // collect_events only surfaces the most recent invocation's events).
    assert!(count_events_with_verb(&env, &client.address, Symbol::new(&env, "wd_dropped")) >= 1);

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
    let (env, client, _owner, controller, _depositor) = setup();
    let lp = Address::generate(&env);
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&lp, &1_000_0000000);
    let shares = lp_deposit(&env, &client, &controller, &lp, 1_000_0000000);

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
    let (env, client, _owner, controller, _depositor) = setup();
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());

    // Fill the queue to MAX_WITHDRAWAL_QUEUE_LEN (150) using enough distinct
    // addresses to respect the per-address cap (20 each → 8 addresses).
    let mut filled = 0u32;
    'fill: for _ in 0..8 {
        let lp = Address::generate(&env);
        asset_admin.mint(&lp, &1_000_0000000);
        let shares = lp_deposit(&env, &client, &controller, &lp, 1_000_0000000);
        let slice = shares / 100;
        for _ in 0..20 {
            client.request_withdrawal(&lp, &slice);
            filled += 1;
            if filled == 150 {
                break 'fill;
            }
        }
    }
    assert_eq!(client.get_withdrawal_queue().len(), 150);

    // A 151st request (fresh address, under its own cap) is rejected.
    let extra = Address::generate(&env);
    asset_admin.mint(&extra, &1_000_0000000);
    let extra_shares = lp_deposit(&env, &client, &controller, &extra, 1_000_0000000);
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
    // Oracle never consulted on this path — any address satisfies the
    // constructor.
    let contract_id = env.register(
        RiskVault,
        (&owner, asset_id.address(), Address::generate(&env)),
    );
    let client = RiskVaultClient::new(&env, &contract_id);

    let stranger = Address::generate(&env);
    client.pause(&stranger);
}

#[test]
fn test_cancel_withdrawal() {
    let (env, client, _owner, controller, depositor) = setup();

    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
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

    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
    let other_shares = lp_deposit(&env, &client, &controller, &other, 500_0000000);
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
fn test_cancel_withdrawal_emits_event() {
    use soroban_sdk::symbol_short;
    let (env, client, _owner, controller, depositor) = setup();
    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
    let id = client.request_withdrawal(&depositor, &shares);
    client.cancel_withdrawal(&depositor, &id);
    assert!(count_events_with_verb(&env, &client.address, symbol_short!("wd_cancel")) >= 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #721)")]
fn test_cancel_withdrawal_with_unknown_request_id_panics() {
    let (_env, client, _owner, _controller, depositor) = setup();
    client.cancel_withdrawal(&depositor, &9999u64);
}

#[test]
fn test_snapshot() {
    let (env, client, _owner, controller, depositor) = setup();

    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

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

    let a_shares = lp_deposit(&env, &client, &controller, &a, 1_000_0000000);
    lp_deposit(&env, &client, &controller, &b, 1_000_0000000);

    // A exits via the queue → shares burned, claimable credited, TMA reduced,
    // but A's tokens physically remain in the vault (uncollected).
    client.request_withdrawal(&a, &a_shares);
    mature_requests(&env);
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
    let (env, client, _owner, controller, depositor) = setup();

    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

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
fn test_snapshot_records_each_calendar_day() {
    // The once-per-day gate is aligned to calendar days (the same day number
    // used as the storage key), not a rolling 24-hour window — a snapshot
    // taken late in day N must not suppress day N+1's snapshot.
    let (env, client, _owner, controller, depositor) = setup();

    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    // Late in day 1 (23:00).
    env.ledger().with_mut(|li| {
        li.timestamp = 2 * SECONDS_PER_DAY - 3_600;
    });
    client.snapshot();
    assert!(client.get_snapshot_price(&1) > 0);

    // Early in day 2 (01:00) — only two hours later, but a new calendar day.
    env.ledger().with_mut(|li| {
        li.timestamp = 2 * SECONDS_PER_DAY + 3_600;
    });
    client.snapshot();
    assert!(
        client.get_snapshot_price(&2) > 0,
        "day 2 must get a snapshot"
    );

    // Repeat within day 2 stays a no-op (idempotent).
    env.ledger().with_mut(|li| {
        li.timestamp = 2 * SECONDS_PER_DAY + 7_200;
    });
    client.snapshot();
}

#[test]
fn test_tma_tracking_through_operations() {
    let (env, client, _owner, controller, depositor) = setup();
    let asset_client = token::StellarAssetClient::new(&env, &client.query_asset());

    // Enter 1000
    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_000_0000000);

    // Record premium income +50 (simulate asset arriving from FlightPool)
    asset_client.mint(&client.address, &50_0000000);
    client.record_premium_income(&controller, &50_0000000);
    assert_eq!(client.get_total_managed_assets(), 1_050_0000000);

    // Send payout -200
    client.send_payout(&controller, &Address::generate(&env), &200_0000000);
    assert_eq!(client.get_total_managed_assets(), 850_0000000);

    // Full queued exit drains the remaining 850 into the claimable balance.
    client.request_withdrawal(&depositor, &shares);
    mature_requests(&env);
    client.process_withdrawal_queue(&controller);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(client.get_claimable_balance(&depositor), 850_0000000);
}

#[test]
fn test_multiple_depositors() {
    let (env, client, _owner, controller, depositor) = setup();
    let asset_client = token::StellarAssetClient::new(&env, &client.query_asset());

    let depositor2 = Address::generate(&env);
    asset_client.mint(&depositor2, &5_000_0000000);

    // First depositor: 1000 asset
    let shares1 = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    // Second depositor: 500 asset
    let shares2 = lp_deposit(&env, &client, &controller, &depositor2, 500_0000000);

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

// Drive the standard "enter, lock all, request withdrawal, unlock, process"
// flow used across the tests below.
fn run_credit_flow(
    env: &Env,
    client: &RiskVaultClient<'static>,
    controller: &Address,
    depositor: &Address,
) {
    let shares = lp_deposit(env, client, controller, depositor, 1_000_0000000);
    client.increase_locked(controller, &1_000_0000000);
    client.request_withdrawal(depositor, &shares);
    mature_requests(env);
    client.decrease_locked(controller, &1_000_0000000);
    client.process_withdrawal_queue(controller);
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
fn test_deposit_processed_event_fires() {
    let (env, client, _owner, controller, depositor) = setup();

    client.request_deposit(&depositor, &1_000_0000000);
    mature_requests(&env);
    client.process_deposit_queue(&controller);

    assert!(count_events_with_verb(&env, &client.address, Symbol::new(&env, "dep_minted")) >= 1);
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

    // The recredited amount must be covered by asset the vault holds beyond
    // TMA — model the archived credit's asset still sitting in the vault.
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&client.address, &500_0000000);
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
    // The increase over the existing entry must itself be backed by asset
    // beyond TMA — mint the delta into the vault first.
    let asset_admin = token::StellarAssetClient::new(&env, &client.query_asset());
    asset_admin.mint(&client.address, &100_0000000);
    client.recover_uncollected(&depositor, &bumped, &RecoveryMode::Recredit);
    assert_eq!(client.get_claimable_balance(&depositor), bumped);
}

#[test]
#[should_panic(expected = "Error(Contract, #723)")]
fn test_recover_uncollected_recredit_exceeding_surplus_panics() {
    // A recredit whose delta exceeds the vault's asset surplus over TMA
    // could only ever be collected by consuming asset that backs outstanding
    // shares. A mis-keyed amount must be rejected up front, not surface
    // later as another party's failed transfer.
    let (env, client, _owner, controller, depositor) = setup();
    run_credit_flow(&env, &client, &controller, &depositor);

    let prior = client.get_claimable_balance(&depositor);
    assert!(prior > 0);
    // No extra asset minted: the surplus covers exactly the existing credit,
    // so any increase must refuse.
    client.recover_uncollected(&depositor, &(prior + 1), &RecoveryMode::Recredit);
}

#[test]
#[should_panic(expected = "Error(Contract, #723)")]
fn test_recover_uncollected_recredit_cannot_consume_deposit_escrow() {
    // Escrowed deposit-queue assets sit in the raw balance without backing
    // shares, but they are owed back to their requesters — a recredit must
    // not be satisfiable out of that escrow.
    let (env, client, _owner, _controller, depositor) = setup();
    let user = Address::generate(&env);

    // The only surplus over TMA is the pending entrant's escrow.
    client.request_deposit(&depositor, &500_0000000);
    assert_eq!(client.get_total_managed_assets(), 0);

    client.recover_uncollected(&user, &1_0000000, &RecoveryMode::Recredit);
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
    // Oracle never consulted on this path — any address satisfies the
    // constructor.
    let contract_id = env.register(
        RiskVault,
        (&owner, asset_id.address(), Address::generate(&env)),
    );
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
    let (env, client, _owner, controller, depositor) = setup();
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    env.ledger().with_mut(|li| li.timestamp = 100_000);
    client.snapshot();

    let day = 100_000u64 / SECONDS_PER_DAY_TEST;
    let price = client.get_snapshot_price(&day);
    assert!(price > 0, "snapshot should be queryable immediately");
}

#[test]
fn test_snapshot_expires_after_30_days() {
    let (env, client, _owner, controller, depositor) = setup();
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

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
    let (env, client, _owner, controller, depositor) = setup();
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    env.ledger().with_mut(|li| li.timestamp = 200_000);
    client.snapshot();

    assert!(
        count_events_with_verb(&env, &client.address, symbol_short!("snapshot")) >= 1,
        "expected sentinel.snapshot event"
    );
}

// =========================================================================
// Conversion views (informational quotes for request sizing)
// =========================================================================

#[test]
fn test_conversion_views_before_and_after_entry() {
    let (env, client, _owner, controller, depositor) = setup();

    // Empty vault — initial price is 1:1 modulo decimals_offset.
    assert_eq!(client.convert_to_shares(&1_000_0000000), 1_000_0000000_000);
    assert_eq!(client.convert_to_assets(&1_000_0000000_000), 1_000_0000000);
    assert_eq!(client.preview_deposit(&1_000_0000000), 1_000_0000000_000);
    assert_eq!(client.preview_mint(&1_000_0000000_000), 1_000_0000000);
    assert_eq!(client.preview_withdraw(&500_0000000), 500_0000000_000);
    assert_eq!(client.preview_redeem(&500_0000000_000), 500_0000000);

    // After an entry, the quotes track the managed-asset price.
    let shares = lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);
    assert_eq!(client.convert_to_assets(&shares), 1_000_0000000);
}

// =========================================================================
// extend_ttl (cron safety net)
// =========================================================================

#[test]
fn test_extend_ttl_is_callable() {
    let (_env, client, _owner, _controller, _depositor) = setup();
    client.extend_ttl();
}

// =========================================================================
// Settlement-barrier wiring (constructor-supplied oracle)
// =========================================================================

#[test]
fn test_constructor_wires_settlement_barrier() {
    // The oracle is a constructor argument, so the barrier is active from
    // genesis — no post-deploy set_oracle step exists to forget. Verify the
    // wiring is observable and that the barrier holds queue processing while
    // the oracle reports a pending outcome. Requests themselves stay open —
    // they are commitments, not priced operations.
    let (env, client, _owner, controller, depositor) = setup();
    let oracle_addr = client.get_oracle().expect("constructor must wire oracle");
    let oracle = MockPendingOracleClient::new(&env, &oracle_addr);

    // Barrier open (mock defaults to no pending outcomes): entry processes.
    lp_deposit(&env, &client, &controller, &depositor, 1_000_0000000);

    // An outcome is written → processing refuses to price either queue.
    oracle.set_pending_outcomes(&true);
    client.request_deposit(&depositor, &1_0000000);
    mature_requests(&env);
    client.process_deposit_queue(&controller);
    assert_eq!(client.get_deposit_queue_len(), 1);

    // Settlement completes → the queued entry prices on the next pass.
    oracle.set_pending_outcomes(&false);
    client.process_deposit_queue(&controller);
    assert_eq!(client.get_deposit_queue_len(), 0);
}

#[test]
fn test_owner_setter_events_emitted() {
    // set_oracle and set_min_withdrawal_request are security-relevant owner
    // levers (barrier target, queue admission floor); both must leave an
    // on-chain audit trail like every other owner setter in the system.
    let (env, client, _owner, _controller, _depositor) = setup();

    let new_oracle = env.register(MockPendingOracle, ());
    client.set_oracle(&new_oracle);
    assert!(count_events_with_verb(&env, &client.address, Symbol::new(&env, "oracle_set")) >= 1);
    assert_eq!(client.get_oracle(), Some(new_oracle));

    client.set_min_withdrawal_request(&5_0000000);
    assert!(
        count_events_with_verb(&env, &client.address, Symbol::new(&env, "min_wd_req_set")) >= 1
    );
    assert_eq!(client.get_min_withdrawal_request(), 5_0000000);
}
