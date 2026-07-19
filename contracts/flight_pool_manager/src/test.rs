use super::*;
use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger, token, Address, Env, Symbol,
};

const PREMIUM: i128 = 10_0000000; // 10 asset (7 decimals)
const PAYOFF: i128 = 50_0000000; // 50 asset
const DELAY_HOURS: u32 = 3;
const FLIGHT_DATE: u64 = 1_710_500_000;
const INITIAL_TIMESTAMP: u64 = 1_710_400_000;
const CLAIM_WINDOW_SEC: u64 = 5_184_000; // 60 days
const VAULT_LIQUIDITY: i128 = 10_000_0000000; // 10,000 asset seeded into vault

#[allow(dead_code)]
struct TestEnv {
    env: Env,
    pool: FlightPoolManagerClient<'static>,
    pool_addr: Address,
    vault: risk_vault::RiskVaultClient<'static>,
    vault_addr: Address,
    asset: token::Client<'static>,
    asset_addr: Address,
    owner: Address,
    controller: Address,
    buyer1: Address,
    buyer2: Address,
}

#[test]
fn version_initialized_to_one() {
    let t = setup();
    assert_eq!(t.pool.version(), 1);
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let controller = Address::generate(&env);
    let buyer1 = Address::generate(&env);
    let buyer2 = Address::generate(&env);

    // Mock asset via Stellar Asset Contract
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset_addr = asset_id.address();
    let asset = token::Client::new(&env, &asset_addr);
    let asset_admin_client = token::StellarAssetClient::new(&env, &asset_addr);

    // RiskVault — needs OZ FungibleVault wired around asset, plus an oracle
    // for the constructor-wired settlement barrier (the mock reports no
    // pending outcomes, keeping the barrier open for the deposit below).
    let mock_oracle = env.register(sentinel_types::test_support::MockPendingOracle, ());
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &asset_addr, &mock_oracle));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    // FlightPoolManager
    let pool_addr = env.register(FlightPoolManager, (&owner, &asset_addr, &vault_addr));
    let pool = FlightPoolManagerClient::new(&env, &pool_addr);

    // Wire controller (one-time write) — both vault and pool
    vault.set_controller(&controller);
    pool.set_controller(&controller);

    // Seed vault with asset liquidity via the two-phase entry (request,
    // mature past the pricing delay, process as the controller).
    let underwriter = Address::generate(&env);
    asset_admin_client.mint(&underwriter, &VAULT_LIQUIDITY);
    vault.request_deposit(&underwriter, &VAULT_LIQUIDITY);
    env.ledger().with_mut(|l| l.timestamp += 6 * 3_600);
    vault.process_deposit_queue(&controller);

    // Pre-fund buyers with enough asset to pay premiums; they'll transfer to pool in tests
    asset_admin_client.mint(&buyer1, &(PREMIUM * 10));
    asset_admin_client.mint(&buyer2, &(PREMIUM * 10));

    TestEnv {
        env,
        pool,
        pool_addr,
        vault,
        vault_addr,
        asset,
        asset_addr,
        owner,
        controller,
        buyer1,
        buyer2,
    }
}

fn flight_a() -> Symbol {
    symbol_short!("AA100")
}

// Helper: simulate a buyer purchase — transfer premium to pool then add_buyer
fn buy(t: &TestEnv, buyer: &Address) {
    t.asset.transfer(buyer, &t.pool_addr, &PREMIUM);
    t.pool
        .add_buyer(&t.controller, &flight_a(), &FLIGHT_DATE, buyer);
}

// Helper: register flight with default terms
fn register(t: &TestEnv) {
    t.pool.register_flight(
        &t.controller,
        &flight_a(),
        &FLIGHT_DATE,
        &PREMIUM,
        &PAYOFF,
        &DELAY_HOURS,
    );
}

// Helper: advance ledger time by `seconds`
fn advance(t: &TestEnv, seconds: u64) {
    let now = t.env.ledger().timestamp();
    t.env.ledger().with_mut(|l| l.timestamp = now + seconds);
}

// =========================================================================
// Initialization & set_controller
// =========================================================================

#[test]
fn test_constructor_sets_owner_and_addresses() {
    let t = setup();
    assert_eq!(t.pool.get_owner(), Some(t.owner.clone()));
    assert_eq!(t.pool.get_asset_token(), t.asset_addr);
    assert_eq!(t.pool.get_risk_vault(), t.vault_addr);
    assert_eq!(t.pool.get_controller(), Some(t.controller.clone()));
    assert_eq!(t.pool.get_recovered_balance(), 0);
    assert_eq!(t.pool.get_active_flights().len(), 0);
}

#[test]
fn test_unpause_restores_registration() {
    let t = setup();
    t.pool.pause(&t.owner);
    assert!(t.pool.paused());
    assert!(t
        .pool
        .try_register_flight(
            &t.controller,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &PREMIUM,
            &PAYOFF,
            &DELAY_HOURS,
        )
        .is_err());

    t.pool.unpause(&t.owner);
    assert!(!t.pool.paused());
    t.pool.register_flight(
        &t.controller,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &PREMIUM,
        &PAYOFF,
        &DELAY_HOURS,
    );
    assert!(t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .is_some());
}

#[test]
#[should_panic(expected = "Error(Contract, #402)")]
fn test_set_controller_twice_fails() {
    let t = setup();
    let other = Address::generate(&t.env);
    t.pool.set_controller(&other);
}

#[test]
#[should_panic]
fn test_set_controller_no_auth_fails() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin);
    // Oracle never consulted on this path — any address satisfies the
    // vault constructor.
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &asset_id.address(), &Address::generate(&env)),
    );
    let pool_addr = env.register(
        FlightPoolManager,
        (&owner, &asset_id.address(), &vault_addr),
    );
    let pool = FlightPoolManagerClient::new(&env, &pool_addr);
    let controller = Address::generate(&env);
    // No mock_all_auths — should fail
    pool.set_controller(&controller);
}

// =========================================================================
// register_flight
// =========================================================================

#[test]
fn test_register_flight_success() {
    let t = setup();
    register(&t);
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.premium, PREMIUM);
    assert_eq!(cfg.payoff, PAYOFF);
    assert_eq!(cfg.delay_hours, DELAY_HOURS);
    assert_eq!(cfg.buyer_count, 0);
    assert_eq!(cfg.claimed_count, 0);
    assert_eq!(cfg.status, SettlementStatus::Active);
    assert_eq!(cfg.claim_expiry, 0);
    let active = t.pool.get_active_flights();
    assert_eq!(active.len(), 1);
    assert_eq!(active.get(0), Some((flight_a(), FLIGHT_DATE)));
}

#[test]
#[should_panic(expected = "Error(Contract, #417)")]
fn test_register_flight_rejects_when_active_list_full() {
    // The paginated active set carries an operational sanity cap. The cap
    // gate reads the O(1) stored count, so seed that directly to the cap and
    // confirm one more distinct registration is rejected.
    use crate::constants::MAX_ACTIVE_FLIGHTS;
    use sentinel_types::active_set::ActiveSetKey;
    let t = setup();

    t.env.as_contract(&t.pool_addr, || {
        t.env
            .storage()
            .instance()
            .set(&ActiveSetKey::ActiveCount, &MAX_ACTIVE_FLIGHTS);
    });

    t.pool.register_flight(
        &t.controller,
        &symbol_short!("ZZ999"),
        &99_999_999u64,
        &PREMIUM,
        &PAYOFF,
        &DELAY_HOURS,
    );
}

#[test]
fn test_active_set_spans_pages_and_swap_removes_across_them() {
    // More buckets than one page holds (page size 100): registration must
    // spill onto a second page, enumeration must cover both, and settlement
    // of an early entry must swap-move the globally last entry (page 1) into
    // the freed slot (page 0) without losing anything.
    let t = setup();
    for i in 0..101u64 {
        t.pool.register_flight(
            &t.controller,
            &flight_a(),
            &(FLIGHT_DATE + i),
            &PREMIUM,
            &PAYOFF,
            &DELAY_HOURS,
        );
    }
    assert_eq!(t.pool.get_active_flight_count(), 101);
    assert_eq!(t.pool.get_active_flights().len(), 101);
    // A window crossing the page boundary reads both pages.
    let win = t.pool.get_active_flights_page(&98u32, &3u32);
    assert_eq!(win.len(), 3);

    // Settle the bucket sitting in page 0, slot 3.
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &(FLIGHT_DATE + 3));

    let all = t.pool.get_active_flights();
    assert_eq!(all.len(), 100);
    let mut found_settled = false;
    let mut found_old_tail = false;
    for i in 0..all.len() {
        let (_, date) = all.get(i).unwrap();
        if date == FLIGHT_DATE + 3 {
            found_settled = true;
        }
        if date == FLIGHT_DATE + 100 {
            found_old_tail = true;
        }
    }
    assert!(!found_settled, "settled bucket must leave the set");
    assert!(found_old_tail, "swap-moved tail entry must stay enumerable");
}

#[test]
fn test_prune_missed_emits_diagnostic_and_settlement_still_completes() {
    // If the active-set page holding a bucket has archived at the moment
    // settlement tries to prune it, the swap-remove no-ops. Settlement must
    // still complete (the flight settles), and the no-op must surface a
    // `prune_missed` diagnostic rather than pass silently — the pool never
    // retries the prune, so operators need the signal to reconcile the drift.
    use sentinel_types::active_set::ActiveSetKey;
    let t = setup();
    register(&t);
    assert_eq!(t.pool.get_active_flight_count(), 1);

    // Simulate the page-0 ledger entry archiving past its TTL while the
    // reverse index and count survive.
    t.env.as_contract(&t.pool_addr, || {
        t.env
            .storage()
            .persistent()
            .remove(&ActiveSetKey::ActivePage(0));
    });

    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);

    // Collect events IMMEDIATELY after settlement, before any other contract
    // call replaces the event buffer: the no-op prune surfaced a diagnostic.
    let prune_missed = Symbol::new(&t.env, "prune_missed");
    let mut saw_diag = false;
    for (addr, topics, _data) in collect_events(&t.env).iter() {
        if addr != t.pool_addr || topics.len() < 2 {
            continue;
        }
        use soroban_sdk::TryFromVal;
        if let Ok(verb) = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()) {
            if verb == prune_missed {
                saw_diag = true;
            }
        }
    }
    assert!(saw_diag, "expected a prune_missed diagnostic event");

    // Settlement completed despite the failed prune.
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.status, SettlementStatus::SettledOnTime);
    // The count did not decrement — the residual drift the diagnostic flags.
    assert_eq!(t.pool.get_active_flight_count(), 1);
}

#[test]
fn test_register_flight_duplicate_is_idempotent() {
    // Re-registering with matching terms is a no-op so two travelers
    // racing to the first purchase don't both have their txs revert.
    let t = setup();
    register(&t);
    register(&t);
    // Flight is still registered, only one entry in the active list.
    let active = t.pool.get_active_flights();
    assert_eq!(active.len(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #410)")]
fn test_register_flight_duplicate_with_diff_terms_panics() {
    let t = setup();
    register(&t);
    // Second call with the same id+date but a different payoff.
    t.pool.register_flight(
        &t.controller,
        &flight_a(),
        &FLIGHT_DATE,
        &PREMIUM,
        &(PAYOFF + 1),
        &DELAY_HOURS,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #401)")]
fn test_register_flight_non_controller_fails() {
    let t = setup();
    let attacker = Address::generate(&t.env);
    t.pool.register_flight(
        &attacker,
        &flight_a(),
        &FLIGHT_DATE,
        &PREMIUM,
        &PAYOFF,
        &DELAY_HOURS,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #407)")]
fn test_register_flight_zero_premium_fails() {
    let t = setup();
    t.pool.register_flight(
        &t.controller,
        &flight_a(),
        &FLIGHT_DATE,
        &0,
        &PAYOFF,
        &DELAY_HOURS,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #419)")]
fn test_register_flight_zero_delay_hours_fails() {
    // Defense in depth, same tier as the payoff/premium checks: a zero delay
    // threshold would classify every landed flight as delayed (guaranteed
    // payout), so registration must reject it even though governance already
    // validates its own write paths.
    let t = setup();
    t.pool.register_flight(
        &t.controller,
        &flight_a(),
        &FLIGHT_DATE,
        &PREMIUM,
        &PAYOFF,
        &0u32,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #409)")]
fn test_register_flight_payoff_not_above_premium_fails() {
    // Defense in depth — a route that resolves (against mutable
    // governance defaults) to payoff <= premium must be rejected at registration
    // so settlement's `payoff - premium` can never underflow and brick the flight.
    let t = setup();
    t.pool.register_flight(
        &t.controller,
        &flight_a(),
        &FLIGHT_DATE,
        &PAYOFF, // premium == payoff → not strictly greater
        &PAYOFF,
        &DELAY_HOURS,
    );
}

#[test]
fn test_config_survives_until_far_future_flight() {
    // A flight booked far ahead must keep its config alive
    // until settlement (extended to the flight date + buffer), not just the flat
    // ~31-day default. Advancing the ledger sequence well past the old TTL must
    // leave the config readable.
    let t = setup();
    let far_date = INITIAL_TIMESTAMP + 80 * 86_400; // 80 days out
    t.pool.register_flight(
        &t.controller,
        &flight_a(),
        &far_date,
        &PREMIUM,
        &PAYOFF,
        &DELAY_HOURS,
    );
    // Past the old flat ~31-day TTL (535_680 ledgers), within the extended life.
    t.env.ledger().with_mut(|l| l.sequence_number = 600_000);
    assert!(t.pool.get_flight_config(&flight_a(), &far_date).is_some());
}

#[test]
fn test_config_survives_claim_window_after_quick_settle() {
    // Settling shortly after purchase must still extend the
    // config TTL across the full claim window. The extension previously no-op'd
    // (7-day threshold vs ~31-day live TTL), archiving the config mid-window.
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    // Vault top-up arrives before the claim window opens (production order).
    let topup = PAYOFF - PREMIUM;
    t.vault.send_payout(&t.controller, &t.pool_addr, &topup);
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);

    // Advance the ledger sequence past the old ~31-day TTL but inside the
    // 60-day claim window (timestamp unchanged, so the window is still open).
    t.env.ledger().with_mut(|l| l.sequence_number = 600_000);

    let before = t.asset.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&t.buyer1), before + PAYOFF);
}

// =========================================================================
// add_buyer
// =========================================================================

#[test]
fn test_add_buyer_single() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.buyer_count, 1);
    assert!(t.pool.has_policy(&flight_a(), &FLIGHT_DATE, &t.buyer1));
    assert!(!t.pool.has_policy(&flight_a(), &FLIGHT_DATE, &t.buyer2));
    assert_eq!(t.asset.balance(&t.pool_addr), PREMIUM);
}

#[test]
fn test_add_buyer_multiple() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    buy(&t, &t.buyer2);
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.buyer_count, 2);
    assert!(t.pool.has_policy(&flight_a(), &FLIGHT_DATE, &t.buyer1));
    assert!(t.pool.has_policy(&flight_a(), &FLIGHT_DATE, &t.buyer2));
    assert_eq!(t.asset.balance(&t.pool_addr), PREMIUM * 2);
}

#[test]
#[should_panic(expected = "flight not registered")]
fn test_add_buyer_before_register_fails() {
    let t = setup();
    t.pool
        .add_buyer(&t.controller, &flight_a(), &FLIGHT_DATE, &t.buyer1);
}

#[test]
#[should_panic(expected = "Error(Contract, #411)")]
fn test_add_buyer_duplicate_same_address_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool
        .add_buyer(&t.controller, &flight_a(), &FLIGHT_DATE, &t.buyer1);
}

#[test]
#[should_panic(expected = "Error(Contract, #401)")]
fn test_add_buyer_non_controller_fails() {
    let t = setup();
    register(&t);
    let attacker = Address::generate(&t.env);
    t.pool
        .add_buyer(&attacker, &flight_a(), &FLIGHT_DATE, &t.buyer1);
}

#[test]
#[should_panic(expected = "Error(Contract, #405)")]
fn test_add_buyer_after_settlement_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    buy(&t, &t.buyer2);
}

// =========================================================================
// settle_on_time
// =========================================================================

#[test]
fn test_settle_on_time_with_buyers_transfers_premium_to_vault() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    buy(&t, &t.buyer2);

    let pool_balance_before = t.asset.balance(&t.pool_addr);
    assert_eq!(pool_balance_before, PREMIUM * 2);
    let vault_tma_before = t.vault.get_total_managed_assets();
    let vault_balance_before = t.asset.balance(&t.vault_addr);

    let recorded = t
        .pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);

    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.status, SettlementStatus::SettledOnTime);
    assert_eq!(t.pool.get_active_flights().len(), 0);

    // Premiums physically move from pool to vault.
    assert_eq!(t.asset.balance(&t.pool_addr), 0);
    assert_eq!(
        t.asset.balance(&t.vault_addr),
        vault_balance_before + PREMIUM * 2
    );

    // settle_on_time returns the transferred total for the Controller to credit
    // as income; it does NOT itself update vault TMA — recording premium income
    // is the Controller's call (it must be the authorizing caller of the vault).
    assert_eq!(recorded, PREMIUM * 2);
    assert_eq!(t.vault.get_total_managed_assets(), vault_tma_before);
}

#[test]
fn test_settle_on_time_zero_buyers_no_transfer() {
    let t = setup();
    register(&t);
    let vault_tma_before = t.vault.get_total_managed_assets();
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.status, SettlementStatus::SettledOnTime);
    assert_eq!(t.pool.get_active_flights().len(), 0);
    assert_eq!(t.vault.get_total_managed_assets(), vault_tma_before);
}

#[test]
#[should_panic(expected = "Error(Contract, #405)")]
fn test_settle_on_time_twice_fails() {
    let t = setup();
    register(&t);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #401)")]
fn test_settle_on_time_non_controller_fails() {
    let t = setup();
    register(&t);
    let attacker = Address::generate(&t.env);
    t.pool.settle_on_time(&attacker, &flight_a(), &FLIGHT_DATE);
}

// =========================================================================
// settle_delayed / settle_cancelled
// =========================================================================

#[test]
fn test_settle_delayed_success() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    // Vault top-up arrives before the claim window opens (production order).
    t.vault
        .send_payout(&t.controller, &t.pool_addr, &(PAYOFF - PREMIUM));
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.status, SettlementStatus::SettledDelayed);
    assert_eq!(cfg.claim_expiry, claim_expiry);
    assert_eq!(t.pool.get_active_flights().len(), 0);
}

#[test]
fn test_settle_cancelled_success() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    // Vault top-up arrives before the claim window opens (production order).
    t.vault
        .send_payout(&t.controller, &t.pool_addr, &(PAYOFF - PREMIUM));
    t.pool
        .settle_cancelled(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.status, SettlementStatus::SettledCancelled);
    assert_eq!(cfg.claim_expiry, claim_expiry);
}

#[test]
#[should_panic(expected = "Error(Contract, #405)")]
fn test_settle_delayed_twice_fails() {
    let t = setup();
    register(&t);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
}

#[test]
#[should_panic(expected = "Error(Contract, #401)")]
fn test_settle_delayed_non_controller_fails() {
    let t = setup();
    register(&t);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    let attacker = Address::generate(&t.env);
    t.pool
        .settle_delayed(&attacker, &flight_a(), &FLIGHT_DATE, &claim_expiry);
}

#[test]
#[should_panic(expected = "Error(Contract, #418)")]
fn test_settle_delayed_without_vault_topup_fails() {
    // The vault's payout top-up must arrive BEFORE the claim window opens.
    // With one buyer the pool holds only the premium here — opening the
    // window would advertise payoffs the contract cannot fund.
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
}

#[test]
#[should_panic(expected = "Error(Contract, #406)")]
fn test_settle_delayed_past_expiry_fails() {
    let t = setup();
    register(&t);
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &0);
}

#[test]
fn test_claim_deadline_capped_to_buyer_proof_lifetime() {
    // Buyer proofs are written at purchase with a fixed 180-day lifetime and
    // cannot be renewed at settlement; the earliest purchase is 90 days
    // before departure, so a claim deadline past date + 90 days could outlive
    // the entitlement records it serves. A heavily delayed settlement must
    // therefore open a window capped at that horizon rather than a full
    // claim-expiry span whose tail nobody could prove a policy against.
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);

    // Settlement runs only 100 days after the flight date.
    let late = FLIGHT_DATE + 100 * 86_400;
    t.env.ledger().with_mut(|l| l.timestamp = late);
    let requested_expiry = late + CLAIM_WINDOW_SEC;
    // Vault top-up arrives before the claim window opens (production order).
    t.vault
        .send_payout(&t.controller, &t.pool_addr, &(PAYOFF - PREMIUM));
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &requested_expiry);

    // The stored deadline is the cap — already in the past here, so the
    // window is born expired: claims fail closed instead of a subset of
    // buyers hitting NoPolicy on archived proofs, and the funds are
    // sweepable to the recovered balance for owner-driven remediation.
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.claim_expiry, FLIGHT_DATE + 90 * 86_400);
    assert!(t
        .pool
        .try_claim(&t.buyer1, &flight_a(), &FLIGHT_DATE)
        .is_err());
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
    assert_eq!(t.pool.get_recovered_balance(), PAYOFF);
}

#[test]
fn test_truncated_claim_window_still_claimable() {
    // Middle ground of the deadline cap: settlement late enough that the
    // requested window is truncated, but with time left before the cap. The
    // buyer must still be able to claim within the shortened window — the
    // cap trades window length for the guarantee that every remaining second
    // is provable against a live buyer key.
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);

    // Settle 40 days after departure: requested deadline = +100d, cap = +90d.
    let late = FLIGHT_DATE + 40 * 86_400;
    t.env.ledger().with_mut(|l| l.timestamp = late);
    let requested_expiry = late + CLAIM_WINDOW_SEC;
    // Vault top-up arrives before the claim window opens (production order).
    t.vault
        .send_payout(&t.controller, &t.pool_addr, &(PAYOFF - PREMIUM));
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &requested_expiry);

    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.claim_expiry, FLIGHT_DATE + 90 * 86_400);
    assert!(cfg.claim_expiry > t.env.ledger().timestamp());

    // Claim succeeds inside the truncated window.
    let before = t.asset.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&t.buyer1), before + PAYOFF);
}

#[test]
fn test_active_flight_count_tracks_registration_and_settlement() {
    // Operators watch active-bucket occupancy against the capped list via
    // this gauge, reacting before registration starts rejecting new flights.
    let t = setup();
    assert_eq!(t.pool.get_active_flight_count(), 0);
    register(&t);
    assert_eq!(t.pool.get_active_flight_count(), 1);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    assert_eq!(t.pool.get_active_flight_count(), 0);
}

// =========================================================================
// claim
// =========================================================================

// Helper: have RiskVault top up the pool with (payoff-premium)*buyer_count,
// then settle delayed — the production order: the Controller calls
// vault.send_payout(pool, ...) BEFORE opening the claim window, and
// settle_delayed verifies the funds are present.
fn settle_delayed_and_topup(t: &TestEnv, n_buyers: u32) {
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    let topup = (PAYOFF - PREMIUM) * (n_buyers as i128);
    t.vault.send_payout(&t.controller, &t.pool_addr, &topup);
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
}

#[test]
fn test_claim_after_delayed_success() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);

    let buyer1_balance_before = t.asset.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);

    assert_eq!(t.asset.balance(&t.buyer1), buyer1_balance_before + PAYOFF);
    assert!(t.pool.has_claimed(&flight_a(), &FLIGHT_DATE, &t.buyer1));
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.claimed_count, 1);
}

#[test]
fn test_claim_after_cancelled_success() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    // Vault top-up arrives before the claim window opens (production order).
    let topup = PAYOFF - PREMIUM;
    t.vault.send_payout(&t.controller, &t.pool_addr, &topup);
    t.pool
        .settle_cancelled(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);

    let before = t.asset.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&t.buyer1), before + PAYOFF);
}

#[test]
fn test_claim_succeeds_while_paused() {
    // Claim must remain callable during an emergency pause —
    // otherwise the ledger clock would run the claim window out and a valid,
    // already-funded payout would be permanently lost.
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);

    t.pool.pause(&t.owner);
    assert!(t.pool.paused());

    let before = t.asset.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert_eq!(t.asset.balance(&t.buyer1), before + PAYOFF);
    assert!(t.pool.has_claimed(&flight_a(), &FLIGHT_DATE, &t.buyer1));
}

#[test]
#[should_panic(expected = "Error(Contract, #412)")]
fn test_claim_before_settlement_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #412)")]
fn test_claim_on_on_time_flight_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #413)")]
fn test_claim_after_expiry_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    advance(&t, CLAIM_WINDOW_SEC + 1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #414)")]
fn test_claim_without_policy_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    let stranger = Address::generate(&t.env);
    t.pool.claim(&stranger, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #415)")]
fn test_claim_double_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
}

// =========================================================================
// sweep_expired
// =========================================================================

#[test]
fn test_sweep_expired_unclaimed_credits_recovered() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    buy(&t, &t.buyer2);
    settle_delayed_and_topup(&t, 2);

    // Buyer1 claims, buyer2 doesn't.
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    advance(&t, CLAIM_WINDOW_SEC + 1);

    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);

    // payoff * (2 buyers - 1 claimed) = PAYOFF * 1
    assert_eq!(t.pool.get_recovered_balance(), PAYOFF);
}

#[test]
fn test_sweep_expired_after_full_claims_credits_zero() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    advance(&t, CLAIM_WINDOW_SEC + 1);

    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
    assert_eq!(t.pool.get_recovered_balance(), 0);
}

#[test]
fn test_sweep_expired_double_call_idempotent() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    buy(&t, &t.buyer2);
    settle_delayed_and_topup(&t, 2);
    advance(&t, CLAIM_WINDOW_SEC + 1);

    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
    let after_first = t.pool.get_recovered_balance();
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
    let after_second = t.pool.get_recovered_balance();
    assert_eq!(after_first, PAYOFF * 2);
    assert_eq!(after_second, after_first);
}

#[test]
fn test_sweep_expired_succeeds_while_paused() {
    // Sweep must remain callable during an emergency pause — the FlightConfig
    // TTL buffer past claim_expiry runs on the ledger clock, so gating the
    // sweep would let a long pause archive the entry with the unclaimed
    // obligation still uncredited to RecoveredBalance.
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    advance(&t, CLAIM_WINDOW_SEC + 1);

    t.pool.pause(&t.owner);
    assert!(t.pool.paused());

    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
    assert_eq!(t.pool.get_recovered_balance(), PAYOFF);
}

#[test]
#[should_panic(expected = "Error(Contract, #416)")]
fn test_sweep_expired_before_expiry_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #412)")]
fn test_sweep_expired_on_unsettled_fails() {
    let t = setup();
    register(&t);
    advance(&t, CLAIM_WINDOW_SEC + 1);
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #412)")]
fn test_sweep_expired_on_on_time_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    advance(&t, CLAIM_WINDOW_SEC + 1);
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
}

// =========================================================================
// withdraw_recovered
// =========================================================================

#[test]
fn test_withdraw_recovered_success() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    buy(&t, &t.buyer2);
    settle_delayed_and_topup(&t, 2);
    advance(&t, CLAIM_WINDOW_SEC + 1);
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);

    let recovered = t.pool.get_recovered_balance();
    assert_eq!(recovered, PAYOFF * 2);
    let owner_before = t.asset.balance(&t.owner);

    t.pool.withdraw_recovered(&recovered);

    assert_eq!(t.asset.balance(&t.owner), owner_before + recovered);
    assert_eq!(t.pool.get_recovered_balance(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #404)")]
fn test_withdraw_recovered_exceeds_balance_fails() {
    let t = setup();
    t.pool.withdraw_recovered(&1);
}

#[test]
#[should_panic]
fn test_withdraw_recovered_no_auth_fails() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin);
    // Oracle never consulted on this path — any address satisfies the
    // vault constructor.
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &asset_id.address(), &Address::generate(&env)),
    );
    let pool_addr = env.register(
        FlightPoolManager,
        (&owner, &asset_id.address(), &vault_addr),
    );
    let pool = FlightPoolManagerClient::new(&env, &pool_addr);
    pool.withdraw_recovered(&1);
}

// =========================================================================
// Read functions (extra coverage)
// =========================================================================

#[test]
fn test_active_flights_pruned_on_settlement() {
    let t = setup();
    register(&t);
    let other = symbol_short!("BB200");
    t.pool.register_flight(
        &t.controller,
        &other,
        &FLIGHT_DATE,
        &PREMIUM,
        &PAYOFF,
        &DELAY_HOURS,
    );
    assert_eq!(t.pool.get_active_flights().len(), 2);

    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    let active = t.pool.get_active_flights();
    assert_eq!(active.len(), 1);
    assert_eq!(active.get(0), Some((other, FLIGHT_DATE)));
}

#[test]
fn test_has_policy_and_has_claimed_flow() {
    let t = setup();
    register(&t);
    assert!(!t.pool.has_policy(&flight_a(), &FLIGHT_DATE, &t.buyer1));
    buy(&t, &t.buyer1);
    assert!(t.pool.has_policy(&flight_a(), &FLIGHT_DATE, &t.buyer1));
    assert!(!t.pool.has_claimed(&flight_a(), &FLIGHT_DATE, &t.buyer1));
    settle_delayed_and_topup(&t, 1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert!(t.pool.has_claimed(&flight_a(), &FLIGHT_DATE, &t.buyer1));
}

// =========================================================================
// Events (spot checks)
// =========================================================================

// Helper: count emitted events on the pool whose topic prefix is
// `["sentinel", <verb>]` for the given verb.
fn count_pool_events(t: &TestEnv, verb: Symbol) -> u32 {
    use soroban_sdk::{symbol_short, TryFromVal};
    let pool_addr = t.pool_addr.clone();
    let sentinel = symbol_short!("sentinel");
    let mut count: u32 = 0;
    for (addr, topics, _data) in collect_events(&t.env).iter() {
        if addr != pool_addr {
            continue;
        }
        if topics.len() < 2 {
            continue;
        }
        let t0 = Symbol::try_from_val(&t.env, &topics.get(0).unwrap()).ok();
        let t1 = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()).ok();
        if t0 == Some(sentinel.clone()) && t1 == Some(verb.clone()) {
            count += 1;
        }
    }
    count
}

#[test]
fn test_register_emits_event() {
    let t = setup();
    register(&t);
    assert!(count_pool_events(&t, symbol_short!("register")) >= 1);
}

#[test]
fn test_claim_emits_event() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert!(count_pool_events(&t, symbol_short!("claim")) >= 1);
}

#[test]
fn test_sweep_emits_event_only_when_unclaimed() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    advance(&t, CLAIM_WINDOW_SEC + 1);
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
    assert_eq!(count_pool_events(&t, symbol_short!("sweep")), 1);
}

#[test]
fn test_extend_ttl_is_callable() {
    let t = setup();
    t.pool.extend_ttl();
}
