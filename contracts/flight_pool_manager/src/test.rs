use super::*;
use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger, token, Address, Env, Symbol,
};

const PREMIUM: i128 = 10_0000000; // 10 USDC (7 decimals)
const PAYOFF: i128 = 50_0000000; // 50 USDC
const DELAY_HOURS: u32 = 3;
const FLIGHT_DATE: u64 = 1_710_500_000;
const INITIAL_TIMESTAMP: u64 = 1_710_400_000;
const CLAIM_WINDOW_SEC: u64 = 5_184_000; // 60 days
const VAULT_LIQUIDITY: i128 = 10_000_0000000; // 10,000 USDC seeded into vault

#[allow(dead_code)]
struct TestEnv {
    env: Env,
    pool: FlightPoolManagerClient<'static>,
    pool_addr: Address,
    vault: risk_vault::RiskVaultClient<'static>,
    vault_addr: Address,
    usdc: token::Client<'static>,
    usdc_addr: Address,
    owner: Address,
    controller: Address,
    buyer1: Address,
    buyer2: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let controller = Address::generate(&env);
    let buyer1 = Address::generate(&env);
    let buyer2 = Address::generate(&env);

    // Mock USDC via Stellar Asset Contract
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();
    let usdc = token::Client::new(&env, &usdc_addr);
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc_addr);

    // RiskVault — needs OZ FungibleVault wired around USDC.
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_addr));
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    // FlightPoolManager
    let pool_addr = env.register(FlightPoolManager, (&owner, &usdc_addr, &vault_addr));
    let pool = FlightPoolManagerClient::new(&env, &pool_addr);

    // Wire controller (one-time write) — both vault and pool
    vault.set_controller(&controller);
    pool.set_controller(&controller);

    // Seed vault with USDC liquidity (mint then deposit through vault as a fake underwriter)
    let underwriter = Address::generate(&env);
    usdc_admin_client.mint(&underwriter, &VAULT_LIQUIDITY);
    vault.deposit(&VAULT_LIQUIDITY, &underwriter, &underwriter, &underwriter);

    // Pre-fund buyers with enough USDC to pay premiums; they'll transfer to pool in tests
    usdc_admin_client.mint(&buyer1, &(PREMIUM * 10));
    usdc_admin_client.mint(&buyer2, &(PREMIUM * 10));

    TestEnv {
        env,
        pool,
        pool_addr,
        vault,
        vault_addr,
        usdc,
        usdc_addr,
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
    t.usdc.transfer(buyer, &t.pool_addr, &PREMIUM);
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
    assert_eq!(t.pool.get_usdc_token(), t.usdc_addr);
    assert_eq!(t.pool.get_risk_vault(), t.vault_addr);
    assert_eq!(t.pool.get_recovered_balance(), 0);
    assert_eq!(t.pool.get_active_flights().len(), 0);
}

#[test]
#[should_panic(expected = "controller already set")]
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
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let pool_addr = env.register(FlightPoolManager, (&owner, &usdc_id.address(), &vault_addr));
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
fn test_register_flight_duplicate_is_idempotent() {
    // M-05: re-registering with matching terms is a no-op so two travelers
    // racing to the first purchase don't both have their txs revert.
    let t = setup();
    register(&t);
    register(&t);
    // Flight is still registered, only one entry in the active list.
    let active = t.pool.get_active_flights();
    assert_eq!(active.len(), 1);
}

#[test]
#[should_panic(expected = "flight already registered with different terms")]
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
#[should_panic(expected = "not controller")]
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
#[should_panic(expected = "premium must be positive")]
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
    assert_eq!(t.usdc.balance(&t.pool_addr), PREMIUM);
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
    assert_eq!(t.usdc.balance(&t.pool_addr), PREMIUM * 2);
}

#[test]
#[should_panic(expected = "flight not registered")]
fn test_add_buyer_before_register_fails() {
    let t = setup();
    t.pool
        .add_buyer(&t.controller, &flight_a(), &FLIGHT_DATE, &t.buyer1);
}

#[test]
#[should_panic(expected = "already a buyer")]
fn test_add_buyer_duplicate_same_address_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool
        .add_buyer(&t.controller, &flight_a(), &FLIGHT_DATE, &t.buyer1);
}

#[test]
#[should_panic(expected = "not controller")]
fn test_add_buyer_non_controller_fails() {
    let t = setup();
    register(&t);
    let attacker = Address::generate(&t.env);
    t.pool
        .add_buyer(&attacker, &flight_a(), &FLIGHT_DATE, &t.buyer1);
}

#[test]
#[should_panic(expected = "flight not active")]
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

    let pool_balance_before = t.usdc.balance(&t.pool_addr);
    assert_eq!(pool_balance_before, PREMIUM * 2);
    let vault_tma_before = t.vault.get_total_managed_assets();

    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);

    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.status, SettlementStatus::SettledOnTime);
    assert_eq!(t.pool.get_active_flights().len(), 0);
    assert_eq!(t.usdc.balance(&t.pool_addr), 0);
    assert_eq!(
        t.vault.get_total_managed_assets(),
        vault_tma_before + PREMIUM * 2
    );
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
#[should_panic(expected = "flight not active")]
fn test_settle_on_time_twice_fails() {
    let t = setup();
    register(&t);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "not controller")]
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
    t.pool
        .settle_cancelled(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
    let cfg = t.pool.get_flight_config(&flight_a(), &FLIGHT_DATE).unwrap();
    assert_eq!(cfg.status, SettlementStatus::SettledCancelled);
    assert_eq!(cfg.claim_expiry, claim_expiry);
}

#[test]
#[should_panic(expected = "flight not active")]
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
#[should_panic(expected = "not controller")]
fn test_settle_delayed_non_controller_fails() {
    let t = setup();
    register(&t);
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    let attacker = Address::generate(&t.env);
    t.pool
        .settle_delayed(&attacker, &flight_a(), &FLIGHT_DATE, &claim_expiry);
}

#[test]
#[should_panic(expected = "claim_expiry must be in the future")]
fn test_settle_delayed_past_expiry_fails() {
    let t = setup();
    register(&t);
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &0);
}

// =========================================================================
// claim
// =========================================================================

// Helper: settle delayed and have RiskVault top up the pool with (payoff-premium)*buyer_count
// (in real flow Controller calls vault.send_payout(pool, ...); here we simulate it directly).
fn settle_delayed_and_topup(t: &TestEnv, n_buyers: u32) {
    let claim_expiry = t.env.ledger().timestamp() + CLAIM_WINDOW_SEC;
    t.pool
        .settle_delayed(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
    let topup = (PAYOFF - PREMIUM) * (n_buyers as i128);
    t.vault.send_payout(&t.controller, &t.pool_addr, &topup);
}

#[test]
fn test_claim_after_delayed_success() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);

    let buyer1_balance_before = t.usdc.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);

    assert_eq!(t.usdc.balance(&t.buyer1), buyer1_balance_before + PAYOFF);
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
    t.pool
        .settle_cancelled(&t.controller, &flight_a(), &FLIGHT_DATE, &claim_expiry);
    let topup = PAYOFF - PREMIUM;
    t.vault.send_payout(&t.controller, &t.pool_addr, &topup);

    let before = t.usdc.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert_eq!(t.usdc.balance(&t.buyer1), before + PAYOFF);
}

#[test]
fn test_claim_succeeds_while_paused() {
    // Audit VF-03: claim must remain callable during an emergency pause —
    // otherwise the ledger clock would run the claim window out and a valid,
    // already-funded payout would be permanently lost.
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);

    t.pool.pause(&t.owner);
    assert!(t.pool.paused());

    let before = t.usdc.balance(&t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
    assert_eq!(t.usdc.balance(&t.buyer1), before + PAYOFF);
    assert!(t.pool.has_claimed(&flight_a(), &FLIGHT_DATE, &t.buyer1));
}

#[test]
#[should_panic(expected = "flight not in claimable status")]
fn test_claim_before_settlement_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "flight not in claimable status")]
fn test_claim_on_on_time_flight_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    t.pool
        .settle_on_time(&t.controller, &flight_a(), &FLIGHT_DATE);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "claim window closed")]
fn test_claim_after_expiry_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    advance(&t, CLAIM_WINDOW_SEC + 1);
    t.pool.claim(&t.buyer1, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "no policy")]
fn test_claim_without_policy_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    let stranger = Address::generate(&t.env);
    t.pool.claim(&stranger, &flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "already claimed")]
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
#[should_panic(expected = "claim window still open")]
fn test_sweep_expired_before_expiry_fails() {
    let t = setup();
    register(&t);
    buy(&t, &t.buyer1);
    settle_delayed_and_topup(&t, 1);
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "flight not in claimable status")]
fn test_sweep_expired_on_unsettled_fails() {
    let t = setup();
    register(&t);
    advance(&t, CLAIM_WINDOW_SEC + 1);
    t.pool.sweep_expired(&flight_a(), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "flight not in claimable status")]
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
    let owner_before = t.usdc.balance(&t.owner);

    t.pool.withdraw_recovered(&recovered);

    assert_eq!(t.usdc.balance(&t.owner), owner_before + recovered);
    assert_eq!(t.pool.get_recovered_balance(), 0);
}

#[test]
#[should_panic(expected = "exceeds recovered balance")]
fn test_withdraw_recovered_exceeds_balance_fails() {
    let t = setup();
    t.pool.withdraw_recovered(&1);
}

#[test]
#[should_panic]
fn test_withdraw_recovered_no_auth_fails() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
    let pool_addr = env.register(FlightPoolManager, (&owner, &usdc_id.address(), &vault_addr));
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
// `["sentinel", <verb>]` for the given verb. L-03 namespace.
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
