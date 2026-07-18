use super::*;
use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    contracttype, symbol_short, testutils::Address as _, testutils::Ledger as _, token, Address,
    Env, Symbol, TryFromVal, Vec,
};

const PREMIUM: i128 = 10_0000000; // 10 asset (7 decimals)
const PAYOFF: i128 = 50_0000000; // 50 asset
const DELAY_HOURS: u32 = 3;
// Day-aligned (1_710_460_800 = 86_400 * 19_797).
// buy_insurance requires the
// date to be a midnight-UTC boundary.
const FLIGHT_DATE: u64 = 1_710_460_800;
const SECONDS_PER_DAY: u64 = 86_400;
const MIN_LEAD_TIME: u64 = 3_600;
const CLAIM_EXPIRY_WINDOW: u64 = 5_184_000; // 60 days
const DEPOSIT_AMOUNT: i128 = 1_000_0000000; // 1000 asset
const INITIAL_TIMESTAMP: u64 = 1_710_400_000;
// Mirrors the vault's LP_PRICING_DELAY_SECS — queued deposit/withdrawal
// requests may only be priced once they are at least this old.
const LP_PRICING_DELAY_SECS: u64 = 6 * 3_600;
const EST_ARRIVAL: u64 = 1_710_500_000;
const ACTUAL_ON_TIME: u64 = 1_710_501_800; // 30 min late (< 3h)
const ACTUAL_DELAYED: u64 = 1_710_510_800; // 3h late (>= 3h)

#[allow(dead_code)]
struct TestEnv {
    env: Env,
    ctrl: ControllerClient<'static>,
    ctrl_addr: Address,
    vault: risk_vault::RiskVaultClient<'static>,
    oracle: oracle_aggregator::OracleAggregatorClient<'static>,
    pool: flight_pool_manager::FlightPoolManagerClient<'static>,
    pool_addr: Address,
    gov: governance_module::GovernanceModuleClient<'static>,
    asset: token::Client<'static>,
    asset_admin: token::StellarAssetClient<'static>,
    owner: Address,
    keeper: Address,
    oracle_account: Address,
    underwriter: Address,
}

#[test]
fn version_initialized_to_one() {
    let t = setup();
    assert_eq!(t.ctrl.version(), 1);
}

fn setup() -> TestEnv {
    let env = Env::default();
    // Plain root-frame auth is sufficient: every contract-to-contract call that
    // requires the controller's authorization is made BY the controller
    // directly (it is the direct caller in each case), so no non-root contract
    // auth is needed. This keeps the tests honest about production auth
    // semantics.
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let asset_admin_addr = Address::generate(&env);
    let oracle_account = Address::generate(&env);

    // asset (Stellar Asset Contract)
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin_addr.clone());
    let asset_admin = token::StellarAssetClient::new(&env, &asset_id.address());
    let asset = token::Client::new(&env, &asset_id.address());

    // GovernanceModule
    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

    // OracleAggregator
    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &oracle_account),
    );
    let oracle = oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);

    // RiskVault — the settlement barrier's oracle is a constructor argument,
    // so the oracle is registered first (mirrors the production deploy order).
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &asset_id.address(), &oracle_addr),
    );
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    // FlightPoolManager
    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &asset_id.address(), &vault_addr),
    );
    let pool = flight_pool_manager::FlightPoolManagerClient::new(&env, &pool_addr);

    // Controller
    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &asset_id.address(),
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);

    // Wire one-time controllers on each downstream contract.
    vault.set_controller(&ctrl_addr);
    oracle.set_controller(&ctrl_addr);
    pool.set_controller(&ctrl_addr);

    // Whitelist the default test route.
    gov.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Seed underwriter capital so solvency checks pass. LP entry is
    // two-phase: request, mature past the pricing delay, then let the
    // keeper's maintenance pass mint at the current price.
    let underwriter = Address::generate(&env);
    asset_admin.mint(&underwriter, &DEPOSIT_AMOUNT);
    vault.request_deposit(&underwriter, &DEPOSIT_AMOUNT);
    env.ledger()
        .with_mut(|l| l.timestamp += LP_PRICING_DELAY_SECS);
    ctrl.run_queue_maintenance(&keeper);

    TestEnv {
        env,
        ctrl,
        ctrl_addr,
        vault,
        oracle,
        pool,
        pool_addr,
        gov,
        asset,
        asset_admin,
        owner,
        keeper,
        oracle_account,
        underwriter,
    }
}

// Mirrors the oracle's on-chain cap on sale-authorization validity (24h).
const SALE_AUTH_MAX_VALIDITY_SECS: u64 = 86_400;

/// Open (or refresh) the oracle sale window for a flight instance — the
/// affirmative attestation `buy_insurance` requires. Mirrors the executor:
/// never authorizes a flight with a recorded outcome (so tests exercising
/// the status gate still reach it) and bounds the expiry to the on-chain
/// validity cap. No-op when a valid expiry can't be formed.
fn open_sale(t: &TestEnv, flight_id: &Symbol, date: u64) {
    let status = t.oracle.get_flight_data(flight_id, &date).status;
    if !matches!(
        status,
        crate::interfaces::FlightStatus::NotInitiated | crate::interfaces::FlightStatus::Active
    ) {
        return;
    }
    let now = t.env.ledger().timestamp();
    let expires_at = date.min(now + SALE_AUTH_MAX_VALIDITY_SECS);
    if expires_at <= now {
        return;
    }
    t.oracle
        .open_sale(&t.oracle_account, flight_id, &date, &expires_at);
}

fn buy(t: &TestEnv, traveler: &Address) {
    open_sale(t, &symbol_short!("AA100"), FLIGHT_DATE);
    t.asset_admin.mint(traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

fn oracle_on_time(t: &TestEnv) {
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &ACTUAL_ON_TIME,
    );
}

fn oracle_delayed(t: &TestEnv) {
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle.set_landed(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &ACTUAL_DELAYED,
    );
}

fn oracle_cancelled(t: &TestEnv) {
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    t.oracle
        .set_cancelled(&t.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);
}

// =========================================================================
// Constructor & getters
// =========================================================================

#[test]
fn test_constructor() {
    let t = setup();
    assert_eq!(t.ctrl.get_owner(), Some(t.owner.clone()));
    assert_eq!(t.ctrl.get_keeper(), t.keeper);
    assert_eq!(t.ctrl.get_solvency_ratio(), 100);
    assert_eq!(t.ctrl.get_flight_pool_manager(), t.pool_addr);
    let (sold, collected, distributed) = t.ctrl.get_stats();
    assert_eq!(sold, 0);
    assert_eq!(collected, 0);
    assert_eq!(distributed, 0);
}

// =========================================================================
// Owner-only setters
// =========================================================================

#[test]
fn test_set_keeper() {
    let t = setup();
    let new_keeper = Address::generate(&t.env);
    t.ctrl.set_keeper(&new_keeper);
    assert_eq!(t.ctrl.get_keeper(), new_keeper);
}

#[test]
fn test_set_solvency_ratio() {
    let t = setup();
    t.ctrl.set_solvency_ratio(&150);
    assert_eq!(t.ctrl.get_solvency_ratio(), 150);
    // Mirrored into the vault in the same transaction, so LP exits are
    // bounded by the same reserve purchases are admitted against.
    assert_eq!(t.vault.get_solvency_ratio(), 150);
}

#[test]
fn test_set_min_lead_time() {
    let t = setup();
    t.ctrl.set_min_lead_time(&7_200);
    // Effect observable through buy_insurance lead-time gate (covered separately).
}

#[test]
fn test_set_claim_expiry_window() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&86_400);
    // Effect observable through execute_settlements paths.
}

#[test]
#[should_panic(expected = "Error(Contract, #301)")]
fn test_set_solvency_ratio_below_100_panics() {
    let t = setup();
    t.ctrl.set_solvency_ratio(&99);
}

#[test]
#[should_panic(expected = "Error(Contract, #301)")]
fn test_set_solvency_ratio_above_max_panics() {
    let t = setup();
    t.ctrl.set_solvency_ratio(&10_001);
}

#[test]
#[should_panic(expected = "Error(Contract, #314)")]
fn test_set_min_lead_time_above_max_panics() {
    let t = setup();
    t.ctrl.set_min_lead_time(&7_776_001);
}

#[test]
#[should_panic(expected = "Error(Contract, #314)")]
fn test_set_min_lead_time_equal_to_booking_horizon_panics() {
    // min_lead == MAX_BOOK_AHEAD leaves an empty booking interval:
    // `now + min_lead < date <= now + MAX_BOOK_AHEAD` has no solution.
    let t = setup();
    t.ctrl.set_min_lead_time(&7_776_000);
}

#[test]
fn test_set_min_lead_time_just_below_horizon_ok() {
    let t = setup();
    t.ctrl.set_min_lead_time(&(7_776_000 - 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #303)")]
fn test_set_claim_expiry_window_zero_panics() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&0);
}

#[test]
#[should_panic(expected = "Error(Contract, #303)")]
fn test_set_claim_expiry_window_below_min_panics() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&86_399);
}

#[test]
#[should_panic(expected = "Error(Contract, #303)")]
fn test_set_claim_expiry_window_above_max_panics() {
    let t = setup();
    t.ctrl.set_claim_expiry_window(&15_552_001);
}

#[test]
#[should_panic]
fn test_unauthorized_set_keeper() {
    let env = Env::default();
    // No mock_all_auths — owner check fails.
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let asset_admin_addr = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin_addr);

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &Address::generate(&env)),
    );
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &asset_id.address(), &oracle_addr),
    );
    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &asset_id.address(), &vault_addr),
    );
    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &asset_id.address(),
            &Address::generate(&env), // keeper
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);

    ctrl.set_keeper(&stranger);
}

// =========================================================================
// buy_insurance happy paths
// =========================================================================

#[test]
fn test_buy_insurance_first_traveler_registers_flight() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);

    let (sold, collected, _) = t.ctrl.get_stats();
    assert_eq!(sold, 1);
    assert_eq!(collected, PREMIUM);

    // Premium transferred from traveler to FlightPoolManager.
    assert_eq!(t.asset.balance(&traveler), 0);
    assert_eq!(t.asset.balance(&t.pool_addr), PREMIUM);

    // Vault collateral locked.
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    // FlightPoolManager has the registered flight.
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.premium, PREMIUM);
    assert_eq!(cfg.payoff, PAYOFF);
    assert_eq!(cfg.delay_hours, DELAY_HOURS);
    assert_eq!(cfg.buyer_count, 1);

    // Per-traveler index updated.
    let flights = t.ctrl.get_flights_for_traveler(&traveler);
    assert_eq!(flights.len(), 1);
    assert_eq!(
        flights.get(0).unwrap(),
        (symbol_short!("AA100"), FLIGHT_DATE)
    );
}

#[test]
fn test_buy_insurance_second_traveler_skips_register() {
    let t = setup();
    let traveler1 = Address::generate(&t.env);
    let traveler2 = Address::generate(&t.env);

    buy(&t, &traveler1);
    buy(&t, &traveler2);

    // FlightPoolManager has both buyers on the same flight (single registration).
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.buyer_count, 2);

    // Pool asset = 2 × premium, vault locked = 2 × payoff.
    assert_eq!(t.asset.balance(&t.pool_addr), 2 * PREMIUM);
    assert_eq!(t.vault.get_locked_capital(), 2 * PAYOFF);

    // Each traveler has their own per-traveler index entry.
    assert_eq!(t.ctrl.get_flights_for_traveler(&traveler1).len(), 1);
    assert_eq!(t.ctrl.get_flights_for_traveler(&traveler2).len(), 1);
}

#[test]
fn test_buy_insurance_traveler_index_for_multiple_flights() {
    let t = setup();
    let traveler = Address::generate(&t.env);

    // Whitelist a second route.
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    buy(&t, &traveler);

    open_sale(&t, &symbol_short!("UA200"), FLIGHT_DATE + SECONDS_PER_DAY);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
    );

    let flights = t.ctrl.get_flights_for_traveler(&traveler);
    assert_eq!(flights.len(), 2);
    assert_eq!(
        flights.get(0).unwrap(),
        (symbol_short!("AA100"), FLIGHT_DATE)
    );
    assert_eq!(
        flights.get(1).unwrap(),
        (symbol_short!("UA200"), FLIGHT_DATE + SECONDS_PER_DAY)
    );
}

#[test]
fn test_get_flights_for_traveler_empty_for_unknown_address() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    let flights = t.ctrl.get_flights_for_traveler(&stranger);
    assert_eq!(flights.len(), 0);
}

#[test]
fn test_traveler_flights_index_is_bounded() {
    // The per-traveler index is capped so it can't grow into the persistent
    // entry-size limit and permanently block the buy path. When full, the oldest
    // entry is evicted (keeping the most recent), rather than blocking.
    use crate::constants::MAX_TRAVELER_FLIGHTS;
    use crate::storage::{append_traveler_flight, CtrlKey};
    let t = setup();
    let traveler = Address::generate(&t.env);
    let fid = symbol_short!("AA100");

    t.env.as_contract(&t.ctrl_addr, || {
        // Seed the index at exactly the cap (dates 0..MAX-1).
        let mut list: Vec<(Symbol, u64)> = Vec::new(&t.env);
        for i in 0..MAX_TRAVELER_FLIGHTS {
            list.push_back((fid.clone(), i as u64));
        }
        t.env
            .storage()
            .persistent()
            .set(&CtrlKey::TravelerFlights(traveler.clone()), &list);

        // One more append must evict the oldest (date 0), not grow past the cap.
        append_traveler_flight(&t.env, &traveler, &fid, 9_999u64);
    });

    let flights = t.ctrl.get_flights_for_traveler(&traveler);
    // Bounded to the cap — never unbounded, so the buy path can't be blocked.
    assert_eq!(flights.len(), MAX_TRAVELER_FLIGHTS);
    // Oldest (date 0) evicted; index now starts at date 1 and ends at the newest.
    assert_eq!(flights.get(0).unwrap(), (fid.clone(), 1u64));
    assert_eq!(
        flights.get(flights.len() - 1).unwrap(),
        (fid.clone(), 9_999u64)
    );
}

// =========================================================================
// buy_insurance gate panics
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #307)")]
fn test_buy_insurance_panics_on_disabled_route() {
    let t = setup();
    t.gov.disable_route(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
    );
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
}

#[test]
#[should_panic(expected = "Error(Contract, #308)")]
fn test_buy_insurance_panics_on_unknown_route() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("ZZ999"),
        &symbol_short!("XXX"),
        &symbol_short!("YYY"),
        &FLIGHT_DATE,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #309)")]
fn test_buy_insurance_panics_on_short_lead_time() {
    let t = setup();
    // Raise the lead requirement above the gap to the nearest day boundary so a
    // day-aligned FLIGHT_DATE (which must clear the day-alignment check first)
    // still falls inside the "too soon" zone.
    t.ctrl.set_min_lead_time(&(2 * SECONDS_PER_DAY));
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE, // ~0.7 days out, under the 2-day lead requirement
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #310)")]
fn test_buy_insurance_panics_on_far_future_booking() {
    // A flight dated beyond the 90-day booking horizon must be
    // rejected so the policy lifecycle can't outlive the 180-day buyer-key TTL.
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    // First day boundary strictly beyond the 90-day horizon (day-aligned so the
    // alignment check passes and the booking-horizon gate is what rejects it).
    let too_far = ((INITIAL_TIMESTAMP + 7_776_000) / SECONDS_PER_DAY + 1) * SECONDS_PER_DAY;
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &too_far,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #311)")]
fn test_buy_insurance_rejected_after_oracle_cancellation() {
    // Once the oracle has marked the flight Cancelled, further
    // purchases must be rejected — otherwise a late buyer claims a guaranteed
    // payoff and drains the vault.
    let t = setup();
    let traveler1 = Address::generate(&t.env);
    buy(&t, &traveler1); // registers the flight on the oracle

    // Oracle observes the cancellation before the keeper settles.
    oracle_cancelled(&t);

    // A second buyer can no longer purchase this (flight_id, date).
    let traveler2 = Address::generate(&t.env);
    buy(&t, &traveler2);
}

#[test]
fn test_second_buyer_transacts_at_snapshotted_terms_after_term_change() {
    // The pool locks terms at the first registration of a (flight_id, date)
    // and rejects mismatched re-registration. Later buyers therefore transact
    // at the FIRST buyer's snapshotted terms — a governance term change must
    // not brick further sales of an already-registered date (it applies to
    // not-yet-registered dates only).
    let t = setup();
    let traveler1 = Address::generate(&t.env);
    buy(&t, &traveler1); // registers (AA100, FLIGHT_DATE) at PREMIUM/PAYOFF

    // Governance doubles the default premium (the test route inherits
    // defaults). Without term snapshotting this would make every later buy of
    // the registered date revert on the pool's config-mismatch check.
    t.gov.set_defaults(&(PREMIUM * 2), &PAYOFF, &DELAY_HOURS);

    // The second buyer holds exactly the ORIGINAL premium — the purchase
    // succeeding at all proves it was priced off the snapshot, not the new
    // defaults.
    let traveler2 = Address::generate(&t.env);
    buy(&t, &traveler2);
    assert_eq!(t.asset.balance(&traveler2), 0);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.premium, PREMIUM);
    assert_eq!(cfg.buyer_count, 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #311)")]
fn test_buy_insurance_rejected_for_preemptively_cancelled_flight() {
    // A publicly cancelled flight may have no oracle record yet (registration
    // normally happens inside the first purchase). The oracle can now write
    // the cancellation first, and the very FIRST buyer must be rejected —
    // otherwise every policy on the flight is a guaranteed claim against the
    // vault.
    let t = setup();
    t.oracle
        .set_cancelled(&t.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);

    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
}

#[test]
#[should_panic(expected = "Error(Contract, #313)")]
fn test_buy_insurance_panics_on_non_day_aligned_date() {
    // A date that isn't a midnight-UTC boundary is rejected so
    // one physical flight can't be split into many intraday policy instances.
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &(FLIGHT_DATE + 1), // 1 second past midnight — not day-aligned
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #319)")]
fn test_buy_insurance_panics_without_sale_authorization() {
    // Absence of an on-chain outcome is NOT proof the flight is insurable —
    // a publicly cancelled flight the oracle hasn't written yet looks
    // identical to a valid unreported one. Purchases therefore require the
    // oracle's affirmative, unexpired sale authorization and fail closed
    // without it.
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #319)")]
fn test_buy_insurance_panics_on_expired_sale_authorization() {
    // A lapsed authorization must not admit purchases: the attestation is
    // only as fresh as its expiry, and an oracle that stopped re-attesting
    // may be failing to observe a public cancellation.
    let t = setup();
    let now = t.env.ledger().timestamp();
    t.oracle.open_sale(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &(now + 3_600),
    );

    // Two hours later the authorization has expired; the flight is still
    // outside the min-lead cutoff, so the sale gate is what rejects.
    t.env.ledger().with_mut(|l| l.timestamp = now + 7_200);
    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #319)")]
fn test_buy_insurance_panics_after_sale_closed() {
    // The oracle can revoke a live authorization ahead of its expiry (e.g.
    // on losing confidence in the flight's identity); the gate must reject
    // immediately, not at the original expiry.
    let t = setup();
    let now = t.env.ledger().timestamp();
    t.oracle.open_sale(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &(now + 3_600),
    );
    t.oracle
        .close_sale(&t.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);

    let traveler = Address::generate(&t.env);
    t.asset_admin.mint(&traveler, &PREMIUM);
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #320)")]
fn test_buy_insurance_rejects_snapshot_above_lowered_term_limits() {
    // The route check validates the CURRENT route terms, but later buyers of
    // a registered bucket transact at the bucket's snapshot. Lowering the
    // term limits must stop NEW exposure at an oversized snapshot even when
    // the route itself has been brought back under the cap.
    let t = setup();
    // First buyer snapshots the bucket at the original terms (payoff 50).
    let first = Address::generate(&t.env);
    buy(&t, &first);

    // Owner lowers the payoff cap below the snapshot, then updates the route
    // to compliant terms (payoff 20) so route_status reads Active again.
    t.gov.set_term_limits(&20_0000000, &5);
    t.gov.update_route_terms(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &governance_module::PremiumUpdate::Keep,
        &governance_module::PayoffUpdate::Set(20_0000000),
        &governance_module::DelayHoursUpdate::Keep,
    );

    // The bucket's snapshotted payoff (50) exceeds the current cap — the
    // second purchase must be rejected despite the compliant route.
    let second = Address::generate(&t.env);
    buy(&t, &second);
}

#[test]
fn test_lowered_term_limits_leave_new_buckets_sellable() {
    // Companion to the rejection test: closing an oversized bucket to new
    // buyers must not block the route — fresh flight dates snapshot the
    // compliant current terms and sell normally, and the closed bucket's
    // stored terms and buyer count stay untouched for settlement.
    let t = setup();
    let first = Address::generate(&t.env);
    buy(&t, &first); // bucket snapshotted at payoff 50

    t.gov.set_term_limits(&20_0000000, &5);
    t.gov.update_route_terms(
        &t.owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &governance_module::PremiumUpdate::Keep,
        &governance_module::PayoffUpdate::Set(20_0000000),
        &governance_module::DelayHoursUpdate::Keep,
    );

    // Old bucket: closed to new buyers, unchanged in storage.
    let second = Address::generate(&t.env);
    open_sale(&t, &symbol_short!("AA100"), FLIGHT_DATE);
    t.asset_admin.mint(&second, &PREMIUM);
    assert!(t
        .ctrl
        .try_buy_insurance(
            &second,
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &FLIGHT_DATE,
        )
        .is_err());
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(cfg.payoff, PAYOFF);
    assert_eq!(cfg.buyer_count, 1);

    // A fresh flight date snapshots the compliant current terms and sells.
    let next_date = FLIGHT_DATE + SECONDS_PER_DAY;
    open_sale(&t, &symbol_short!("AA100"), next_date);
    t.ctrl.buy_insurance(
        &second,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &next_date,
    );
    let cfg2 = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &next_date)
        .unwrap();
    assert_eq!(cfg2.payoff, 20_0000000);
    assert_eq!(cfg2.buyer_count, 1);
}

#[test]
fn test_classify_and_settle_multiple_flights_in_one_batch() {
    // The bounded rotating-cursor loop must still process every
    // flight when several are active. Three distinct flights settle in one pass.
    let t = setup();
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("DL300"),
        &symbol_short!("ATL"),
        &symbol_short!("BOS"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    let flights = [
        (
            symbol_short!("AA100"),
            symbol_short!("JFK"),
            symbol_short!("LAX"),
        ),
        (
            symbol_short!("UA200"),
            symbol_short!("SFO"),
            symbol_short!("ORD"),
        ),
        (
            symbol_short!("DL300"),
            symbol_short!("ATL"),
            symbol_short!("BOS"),
        ),
    ];

    for (fid, o, d) in flights.iter() {
        let traveler = Address::generate(&t.env);
        open_sale(&t, fid, FLIGHT_DATE);
        t.asset_admin.mint(&traveler, &PREMIUM);
        t.ctrl.buy_insurance(&traveler, fid, o, d, &FLIGHT_DATE);
        t.oracle
            .set_estimated_arrival(&t.oracle_account, fid, &FLIGHT_DATE, &EST_ARRIVAL);
        t.oracle
            .set_landed(&t.oracle_account, fid, &FLIGHT_DATE, &ACTUAL_ON_TIME);
    }

    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    for (fid, _o, _d) in flights.iter() {
        assert_eq!(
            t.oracle.get_flight_data(fid, &FLIGHT_DATE).status,
            oracle_aggregator::FlightStatus::Settled,
        );
    }
}

#[test]
fn test_execute_settlements_bounded_clamps_and_advances() {
    // The bounded variant is the operator's escape hatch when a full window
    // would exceed transaction resource budgets: any limit — even 0, which
    // clamps to 1 — must settle a sub-window and advance the cursor, so
    // repeated calls always drain the ready set.
    let t = setup();
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("UA200"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    t.gov.whitelist_route(
        &t.owner,
        &symbol_short!("DL300"),
        &symbol_short!("ATL"),
        &symbol_short!("BOS"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    let flights = [
        (
            symbol_short!("AA100"),
            symbol_short!("JFK"),
            symbol_short!("LAX"),
        ),
        (
            symbol_short!("UA200"),
            symbol_short!("SFO"),
            symbol_short!("ORD"),
        ),
        (
            symbol_short!("DL300"),
            symbol_short!("ATL"),
            symbol_short!("BOS"),
        ),
    ];
    for (fid, o, d) in flights.iter() {
        let traveler = Address::generate(&t.env);
        open_sale(&t, fid, FLIGHT_DATE);
        t.asset_admin.mint(&traveler, &PREMIUM);
        t.ctrl.buy_insurance(&traveler, fid, o, d, &FLIGHT_DATE);
        t.oracle
            .set_estimated_arrival(&t.oracle_account, fid, &FLIGHT_DATE, &EST_ARRIVAL);
        t.oracle
            .set_landed(&t.oracle_account, fid, &FLIGHT_DATE, &ACTUAL_ON_TIME);
    }
    t.ctrl.classify_flights(&t.keeper);

    let settled_count = |t: &TestEnv| -> u32 {
        let mut n = 0;
        for (fid, _o, _d) in flights.iter() {
            if t.oracle.get_flight_data(fid, &FLIGHT_DATE).status
                == oracle_aggregator::FlightStatus::Settled
            {
                n += 1;
            }
        }
        n
    };

    // limit 0 clamps up to 1: exactly one flight settles.
    t.ctrl.execute_settlements_bounded(&t.keeper, &0);
    assert_eq!(settled_count(&t), 1);

    // limit 1: one more.
    t.ctrl.execute_settlements_bounded(&t.keeper, &1);
    assert_eq!(settled_count(&t), 2);

    // An oversized limit clamps down to the contract maximum and finishes
    // the remaining window.
    t.ctrl.execute_settlements_bounded(&t.keeper, &10_000);
    assert_eq!(settled_count(&t), 3);
}

#[test]
fn test_execute_settlements_bounded_requires_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    assert!(t
        .ctrl
        .try_execute_settlements_bounded(&stranger, &1)
        .is_err());
}

#[test]
fn test_keeper_passes_are_noops_on_empty_active_list() {
    // Before any purchase the active list is empty — both keeper passes must
    // return cleanly (deploys run the crons from day one, ahead of traffic).
    let t = setup();
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);
    let (sold, collected, distributed) = t.ctrl.get_stats();
    assert_eq!((sold, collected, distributed), (0, 0, 0));
}

#[test]
fn test_settle_cursor_wraps_when_list_shrinks_below_it() {
    // The settle cursor persists between calls while the active list can
    // shrink underneath it (oracle-side pruning). A stale cursor at or past
    // the list length must wrap to slot 0 and keep settling — not scan an
    // empty window forever.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_on_time(&t);
    t.ctrl.classify_flights(&t.keeper);

    t.env.as_contract(&t.ctrl_addr, || {
        t.env
            .storage()
            .instance()
            .set(&crate::storage::CtrlKey::SettleCursor, &7u32);
    });
    t.ctrl.execute_settlements(&t.keeper);
    assert_eq!(
        t.oracle
            .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::Settled,
    );
}

// Same-shaped mirror of the pool's private FlightConfig storage key: Soroban
// storage keys are the XDR of the value (variant name + payload), so this
// local enum addresses the pool's entry without the pool exporting its key
// type. Test-only, for simulating a lost entry.
#[contracttype]
enum MirrorPoolKey {
    FlightConfig(Symbol, u64),
}

#[test]
fn test_execute_settlements_skips_flight_with_missing_pool_config() {
    // A pool config lost to a restoration gap must not panic the settlement
    // loop: the flight is skipped with a diagnostic, its collateral stays
    // locked for the restore-and-retry path, and the pass still completes.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_cancelled(&t);
    t.ctrl.classify_flights(&t.keeper);

    t.env.as_contract(&t.pool_addr, || {
        t.env
            .storage()
            .persistent()
            .remove(&MirrorPoolKey::FlightConfig(
                symbol_short!("AA100"),
                FLIGHT_DATE,
            ));
    });

    let locked_before = t.vault.get_locked_capital();
    t.ctrl.execute_settlements(&t.keeper);
    // Untouched: still classified, still collateralized — awaiting restore.
    assert_eq!(
        t.oracle
            .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE)
            .status,
        oracle_aggregator::FlightStatus::ToBeSettledCancelled,
    );
    assert_eq!(t.vault.get_locked_capital(), locked_before);
}

#[test]
fn test_pause_blocks_buy_and_unpause_restores() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    open_sale(&t, &symbol_short!("AA100"), FLIGHT_DATE);
    t.asset_admin.mint(&traveler, &PREMIUM);

    t.ctrl.pause(&t.owner);
    assert!(t.ctrl.paused());
    assert!(t
        .ctrl
        .try_buy_insurance(
            &traveler,
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &FLIGHT_DATE,
        )
        .is_err());

    t.ctrl.unpause(&t.owner);
    assert!(!t.ctrl.paused());
    t.ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #312)")]
fn test_buy_insurance_panics_on_solvency_gate() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    let oracle_account = Address::generate(&env);
    let asset_admin_addr = Address::generate(&env);

    let asset_id = env.register_stellar_asset_contract_v2(asset_admin_addr);
    let asset_admin = token::StellarAssetClient::new(&env, &asset_id.address());

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &oracle_account),
    );
    let oracle = oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);

    // Oracle before vault: the barrier's oracle is a constructor argument.
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &asset_id.address(), &oracle_addr),
    );
    let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &asset_id.address(), &vault_addr),
    );
    let pool = flight_pool_manager::FlightPoolManagerClient::new(&env, &pool_addr);

    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &asset_id.address(),
            &keeper,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);

    vault.set_controller(&ctrl_addr);
    oracle.set_controller(&ctrl_addr);
    pool.set_controller(&ctrl_addr);

    gov.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // NO underwriter capital — vault has 0 free capital. The sale window is
    // opened first so the solvency gate (not the sale gate) is what rejects.
    oracle.open_sale(
        &oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &FLIGHT_DATE,
    );
    let traveler = Address::generate(&env);
    asset_admin.mint(&traveler, &PREMIUM);
    ctrl.buy_insurance(
        &traveler,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &FLIGHT_DATE,
    );
}

// =========================================================================
// classify_flights
// =========================================================================

#[test]
fn test_classify_flights_on_time() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_on_time(&t);

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledOnTime
    );
}

#[test]
fn test_classify_flights_delayed() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_delayed(&t);

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledDelayed
    );
}

#[test]
fn test_classify_flights_cancelled() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_cancelled(&t);

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledCancelled
    );
}

#[test]
fn test_classify_flights_skips_unready_flights() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    // No oracle activity — flight is NotInitiated.

    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::NotInitiated);
}

#[test]
fn test_classify_flights_emits_ttl_miss_for_not_initiated() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    // Skip oracle data push — flight stays NotInitiated.

    t.ctrl.classify_flights(&t.keeper);

    // Event log holds events from the most recent invocation only — assert
    // immediately, before any subsequent contract call. Look for an event
    // emitted by the controller with topic prefix ["sentinel", "ttl_miss"]
    // and a third indexed `flight_id` topic equal to AA100.
    let mut found = false;
    for (event_addr, topics, _data) in collect_events(&t.env).iter() {
        if event_addr != t.ctrl_addr {
            continue;
        }
        if topics.len() < 3 {
            continue;
        }
        let t0 = Symbol::try_from_val(&t.env, &topics.get(0).unwrap()).ok();
        let t1 = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()).ok();
        let t2 = Symbol::try_from_val(&t.env, &topics.get(2).unwrap()).ok();
        if t0 == Some(symbol_short!("sentinel"))
            && t1 == Some(symbol_short!("ttl_miss"))
            && t2 == Some(symbol_short!("AA100"))
        {
            found = true;
            break;
        }
    }
    assert!(found, "expected sentinel.ttl_miss event for AA100");
}

#[test]
fn test_classify_flights_leaves_stuck_active_flight_before_timeout() {
    // An Active flight missing its terminal outcome must NOT be voided while
    // the timeout past its scheduled arrival has not elapsed — the oracle may
    // simply be late.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );

    t.env.ledger().with_mut(|l| {
        l.timestamp = EST_ARRIVAL + sentinel_types::timeouts::ACTIVE_FLIGHT_TIMEOUT_SECS - 1
    });
    t.ctrl.classify_flights(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Active);
}

#[test]
fn test_classify_flights_times_out_stuck_active_flight() {
    // An Active flight whose terminal outcome never arrives must not lock
    // vault collateral forever: once the timeout past its scheduled arrival
    // elapses, classification voids it (settled as on-time, no payout) and
    // settlement releases the locked payoff and forwards the premium.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    t.oracle.set_estimated_arrival(
        &t.oracle_account,
        &symbol_short!("AA100"),
        &FLIGHT_DATE,
        &EST_ARRIVAL,
    );
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    t.env.ledger().with_mut(|l| {
        l.timestamp = EST_ARRIVAL + sentinel_types::timeouts::ACTIVE_FLIGHT_TIMEOUT_SECS
    });
    t.ctrl.classify_flights(&t.keeper);

    // The distinct timeout event is emitted alongside the classification.
    let mut found = false;
    for (event_addr, topics, _data) in collect_events(&t.env).iter() {
        if event_addr != t.ctrl_addr {
            continue;
        }
        if topics.len() < 3 {
            continue;
        }
        let t0 = Symbol::try_from_val(&t.env, &topics.get(0).unwrap()).ok();
        let t1 = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()).ok();
        let t2 = Symbol::try_from_val(&t.env, &topics.get(2).unwrap()).ok();
        if t0 == Some(symbol_short!("sentinel"))
            && t1 == Some(symbol_short!("timed_out"))
            && t2 == Some(symbol_short!("AA100"))
        {
            found = true;
            break;
        }
    }
    assert!(found, "expected sentinel.timed_out event for AA100");

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledOnTime
    );
    // The void is a newly disclosed outcome — the LP barrier engages until
    // settlement recognizes it.
    assert!(t.oracle.has_pending_outcomes());

    t.ctrl.execute_settlements(&t.keeper);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);
    assert_eq!(t.vault.get_locked_capital(), 0);
    assert!(!t.oracle.has_pending_outcomes());
    // No payout: the traveler's premium became vault income.
    assert_eq!(t.asset.balance(&traveler), 0);
    assert_eq!(t.vault.get_total_managed_assets(), DEPOSIT_AMOUNT + PREMIUM);
}

#[test]
#[should_panic(expected = "Error(Contract, #304)")]
fn test_classify_flights_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl.classify_flights(&stranger);
}

// =========================================================================
// execute_settlements
// =========================================================================

#[test]
fn test_execute_settlements_on_time_flow() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_on_time(&t);
    t.ctrl.classify_flights(&t.keeper);

    let tma_before = t.vault.get_total_managed_assets();
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);

    t.ctrl.execute_settlements(&t.keeper);

    // On-time settlement: premium transferred to vault as yield, collateral unlocked.
    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before + PREMIUM);

    // Pool's asset drained to vault.
    assert_eq!(t.asset.balance(&t.pool_addr), 0);

    // Oracle marks Settled with settled_at recorded.
    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);
    assert!(data.settled_at != 0);

    // Pool's flight status is SettledOnTime.
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledOnTime
    );
}

#[test]
fn test_execute_settlements_delayed_flow() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_delayed(&t);
    t.ctrl.classify_flights(&t.keeper);

    assert_eq!(t.asset.balance(&t.pool_addr), PREMIUM);

    t.ctrl.execute_settlements(&t.keeper);

    // Delayed: vault sends (payoff - premium) to pool, collateral unlocked.
    assert_eq!(t.vault.get_locked_capital(), 0);
    // Pool now holds the full payoff for the buyer to claim.
    assert_eq!(t.asset.balance(&t.pool_addr), PAYOFF);

    let (_, _, distributed) = t.ctrl.get_stats();
    assert_eq!(distributed, PAYOFF);

    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledDelayed
    );
    // Settlement runs at the current ledger time — setup's pricing-delay
    // advance included — so the claim window is anchored there.
    assert_eq!(
        cfg.claim_expiry,
        INITIAL_TIMESTAMP + LP_PRICING_DELAY_SECS + CLAIM_EXPIRY_WINDOW
    );
}

#[test]
fn test_execute_settlements_cancelled_flow() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_cancelled(&t);
    t.ctrl.classify_flights(&t.keeper);

    t.ctrl.execute_settlements(&t.keeper);

    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.asset.balance(&t.pool_addr), PAYOFF);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledCancelled
    );
}

#[test]
fn test_execute_settlements_skips_unclassified_flights() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    // No oracle activity — flight is NotInitiated. Skip classify.

    let tma_before = t.vault.get_total_managed_assets();
    t.ctrl.execute_settlements(&t.keeper);

    // No money movement: flight wasn't classified.
    assert_eq!(t.vault.get_locked_capital(), PAYOFF);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before);
}

#[test]
fn test_run_queue_maintenance_processes_withdrawal_queue() {
    // Queue drain is no longer coupled to execute_settlements.
    // After settlements free up capital, the keeper calls
    // run_queue_maintenance to actually drain the queue.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);

    let underwriter_shares = t.vault.balance(&t.underwriter);
    let withdraw_shares = underwriter_shares / 2;
    t.vault.request_withdrawal(&t.underwriter, &withdraw_shares);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);
    // Requests are priced only once they outlive the LP pricing delay.
    t.env
        .ledger()
        .with_mut(|l| l.timestamp += LP_PRICING_DELAY_SECS);

    oracle_on_time(&t);
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);
    // Settlement alone does NOT drain the queue.
    assert_eq!(t.vault.get_withdrawal_queue().len(), 1);

    t.ctrl.run_queue_maintenance(&t.keeper);
    assert_eq!(t.vault.get_withdrawal_queue().len(), 0);
    assert!(t.vault.get_claimable_balance(&t.underwriter) > 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #304)")]
fn test_run_queue_maintenance_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl.run_queue_maintenance(&stranger);
}

#[test]
#[should_panic(expected = "Error(Contract, #304)")]
fn test_execute_settlements_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl.execute_settlements(&stranger);
}

// =========================================================================
// Exact-tuple classification / settlement (classify_flight, settle_flight)
// =========================================================================

#[test]
fn test_classify_flight_classifies_exact_tuple() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_delayed(&t);

    // Targeted call classifies without touching the sweep cursor.
    assert!(t
        .ctrl
        .classify_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));
    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(
        data.status,
        oracle_aggregator::FlightStatus::ToBeSettledDelayed
    );

    // Idempotent: an already-classified flight needs no transition.
    assert!(!t
        .ctrl
        .classify_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));
}

#[test]
fn test_classify_flight_no_op_before_outcome() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    // No oracle outcome yet — NotInitiated, pre-departure: nothing to classify.
    assert!(!t
        .ctrl
        .classify_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));
    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::NotInitiated);
}

#[test]
fn test_settle_flight_settles_exact_tuple() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_delayed(&t);

    // Outcome written but unclassified: nothing settleable yet.
    assert!(!t
        .ctrl
        .settle_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));
    assert!(t.oracle.has_pending_outcomes());

    assert!(t
        .ctrl
        .classify_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));
    assert!(t
        .ctrl
        .settle_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));

    // Same terminal state the sweep produces: collateral unlocked, pool funded
    // to the full payoff, oracle Settled, barrier released.
    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.asset.balance(&t.pool_addr), PAYOFF);
    assert!(!t.oracle.has_pending_outcomes());
    let data = t
        .oracle
        .get_flight_data(&symbol_short!("AA100"), &FLIGHT_DATE);
    assert_eq!(data.status, oracle_aggregator::FlightStatus::Settled);
    let (_, _, distributed) = t.ctrl.get_stats();
    assert_eq!(distributed, PAYOFF);

    // Idempotent: a settled flight settles nothing further.
    assert!(!t
        .ctrl
        .settle_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));
}

#[test]
fn test_settle_flight_on_time_credits_premium() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    oracle_on_time(&t);
    let tma_before = t.vault.get_total_managed_assets();

    assert!(t
        .ctrl
        .classify_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));
    assert!(t
        .ctrl
        .settle_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE));

    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before + PREMIUM);
    assert!(!t.oracle.has_pending_outcomes());
}

#[test]
#[should_panic(expected = "Error(Contract, #321)")]
fn test_classify_flight_panics_on_unlisted_flight() {
    let t = setup();
    t.ctrl
        .classify_flight(&t.keeper, &symbol_short!("ZZ999"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #321)")]
fn test_settle_flight_panics_on_unlisted_flight() {
    let t = setup();
    t.ctrl
        .settle_flight(&t.keeper, &symbol_short!("ZZ999"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #321)")]
fn test_classify_flight_panics_on_cancellation_tombstone() {
    // A pre-registration cancellation creates a FlightData tombstone but no
    // active-set entry — the targeted path must reject it exactly like the
    // sweep never sees it (classifying it would strand a ToBeSettled* row
    // with no pool bucket).
    let t = setup();
    t.oracle
        .set_cancelled(&t.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);
    t.ctrl
        .classify_flight(&t.keeper, &symbol_short!("AA100"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #304)")]
fn test_classify_flight_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl
        .classify_flight(&stranger, &symbol_short!("AA100"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #304)")]
fn test_settle_flight_panics_on_non_keeper() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    t.ctrl
        .settle_flight(&stranger, &symbol_short!("AA100"), &FLIGHT_DATE);
}

// =========================================================================
// End-to-end lifecycle
// =========================================================================

#[test]
fn test_end_to_end_delayed_lifecycle() {
    let t = setup();
    let traveler = Address::generate(&t.env);

    buy(&t, &traveler);
    assert_eq!(t.asset.balance(&traveler), 0);

    oracle_delayed(&t);
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    // Traveler claims payoff from FlightPoolManager.
    t.pool
        .claim(&traveler, &symbol_short!("AA100"), &FLIGHT_DATE);

    assert_eq!(t.asset.balance(&traveler), PAYOFF);
    assert!(t
        .pool
        .has_claimed(&symbol_short!("AA100"), &FLIGHT_DATE, &traveler));
}

#[test]
fn test_end_to_end_on_time_lifecycle_no_payout() {
    let t = setup();
    let traveler = Address::generate(&t.env);

    buy(&t, &traveler);
    oracle_on_time(&t);
    t.ctrl.classify_flights(&t.keeper);
    t.ctrl.execute_settlements(&t.keeper);

    // Traveler keeps no asset (already paid premium); on-time = no claim.
    assert_eq!(t.asset.balance(&traveler), 0);

    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledOnTime
    );
}

#[test]
fn test_extend_ttl_is_callable() {
    let t = setup();
    t.ctrl.extend_ttl();
}

// =========================================================================
// Phase 11 — buyer whitelist
// =========================================================================

fn whitelist_admin(t: &TestEnv) -> Address {
    let admin = Address::generate(&t.env);
    t.gov.add_admin(&admin);
    admin
}

#[test]
fn test_whitelist_disabled_by_default() {
    let t = setup();
    assert!(!t.ctrl.whitelist_enabled());
    let stranger = Address::generate(&t.env);
    assert!(!t.ctrl.is_whitelisted(&stranger));
}

#[test]
fn test_whitelist_disabled_allows_any_buyer() {
    // Default state — whitelist off, anyone can buy. Mirrors the baseline
    // happy-path test_buy_insurance_first_traveler_registers_flight.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #306)")]
fn test_whitelist_enabled_blocks_non_whitelisted_buyer() {
    let t = setup();
    t.ctrl.set_whitelist_enabled(&true);
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
}

#[test]
fn test_whitelist_enabled_allows_whitelisted_buyer() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&t.owner, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));

    buy(&t, &traveler);
    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 1);
}

#[test]
fn test_whitelist_toggle_round_trip() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&t.owner, &traveler);
    buy(&t, &traveler);

    // Flip off — strangers can buy again.
    t.ctrl.set_whitelist_enabled(&false);
    assert!(!t.ctrl.whitelist_enabled());
    let stranger = Address::generate(&t.env);
    open_sale(&t, &symbol_short!("AA100"), FLIGHT_DATE + SECONDS_PER_DAY);
    t.asset_admin.mint(&stranger, &PREMIUM);
    t.ctrl.buy_insurance(
        &stranger,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &(FLIGHT_DATE + SECONDS_PER_DAY),
    );
    let (sold, _, _) = t.ctrl.get_stats();
    assert_eq!(sold, 2);
}

#[test]
fn test_gov_admin_can_add_whitelisted_buyer() {
    let t = setup();
    let admin = whitelist_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));

    buy(&t, &traveler);
}

#[test]
#[should_panic(expected = "Error(Contract, #305)")]
fn test_non_admin_add_whitelisted_buyer_panics() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&stranger, &traveler);
}

#[test]
#[should_panic(expected = "Error(Contract, #305)")]
fn test_non_admin_remove_whitelisted_buyer_panics() {
    let t = setup();
    t.ctrl
        .add_whitelisted_buyer(&t.owner, &Address::generate(&t.env));
    let stranger = Address::generate(&t.env);
    let traveler = Address::generate(&t.env);
    t.ctrl.remove_whitelisted_buyer(&stranger, &traveler);
}

#[test]
fn test_remove_whitelisted_buyer_blocks_next_purchase() {
    let t = setup();
    let admin = whitelist_admin(&t);
    let traveler = Address::generate(&t.env);

    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&admin, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));

    t.ctrl.remove_whitelisted_buyer(&admin, &traveler);
    assert!(!t.ctrl.is_whitelisted(&traveler));
}

#[test]
fn test_whitelist_touch_skips_rewrite_within_refresh_interval() {
    // Every gated purchase used to rewrite the approval deadline — a
    // persistent write on the hot path for a deadline that had barely
    // moved. The slide is now skipped while the stored deadline is within
    // the refresh interval of the ideal: an actively-buying address still
    // cannot lapse (the deadline stays within 10 days of now + 180d, far
    // above the dormancy horizon), but most purchases cost no write.
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&t.owner, &traveler);

    let read_deadline = || {
        t.env.as_contract(&t.ctrl_addr, || {
            t.env
                .storage()
                .persistent()
                .get::<_, u64>(&crate::storage::CtrlKey::BuyerApprovalExpiry(
                    traveler.clone(),
                ))
                .unwrap()
        })
    };
    let window = 180 * SECONDS_PER_DAY;
    let approved_at = t.env.ledger().timestamp();
    assert_eq!(read_deadline(), approved_at + window);

    // A touch within the refresh interval leaves the stored deadline alone.
    t.env
        .ledger()
        .with_mut(|l| l.timestamp += 5 * SECONDS_PER_DAY);
    t.env.as_contract(&t.ctrl_addr, || {
        crate::storage::touch_buyer_whitelisted(&t.env, &traveler);
    });
    assert_eq!(read_deadline(), approved_at + window);

    // Past the interval the deadline slides forward again.
    t.env
        .ledger()
        .with_mut(|l| l.timestamp += 6 * SECONDS_PER_DAY);
    t.env.as_contract(&t.ctrl_addr, || {
        crate::storage::touch_buyer_whitelisted(&t.env, &traveler);
    });
    assert_eq!(read_deadline(), approved_at + 11 * SECONDS_PER_DAY + window);
}

#[test]
#[should_panic(expected = "Error(Contract, #306)")]
fn test_removed_buyer_cannot_purchase() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.ctrl.set_whitelist_enabled(&true);
    t.ctrl.add_whitelisted_buyer(&t.owner, &traveler);
    t.ctrl.remove_whitelisted_buyer(&t.owner, &traveler);
    buy(&t, &traveler);
}

#[test]
#[should_panic]
fn test_non_owner_set_whitelist_enabled_panics() {
    // Fresh env, no mock_all_auths — #[only_owner] guard fails for stranger.
    let env = Env::default();
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let asset_admin_addr = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin_addr);

    let gov_addr = env.register(
        governance_module::GovernanceModule,
        (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
    );
    let oracle_addr = env.register(
        oracle_aggregator::OracleAggregator,
        (&owner, &Address::generate(&env)),
    );
    let vault_addr = env.register(
        risk_vault::RiskVault,
        (&owner, &asset_id.address(), &oracle_addr),
    );
    let pool_addr = env.register(
        flight_pool_manager::FlightPoolManager,
        (&owner, &asset_id.address(), &vault_addr),
    );
    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &gov_addr,
            &vault_addr,
            &oracle_addr,
            &pool_addr,
            &asset_id.address(),
            &Address::generate(&env),
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);

    // Stranger cannot toggle. (No mock_all_auths — the only_owner check
    // panics before any internal logic runs.)
    let _ = stranger;
    ctrl.set_whitelist_enabled(&true);
}

#[test]
fn test_owner_can_add_even_when_toggle_off() {
    // Owner can pre-populate the whitelist before flipping the toggle.
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&t.owner, &traveler);
    assert!(t.ctrl.is_whitelisted(&traveler));
    assert!(!t.ctrl.whitelist_enabled());
}

#[test]
fn test_whitelist_events_emitted() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&t.owner, &traveler);

    let mut found_added = false;
    for (event_addr, topics, _data) in collect_events(&t.env).iter() {
        if event_addr != t.ctrl_addr {
            continue;
        }
        if topics.len() < 3 {
            continue;
        }
        let t0 = Symbol::try_from_val(&t.env, &topics.get(0).unwrap()).ok();
        let t1 = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()).ok();
        if t0 == Some(symbol_short!("sentinel"))
            && t1 == Some(Symbol::new(&t.env, "buyer_whitelisted"))
        {
            found_added = true;
            break;
        }
    }
    assert!(found_added, "expected sentinel.buyer_whitelisted event");
}

#[test]
fn test_whitelist_toggled_event_emitted() {
    let t = setup();
    t.ctrl.set_whitelist_enabled(&true);

    let mut found = false;
    for (event_addr, topics, _data) in collect_events(&t.env).iter() {
        if event_addr != t.ctrl_addr {
            continue;
        }
        let t0 = Symbol::try_from_val(&t.env, &topics.get(0).unwrap()).ok();
        let t1 = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()).ok();
        if t0 == Some(symbol_short!("sentinel"))
            && t1 == Some(Symbol::new(&t.env, "whitelist_toggled"))
        {
            found = true;
            break;
        }
    }
    assert!(found, "expected sentinel.whitelist_toggled event");
}

#[test]
fn test_whitelist_removed_event_emitted() {
    let t = setup();
    let traveler = Address::generate(&t.env);
    t.ctrl.add_whitelisted_buyer(&t.owner, &traveler);
    t.ctrl.remove_whitelisted_buyer(&t.owner, &traveler);

    let mut found = false;
    for (event_addr, topics, _data) in collect_events(&t.env).iter() {
        if event_addr != t.ctrl_addr {
            continue;
        }
        if topics.len() < 3 {
            continue;
        }
        let t0 = Symbol::try_from_val(&t.env, &topics.get(0).unwrap()).ok();
        let t1 = Symbol::try_from_val(&t.env, &topics.get(1).unwrap()).ok();
        if t0 == Some(symbol_short!("sentinel")) && t1 == Some(Symbol::new(&t.env, "buyer_removed"))
        {
            found = true;
            break;
        }
    }
    assert!(found, "expected sentinel.buyer_removed event");
}

// =========================================================================
// settle_evicted_flight (owner reconciliation after oracle eviction)
// =========================================================================

// Local mirror of the oracle's FlightData storage key. A contracttype enum
// key encodes as [variant-name, payload...], so a mirror with the same
// variant name and payload produces the identical ledger key — lets these
// tests simulate an archived row by deleting it inside the oracle's context
// (the same technique the oracle's own eviction tests use).
#[soroban_sdk::contracttype]
enum OracleDataKey {
    FlightData(Symbol, u64),
}

fn archive_oracle_row(t: &TestEnv) {
    t.env.as_contract(&t.oracle.address, || {
        t.env
            .storage()
            .persistent()
            .remove(&OracleDataKey::FlightData(
                symbol_short!("AA100"),
                FLIGHT_DATE,
            ));
    });
}

#[test]
fn test_settle_evicted_flight_releases_collateral_and_pool_slot() {
    // Eviction alone frees only the oracle-side slot; the pool bucket and the
    // vault collateral must be released by the owner's follow-up
    // reconciliation, or they stay stranded forever (the flight is outside
    // keeper enumeration). Premiums settle to the vault as income, exactly
    // like a voided flight — never a payout.
    let t = setup();
    let traveler1 = Address::generate(&t.env);
    let traveler2 = Address::generate(&t.env);
    buy(&t, &traveler1);
    buy(&t, &traveler2);

    assert_eq!(t.vault.get_locked_capital(), 2 * PAYOFF);
    assert_eq!(t.asset.balance(&t.pool_addr), 2 * PREMIUM);
    assert_eq!(t.pool.get_active_flight_count(), 1);

    // Simulate the FlightData row archiving, then evict it (owner judgment;
    // the flight never had a public outcome, so the barrier is untouched).
    archive_oracle_row(&t);
    t.oracle
        .evict_missing_flight(&symbol_short!("AA100"), &FLIGHT_DATE, &false);
    assert_eq!(t.oracle.get_active_flights().len(), 0);

    let tma_before = t.vault.get_total_managed_assets();
    t.ctrl
        .settle_evicted_flight(&symbol_short!("AA100"), &FLIGHT_DATE);

    // Collateral released, premiums recognized as vault income, pool bucket
    // settled and its active-list slot freed.
    assert_eq!(t.vault.get_locked_capital(), 0);
    assert_eq!(t.vault.get_total_managed_assets(), tma_before + 2 * PREMIUM);
    assert_eq!(t.asset.balance(&t.pool_addr), 0);
    assert_eq!(t.pool.get_active_flight_count(), 0);
    let cfg = t
        .pool
        .get_flight_config(&symbol_short!("AA100"), &FLIGHT_DATE)
        .unwrap();
    assert_eq!(
        cfg.status,
        flight_pool_manager::SettlementStatus::SettledOnTime
    );

    // Non-repeatable: the bucket is no longer Active.
    assert!(t
        .ctrl
        .try_settle_evicted_flight(&symbol_short!("AA100"), &FLIGHT_DATE)
        .is_err());
}

#[test]
#[should_panic(expected = "Error(Contract, #316)")]
fn test_settle_evicted_flight_refuses_while_data_present() {
    // A flight with a live (or restored) FlightData row is restorable through
    // the normal pipeline — restore-and-settle, never blind void settlement.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    t.ctrl
        .settle_evicted_flight(&symbol_short!("AA100"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #317)")]
fn test_settle_evicted_flight_refuses_while_still_listed() {
    // Data missing but the flight not yet evicted: it is still
    // keeper-enumerable, so the terminal reconciliation must refuse — the
    // correct move at this point is still ledger restoration.
    let t = setup();
    let traveler = Address::generate(&t.env);
    buy(&t, &traveler);
    archive_oracle_row(&t);
    t.ctrl
        .settle_evicted_flight(&symbol_short!("AA100"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #318)")]
fn test_settle_evicted_flight_refuses_unknown_flight() {
    // Never purchased: no pool bucket, nothing to reconcile.
    let t = setup();
    t.ctrl
        .settle_evicted_flight(&symbol_short!("ZZ999"), &FLIGHT_DATE);
}

#[test]
#[should_panic]
fn test_settle_evicted_flight_unauthorized() {
    // Owner-only: a stranger must not be able to force-settle a bucket.
    let env = Env::default();
    // No mock_all_auths — the owner auth check must fail before any
    // cross-contract call is attempted.
    let owner = Address::generate(&env);
    let dummy = Address::generate(&env);
    let ctrl_addr = env.register(
        Controller,
        (
            &owner,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &dummy,
            &MIN_LEAD_TIME,
            &CLAIM_EXPIRY_WINDOW,
        ),
    );
    let ctrl = ControllerClient::new(&env, &ctrl_addr);
    ctrl.settle_evicted_flight(&symbol_short!("AA100"), &FLIGHT_DATE);
}
