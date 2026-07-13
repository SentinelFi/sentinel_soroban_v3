use super::*;
use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger as _, Address, Env, Symbol,
};

const DEFAULT_PREMIUM: i128 = 50_0000000; // 50 asset (7 decimals)
const DEFAULT_PAYOFF: i128 = 500_0000000; // 500 asset
const DEFAULT_DELAY_HOURS: u32 = 3;

#[test]
fn version_initialized_to_one() {
    let (_env, gov, ..) = setup();
    assert_eq!(gov.version(), 1);
}

fn setup() -> (Env, GovernanceModuleClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let contract_id = env.register(
        GovernanceModule,
        (
            &owner,
            &DEFAULT_PREMIUM,
            &DEFAULT_PAYOFF,
            &DEFAULT_DELAY_HOURS,
        ),
    );
    let client = GovernanceModuleClient::new(&env, &contract_id);

    (env, client, owner, contract_id)
}

fn route_ids() -> (Symbol, Symbol, Symbol) {
    (
        symbol_short!("AA100"),
        symbol_short!("JFK"),
        symbol_short!("LAX"),
    )
}

// Count events on `addr` whose first TWO topics match (`prefix0`, `prefix1`).
// Governance events use the 2-element prefix scheme (e.g. ["route", "listed"]).
//
// IMPORTANT: `env.events().all()` returns events only from the MOST RECENT
// contract invocation. Call this helper IMMEDIATELY after the emitting call,
// before any other contract call (including reads like `route_status()`).
// Match against the post-`"sentinel"` topic verb (namespace, 2-item prefix).
// Callers pass a single combined verb like `Symbol::new(env, "route_listed")`.
fn count_events_with_verb(env: &Env, addr: &Address, verb: Symbol) -> u32 {
    use soroban_sdk::TryFromVal;
    let sentinel = symbol_short!("sentinel");
    let mut count: u32 = 0;
    for (event_addr, topics, _data) in collect_events(env).iter() {
        if event_addr != *addr {
            continue;
        }
        if topics.len() < 2 {
            continue;
        }
        let t0 = topics.get(0).unwrap();
        let t1 = topics.get(1).unwrap();
        let s0 = Symbol::try_from_val(env, &t0);
        let s1 = Symbol::try_from_val(env, &t1);
        if let (Ok(s0), Ok(s1)) = (s0, s1) {
            if s0 == sentinel && s1 == verb {
                count += 1;
            }
        }
    }
    count
}

// =========================================================================
// Constructor & defaults
// =========================================================================

#[test]
fn test_constructor_and_defaults() {
    let (_env, client, owner, _addr) = setup();

    assert_eq!(client.get_owner(), Some(owner));
    let (premium, payoff, delay_hours) = client.get_defaults();
    assert_eq!(premium, DEFAULT_PREMIUM);
    assert_eq!(payoff, DEFAULT_PAYOFF);
    assert_eq!(delay_hours, DEFAULT_DELAY_HOURS);
}

#[test]
fn test_set_defaults_emits_event() {
    let (env, client, _owner, addr) = setup();

    client.set_defaults(&100_0000000, &1000_0000000, &4);
    // Event check FIRST — the next contract call clears the event log.
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "gov_defaults")) >= 1);

    let (premium, payoff, delay_hours) = client.get_defaults();
    assert_eq!(premium, 100_0000000);
    assert_eq!(payoff, 1000_0000000);
    assert_eq!(delay_hours, 4);
}

#[test]
#[should_panic]
fn test_set_defaults_unauthorized() {
    let env = Env::default();
    // No mock_all_auths — owner auth will fail.
    let owner = Address::generate(&env);
    let contract_id = env.register(
        GovernanceModule,
        (
            &owner,
            &DEFAULT_PREMIUM,
            &DEFAULT_PAYOFF,
            &DEFAULT_DELAY_HOURS,
        ),
    );
    let client = GovernanceModuleClient::new(&env, &contract_id);

    client.set_defaults(&100_0000000, &1000_0000000, &3);
}

#[test]
#[should_panic(expected = "Error(Contract, #501)")]
fn test_constructor_rejects_zero_premium() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    env.register(
        GovernanceModule,
        (&owner, &0i128, &DEFAULT_PAYOFF, &DEFAULT_DELAY_HOURS),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #503)")]
fn test_constructor_rejects_payoff_le_premium() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    env.register(
        GovernanceModule,
        (
            &owner,
            &DEFAULT_PAYOFF,
            &DEFAULT_PREMIUM,
            &DEFAULT_DELAY_HOURS,
        ),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #504)")]
fn test_constructor_rejects_zero_delay_hours() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    env.register(
        GovernanceModule,
        (&owner, &DEFAULT_PREMIUM, &DEFAULT_PAYOFF, &0u32),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #504)")]
fn test_set_defaults_rejects_zero_delay_hours() {
    let (_env, client, _owner, _addr) = setup();
    client.set_defaults(&DEFAULT_PREMIUM, &DEFAULT_PAYOFF, &0u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #503)")]
fn test_set_defaults_rejects_payoff_le_premium() {
    let (_env, client, _owner, _addr) = setup();
    client.set_defaults(&DEFAULT_PAYOFF, &DEFAULT_PREMIUM, &DEFAULT_DELAY_HOURS);
}

#[test]
#[should_panic(expected = "Error(Contract, #503)")]
fn test_whitelist_route_rejects_payoff_le_premium() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(100_0000000i128),
        &Some(50_0000000i128),
        &None::<u32>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #504)")]
fn test_whitelist_route_rejects_zero_delay_hours() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &Some(0u32),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #503)")]
fn test_update_route_terms_rejects_invalid_resolved() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    // After update: premium=1000 (Set), payoff=defaults=500 → 500 < 1000.
    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::Set(1000_0000000i128),
        &PayoffUpdate::UseDefault,
        &DelayHoursUpdate::Keep,
    );
}

#[test]
fn test_route_status_disabled_when_defaults_make_terms_invalid() {
    // A partially-defaulted route that is valid when written can be made
    // economically invalid by a later defaults change.
    // route_status must stop reporting it as Active so the controller rejects
    // the buy cleanly instead of advertising an unsellable route.
    let (env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    // Custom premium (400), payoff inherits the default (500). Valid: 500 > 400.
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(400_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );
    assert!(matches!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Active(_)
    ));

    // Drop the default payoff below the route's custom premium. The new defaults
    // are internally consistent (300 > 50) so set_defaults succeeds, but the
    // route now resolves to premium=400, payoff=300 — invalid.
    client.set_defaults(&50_0000000, &300_0000000, &DEFAULT_DELAY_HOURS);

    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Disabled
    );
    let _ = env;
}

#[test]
#[should_panic(expected = "Error(Contract, #503)")]
fn test_enable_route_rejects_invalid_resolved_terms() {
    // enable_route revalidates resolved terms against current defaults: a route
    // that became invalid via a defaults change cannot be re-activated until its
    // terms (or the defaults) are fixed.
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    // premium=400 custom, payoff inherits default 500 → valid.
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(400_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &flight_id, &origin, &dest);

    // Drop the default payoff below the route's custom premium → resolves to
    // payoff(300) <= premium(400).
    client.set_defaults(&50_0000000, &300_0000000, &DEFAULT_DELAY_HOURS);

    // Re-enabling the now-invalid route must be rejected.
    client.enable_route(&owner, &flight_id, &origin, &dest);
}

// =========================================================================
// Term limits (magnitude bounds on route economics)
// =========================================================================

#[test]
fn test_term_limits_defaults_and_setter() {
    let (env, client, _owner, addr) = setup();
    // Ships with the unit-free ratio bound on and the absolute cap off.
    assert_eq!(client.get_term_limits(), (0, 100));

    client.set_term_limits(&1000_0000000i128, &20i128);
    // Event check FIRST — the next contract call clears the event log.
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "gov_term_limits")) >= 1);
    assert_eq!(client.get_term_limits(), (1000_0000000, 20));
}

#[test]
#[should_panic(expected = "Error(Contract, #514)")]
fn test_whitelist_route_rejects_payoff_ratio_above_default_limit() {
    // A dust premium with an outsized payoff must be rejected even before
    // the owner configures explicit limits: the default ratio bound caps
    // payoff at 100x premium from genesis.
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(1i128),
        &Some(500_0000000i128),
        &None::<u32>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #513)")]
fn test_whitelist_route_rejects_payoff_above_absolute_cap() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.set_term_limits(&300_0000000i128, &100i128);
    // Payoff resolves to the 500 default, above the 300 cap.
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #514)")]
fn test_update_route_terms_rejects_ratio_violation() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    // Premium dropped to 1 stroop: the resolved payoff (500 default) now
    // exceeds 100x premium.
    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::Set(1i128),
        &PayoffUpdate::Keep,
        &DelayHoursUpdate::Keep,
    );
}

#[test]
fn test_route_status_disabled_when_limits_lowered_below_route() {
    // Lowering the limits retroactively de-lists oversized routes: the route
    // entry survives, but route_status stops advertising it as Active, so
    // the controller rejects purchases cleanly.
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    assert!(matches!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Active(_)
    ));

    // Cap (100) now sits below the route's resolved payoff (500).
    client.set_term_limits(&100_0000000i128, &100i128);
    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Disabled
    );
}

#[test]
fn test_terms_valid_tracks_current_limits() {
    // The controller re-validates a pool bucket's snapshotted terms through
    // this view before admitting new buyers: terms valid under the old
    // limits must flip to invalid the moment the owner lowers them, and the
    // defaults-independent economics checks apply too.
    let (_env, client, _owner, _addr) = setup();
    let terms = ResolvedTerms {
        premium: 10_0000000,
        payoff: 50_0000000,
        delay_hours: 3,
    };
    assert!(client.terms_valid(&terms));

    // Cap lowered below the payoff → the same terms are no longer sellable.
    client.set_term_limits(&20_0000000i128, &5i128);
    assert!(!client.terms_valid(&terms));

    // Compliant terms pass under the new limits.
    assert!(client.terms_valid(&ResolvedTerms {
        premium: 10_0000000,
        payoff: 20_0000000,
        delay_hours: 3,
    }));

    // Economically invalid shapes are rejected regardless of limits.
    assert!(!client.terms_valid(&ResolvedTerms {
        premium: 10_0000000,
        payoff: 10_0000000,
        delay_hours: 3,
    }));
    assert!(!client.terms_valid(&ResolvedTerms {
        premium: 10_0000000,
        payoff: 20_0000000,
        delay_hours: 0,
    }));
}

#[test]
#[should_panic(expected = "Error(Contract, #515)")]
fn test_set_term_limits_rejects_negative_cap() {
    let (_env, client, _owner, _addr) = setup();
    client.set_term_limits(&-1i128, &100i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #515)")]
fn test_set_term_limits_rejects_ratio_below_two() {
    // A ratio below 2 would reject every valid route, since payoff must
    // strictly exceed premium.
    let (_env, client, _owner, _addr) = setup();
    client.set_term_limits(&0i128, &1i128);
}

#[test]
#[should_panic]
fn test_set_term_limits_unauthorized() {
    let env = Env::default();
    // No mock_all_auths — owner auth will fail.
    let owner = Address::generate(&env);
    let contract_id = env.register(
        GovernanceModule,
        (
            &owner,
            &DEFAULT_PREMIUM,
            &DEFAULT_PAYOFF,
            &DEFAULT_DELAY_HOURS,
        ),
    );
    let client = GovernanceModuleClient::new(&env, &contract_id);
    client.set_term_limits(&1000_0000000i128, &50i128);
}

// =========================================================================
// Admin management
// =========================================================================

#[test]
fn test_add_admin_emits_event() {
    let (env, client, _owner, addr) = setup();
    let admin = Address::generate(&env);

    client.add_admin(&admin);
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "gov_admin_added")) >= 1);
    assert!(client.is_admin(&admin));
}

#[test]
fn test_remove_admin_emits_event() {
    let (env, client, _owner, addr) = setup();
    let admin = Address::generate(&env);

    client.add_admin(&admin);
    client.remove_admin(&admin);
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "gov_admin_removed")) >= 1);
    assert!(!client.is_admin(&admin));
}

// =========================================================================
// whitelist_route + route_status (Active / Disabled / Unknown)
// =========================================================================

#[test]
fn test_whitelist_with_defaults_route_status_active() {
    let (env, client, owner, addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "route_listed")) >= 1);

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, DEFAULT_PREMIUM);
            assert_eq!(t.payoff, DEFAULT_PAYOFF);
            assert_eq!(t.delay_hours, DEFAULT_DELAY_HOURS);
        }
        _ => panic!("expected Active"),
    }
}

#[test]
fn test_whitelist_with_custom_terms() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &Some(750_0000000i128),
        &Some(1u32),
    );

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, 75_0000000);
            assert_eq!(t.payoff, 750_0000000);
            assert_eq!(t.delay_hours, 1);
        }
        _ => panic!("expected Active"),
    }
}

#[test]
fn test_whitelist_partial_custom_uses_defaults_for_rest() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, 75_0000000);
            assert_eq!(t.payoff, DEFAULT_PAYOFF);
            assert_eq!(t.delay_hours, DEFAULT_DELAY_HOURS);
        }
        _ => panic!("expected Active"),
    }
}

#[test]
fn test_route_status_unknown_when_not_whitelisted() {
    let (_env, client, _owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Unknown
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #509)")]
fn test_unauthorized_whitelist() {
    let (env, client, _owner, _addr) = setup();
    let stranger = Address::generate(&env);
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &stranger,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
}

// =========================================================================
// disable_route / enable_route
// =========================================================================

#[test]
fn test_disable_route_status_disabled_event_fires() {
    let (env, client, owner, addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &flight_id, &origin, &dest);
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "route_disabled")) >= 1);

    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Disabled
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #506)")]
fn test_disable_already_disabled_panics() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &flight_id, &origin, &dest);
    client.disable_route(&owner, &flight_id, &origin, &dest);
}

#[test]
#[should_panic(expected = "Error(Contract, #511)")]
fn test_disable_unknown_panics() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.disable_route(&owner, &flight_id, &origin, &dest);
}

#[test]
fn test_enable_after_disable_returns_to_active() {
    let (env, client, owner, addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &flight_id, &origin, &dest);
    client.enable_route(&owner, &flight_id, &origin, &dest);
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "route_enabled")) >= 1);

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            // Custom premium preserved through disable -> enable
            assert_eq!(t.premium, 75_0000000);
        }
        _ => panic!("expected Active after enable"),
    }
}

#[test]
#[should_panic(expected = "Error(Contract, #507)")]
fn test_enable_already_active_panics() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.enable_route(&owner, &flight_id, &origin, &dest);
}

#[test]
#[should_panic(expected = "Error(Contract, #511)")]
fn test_enable_unknown_panics() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.enable_route(&owner, &flight_id, &origin, &dest);
}

// =========================================================================
// remove_route — strict (must be disabled first)
// =========================================================================

#[test]
fn test_remove_route_after_disable() {
    let (env, client, owner, addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &flight_id, &origin, &dest);
    client.remove_route(&owner, &flight_id, &origin, &dest);
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "route_removed")) >= 1);

    // After remove, status is Unknown.
    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Unknown
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #508)")]
fn test_remove_active_route_panics() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    // Strict: cannot remove active route.
    client.remove_route(&owner, &flight_id, &origin, &dest);
}

#[test]
#[should_panic(expected = "Error(Contract, #511)")]
fn test_remove_unknown_panics() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.remove_route(&owner, &flight_id, &origin, &dest);
}

#[test]
fn test_rewhitelist_after_remove() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &flight_id, &origin, &dest);
    client.remove_route(&owner, &flight_id, &origin, &dest);

    // Re-whitelisting after removal works and starts fresh.
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            // Fresh entry: previous custom premium gone, falls to default.
            assert_eq!(t.premium, DEFAULT_PREMIUM);
        }
        _ => panic!("expected Active"),
    }
}

// =========================================================================
// update_route_terms — partial update with per-field op enums
// =========================================================================

#[test]
fn test_update_keep_keep_keep_no_change() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &Some(750_0000000i128),
        &Some(2u32),
    );

    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::Keep,
        &PayoffUpdate::Keep,
        &DelayHoursUpdate::Keep,
    );

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, 75_0000000);
            assert_eq!(t.payoff, 750_0000000);
            assert_eq!(t.delay_hours, 2);
        }
        _ => panic!("expected Active"),
    }
}

#[test]
fn test_update_set_set_set_emits_event() {
    let (env, client, owner, addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::Set(80_0000000),
        &PayoffUpdate::Set(800_0000000),
        &DelayHoursUpdate::Set(4),
    );
    assert!(count_events_with_verb(&env, &addr, Symbol::new(&env, "route_updated")) >= 1);

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, 80_0000000);
            assert_eq!(t.payoff, 800_0000000);
            assert_eq!(t.delay_hours, 4);
        }
        _ => panic!("expected Active"),
    }
}

#[test]
fn test_update_use_default_clears_override() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    // Start with custom values.
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &Some(750_0000000i128),
        &Some(2u32),
    );

    // Clear premium override; leave payoff & delay alone.
    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::UseDefault,
        &PayoffUpdate::Keep,
        &DelayHoursUpdate::Keep,
    );

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, DEFAULT_PREMIUM); // resolved from default
            assert_eq!(t.payoff, 750_0000000); // custom kept
            assert_eq!(t.delay_hours, 2); // custom kept
        }
        _ => panic!("expected Active"),
    }
}

#[test]
fn test_update_set_keep_use_default_mixed() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &Some(750_0000000i128),
        &Some(2u32),
    );

    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::Set(99_0000000),
        &PayoffUpdate::Keep,
        &DelayHoursUpdate::UseDefault,
    );

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, 99_0000000); // Set
            assert_eq!(t.payoff, 750_0000000); // Keep (was custom)
            assert_eq!(t.delay_hours, DEFAULT_DELAY_HOURS); // UseDefault
        }
        _ => panic!("expected Active"),
    }
}

#[test]
fn test_update_all_use_default_falls_back_to_resolved_defaults() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &Some(750_0000000i128),
        &Some(2u32),
    );
    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::UseDefault,
        &PayoffUpdate::UseDefault,
        &DelayHoursUpdate::UseDefault,
    );

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            assert_eq!(t.premium, DEFAULT_PREMIUM);
            assert_eq!(t.payoff, DEFAULT_PAYOFF);
            assert_eq!(t.delay_hours, DEFAULT_DELAY_HOURS);
        }
        _ => panic!("expected Active"),
    }
}

#[test]
#[should_panic(expected = "Error(Contract, #511)")]
fn test_update_unknown_panics() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.update_route_terms(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::Set(80_0000000),
        &PayoffUpdate::Keep,
        &DelayHoursUpdate::Keep,
    );
}

// =========================================================================
// Admin can perform owner-or-admin functions
// =========================================================================

#[test]
fn test_admin_can_whitelist_disable_enable_remove_update() {
    let (env, client, _owner, _addr) = setup();
    let admin = Address::generate(&env);
    let (flight_id, origin, dest) = route_ids();

    client.add_admin(&admin);

    client.whitelist_route(
        &admin,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    assert!(matches!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Active(_)
    ));

    client.update_route_terms(
        &admin,
        &flight_id,
        &origin,
        &dest,
        &PremiumUpdate::Set(60_0000000),
        &PayoffUpdate::Keep,
        &DelayHoursUpdate::Keep,
    );
    if let RouteStatus::Active(t) = client.route_status(&flight_id, &origin, &dest) {
        assert_eq!(t.premium, 60_0000000);
    } else {
        panic!("expected Active");
    }

    client.disable_route(&admin, &flight_id, &origin, &dest);
    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Disabled
    );

    client.enable_route(&admin, &flight_id, &origin, &dest);
    assert!(matches!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Active(_)
    ));

    client.disable_route(&admin, &flight_id, &origin, &dest);
    client.remove_route(&admin, &flight_id, &origin, &dest);
    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Unknown
    );
}

// =========================================================================
// Defaults change affects resolution at read time (UseDefault routes update)
// =========================================================================

#[test]
fn test_defaults_change_affects_use_default_routes_at_read_time() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    // Whitelist with all defaults.
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    if let RouteStatus::Active(t) = client.route_status(&flight_id, &origin, &dest) {
        assert_eq!(t.premium, DEFAULT_PREMIUM);
    } else {
        panic!("expected Active");
    }

    // Change defaults; route_status resolution should reflect new defaults
    // immediately (no per-route update needed).
    client.set_defaults(&100_0000000, &1000_0000000, &4);

    if let RouteStatus::Active(t) = client.route_status(&flight_id, &origin, &dest) {
        assert_eq!(t.premium, 100_0000000);
        assert_eq!(t.payoff, 1000_0000000);
        assert_eq!(t.delay_hours, 4);
    } else {
        panic!("expected Active");
    }
}

// =========================================================================
// Multiple routes (no shared state cross-route)
// =========================================================================

#[test]
fn test_multiple_routes_independent() {
    let (_env, client, owner, _addr) = setup();

    let r1 = (
        symbol_short!("AA100"),
        symbol_short!("JFK"),
        symbol_short!("LAX"),
    );
    let r2 = (
        symbol_short!("UA200"),
        symbol_short!("SFO"),
        symbol_short!("ORD"),
    );

    client.whitelist_route(
        &owner,
        &r1.0,
        &r1.1,
        &r1.2,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.whitelist_route(
        &owner,
        &r2.0,
        &r2.1,
        &r2.2,
        &Some(100_0000000i128),
        &Some(1000_0000000i128),
        &None::<u32>,
    );

    if let RouteStatus::Active(t1) = client.route_status(&r1.0, &r1.1, &r1.2) {
        assert_eq!(t1.premium, DEFAULT_PREMIUM);
    } else {
        panic!("r1 should be Active");
    }
    if let RouteStatus::Active(t2) = client.route_status(&r2.0, &r2.1, &r2.2) {
        assert_eq!(t2.premium, 100_0000000);
        assert_eq!(t2.payoff, 1000_0000000);
        assert_eq!(t2.delay_hours, DEFAULT_DELAY_HOURS);
    } else {
        panic!("r2 should be Active");
    }

    // Disable r1 — r2 unaffected.
    client.disable_route(&owner, &r1.0, &r1.1, &r1.2);
    assert_eq!(
        client.route_status(&r1.0, &r1.1, &r1.2),
        RouteStatus::Disabled
    );
    assert!(matches!(
        client.route_status(&r2.0, &r2.1, &r2.2),
        RouteStatus::Active(_)
    ));
}

// =========================================================================
// One (origin, dest) per flight_id
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #505)")]
fn test_whitelist_route_rejects_conflicting_flight_id() {
    // Downstream pool/oracle state keys on (flight_id, date) only, so a flight_id
    // must map to a single route. A second route with the same flight_id but a
    // different origin/dest is rejected.
    let (_env, client, owner, _addr) = setup();
    client.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.whitelist_route(
        &owner,
        &symbol_short!("AA100"),
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
}

#[test]
fn test_remove_route_frees_flight_id_mapping_after_retirement() {
    // Removing a route frees its flight_id for a different (origin, dest) —
    // but only after the retirement window, so downstream (flight_id, date)
    // state written under the old route can no longer be live when the id is
    // remapped.
    let (env, client, owner, _addr) = setup();
    let fid = symbol_short!("AA100");
    client.whitelist_route(
        &owner,
        &fid,
        &symbol_short!("JFK"),
        &symbol_short!("LAX"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &fid, &symbol_short!("JFK"), &symbol_short!("LAX"));
    client.remove_route(&owner, &fid, &symbol_short!("JFK"), &symbol_short!("LAX"));

    // Once the longest possible downstream policy lifetime has elapsed, a
    // different route may take over the flight_id.
    let now = env.ledger().timestamp();
    env.ledger()
        .with_mut(|li| li.timestamp = now + 160 * 86_400 + 1);
    client.whitelist_route(
        &owner,
        &fid,
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    assert!(matches!(
        client.route_status(&fid, &symbol_short!("SFO"), &symbol_short!("ORD")),
        RouteStatus::Active(_)
    ));
}

// =========================================================================
// Re-whitelist overwrites previous terms
// =========================================================================

#[test]
#[should_panic(expected = "Error(Contract, #512)")]
fn test_whitelist_existing_route_with_different_terms_rejected() {
    // whitelist_route only CREATES listings: re-listing with different term
    // overrides must not silently replace the stored ones (an admin passing
    // `None`s for an intended no-op re-approve would otherwise reset every
    // override to default-tracking). Term changes go through
    // update_route_terms.
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #512)")]
fn test_whitelist_disabled_route_rejected() {
    // Re-approving a disabled route must go through enable_route (which
    // revalidates resolved terms), not through a fresh whitelist call.
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &flight_id, &origin, &dest);
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
}

#[test]
fn test_whitelist_identical_relisting_is_idempotent() {
    // The exact re-listing (same overrides, still approved) stays allowed as
    // a TTL-refreshing no-op, so operational re-attestation scripts don't
    // have to special-case already-listed routes.
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );

    if let RouteStatus::Active(t) = client.route_status(&flight_id, &origin, &dest) {
        assert_eq!(t.premium, 75_0000000);
    } else {
        panic!("expected Active");
    }
}

#[test]
fn test_extend_ttl_is_callable() {
    let (_env, client, _owner, _addr) = setup();
    client.extend_ttl();
}

// =========================================================================
// Route / uniqueness-index consistency and flight-id retirement
// =========================================================================

#[test]
fn test_route_status_rejects_route_when_index_points_elsewhere() {
    // If the uniqueness index maps the flight_id to a different origin/dest
    // (divergence after an index-TTL lapse), the stale route entry must not
    // be advertised: selling it would collide downstream (flight_id, date)
    // state with the index owner's.
    let (env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Simulate the index archiving while the route entry survives.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&crate::storage::DataKey::FlightRoute(fid.clone()));
    });

    // With no index, a conflicting route can be whitelisted — it claims the id.
    client.whitelist_route(
        &owner,
        &fid,
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // The old route is now a stale duplicate: not purchasable. The index
    // owner resolves normally.
    assert_eq!(
        client.route_status(&fid, &origin, &dest),
        RouteStatus::Unknown
    );
    assert!(matches!(
        client.route_status(&fid, &symbol_short!("SFO"), &symbol_short!("ORD")),
        RouteStatus::Active(_)
    ));
}

#[test]
fn test_route_status_heals_missing_index() {
    // If the index archived while the route stayed live, a committed
    // route_status read recreates it — after which a conflicting whitelist is
    // rejected again instead of silently splitting the flight_id.
    let (env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&crate::storage::DataKey::FlightRoute(fid.clone()));
    });

    assert!(matches!(
        client.route_status(&fid, &origin, &dest),
        RouteStatus::Active(_)
    ));

    // The healed index re-guards the flight_id.
    assert!(client
        .try_whitelist_route(
            &owner,
            &fid,
            &symbol_short!("SFO"),
            &symbol_short!("ORD"),
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        )
        .is_err());
}

#[test]
fn test_route_status_heals_missing_index_for_disabled_route() {
    // Healing must not depend on approval state: a disabled route still owns
    // its flight_id, and a committed status read recreates a lapsed index so
    // no conflicting route can claim the id while this one is merely paused.
    let (env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &fid, &origin, &dest);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&crate::storage::DataKey::FlightRoute(fid.clone()));
    });

    assert_eq!(
        client.route_status(&fid, &origin, &dest),
        RouteStatus::Disabled
    );

    // The healed index re-guards the flight_id.
    assert!(client
        .try_whitelist_route(
            &owner,
            &fid,
            &symbol_short!("SFO"),
            &symbol_short!("ORD"),
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        )
        .is_err());
}

#[test]
fn test_enable_route_heals_missing_index_and_rejects_conflict() {
    let (env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &fid, &origin, &dest);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&crate::storage::DataKey::FlightRoute(fid.clone()));
    });

    // Enabling with the index absent recreates it from this route...
    client.enable_route(&owner, &fid, &origin, &dest);
    assert!(client
        .try_whitelist_route(
            &owner,
            &fid,
            &symbol_short!("SFO"),
            &symbol_short!("ORD"),
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        )
        .is_err());

    // ...but if another route claimed the id in the meantime, re-enabling the
    // old one is rejected instead of colliding the two.
    client.disable_route(&owner, &fid, &origin, &dest);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&crate::storage::DataKey::FlightRoute(fid.clone()));
    });
    client.whitelist_route(
        &owner,
        &fid,
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    assert!(client
        .try_enable_route(&owner, &fid, &origin, &dest)
        .is_err());
}

#[test]
fn test_removed_flight_id_reserved_against_remapping() {
    // Removing a route reserves its flight_id: downstream policy/oracle state
    // is keyed by (flight_id, date) only, so remapping to a different physical
    // route while old policies can still be live would collide their records.
    let (env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &fid, &origin, &dest);
    client.remove_route(&owner, &fid, &origin, &dest);

    // A different origin/dest is blocked during the retirement window.
    assert!(client
        .try_whitelist_route(
            &owner,
            &fid,
            &symbol_short!("SFO"),
            &symbol_short!("ORD"),
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        )
        .is_err());

    // After the longest possible downstream policy lifetime, the id frees up.
    let now = env.ledger().timestamp();
    env.ledger()
        .with_mut(|li| li.timestamp = now + 160 * 86_400 + 1);
    client.whitelist_route(
        &owner,
        &fid,
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
}

#[test]
fn test_removed_route_can_be_readded_during_retirement() {
    // Re-adding the IDENTICAL route (undoing a removal) is safe — downstream
    // state keyed by the flight_id belongs to the same physical route.
    let (_env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &fid, &origin, &dest);
    client.remove_route(&owner, &fid, &origin, &dest);

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    assert!(matches!(
        client.route_status(&fid, &origin, &dest),
        RouteStatus::Active(_)
    ));
}

#[test]
fn test_remove_route_reserves_flight_id_even_when_index_lapsed() {
    // The retirement reservation must not depend on the uniqueness index
    // surviving: an absent index means it lapsed while this route entry
    // survived, and this route was its last known owner. Downstream
    // (flight_id, date) policies sold under the removed route may still be
    // live, so the id must stay reserved against remapping either way.
    let (env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    client.disable_route(&owner, &fid, &origin, &dest);

    // Simulate the index archiving while the route entry survives.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&crate::storage::DataKey::FlightRoute(fid.clone()));
    });

    client.remove_route(&owner, &fid, &origin, &dest);

    // A different origin/dest is still blocked during the retirement window.
    assert!(client
        .try_whitelist_route(
            &owner,
            &fid,
            &symbol_short!("SFO"),
            &symbol_short!("ORD"),
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        )
        .is_err());

    // Re-adding the identical route stays allowed.
    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
}

#[test]
fn test_remove_stale_route_leaves_current_owner_unaffected() {
    // Removing a stale duplicate (the index points at a DIFFERENT route that
    // has since claimed the flight_id) must neither delete the current
    // owner's index nor reserve the id against the current owner.
    let (env, client, owner, _addr) = setup();
    let (fid, origin, dest) = route_ids();

    client.whitelist_route(
        &owner,
        &fid,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    // Index lapses; a conflicting route claims the id.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&crate::storage::DataKey::FlightRoute(fid.clone()));
    });
    client.whitelist_route(
        &owner,
        &fid,
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Remove the stale duplicate.
    client.disable_route(&owner, &fid, &origin, &dest);
    client.remove_route(&owner, &fid, &origin, &dest);

    // The current owner is untouched: still purchasable, and re-listing it
    // is not blocked by any retirement marker.
    assert!(matches!(
        client.route_status(&fid, &symbol_short!("SFO"), &symbol_short!("ORD")),
        RouteStatus::Active(_)
    ));
    client.whitelist_route(
        &owner,
        &fid,
        &symbol_short!("SFO"),
        &symbol_short!("ORD"),
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
}
