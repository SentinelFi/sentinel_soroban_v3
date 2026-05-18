use super::*;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Events as _, Env, Symbol, TryFromVal, Val,
    Vec as SVec,
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
        let body = match &e.body {
            ContractEventBody::V0(b) => b,
        };
        let mut topics: SVec<Val> = SVec::new(env);
        for sv in body.topics.iter() {
            topics.push_back(Val::try_from_val(env, sv).unwrap());
        }
        let data = Val::try_from_val(env, &body.data).unwrap();
        out.push_back((addr, topics, data));
    }
    out
}

const DEFAULT_PREMIUM: i128 = 50_0000000; // 50 USDC (7 decimals)
const DEFAULT_PAYOFF: i128 = 500_0000000; // 500 USDC
const DEFAULT_DELAY_HOURS: u32 = 3;

fn setup() -> (Env, GovernanceModuleClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let contract_id = env.register(
        GovernanceModule,
        (&owner, &DEFAULT_PREMIUM, &DEFAULT_PAYOFF, &DEFAULT_DELAY_HOURS),
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
fn count_events(env: &Env, addr: &Address, prefix0: Symbol, prefix1: Symbol) -> u32 {
    use soroban_sdk::TryFromVal;
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
            if s0 == prefix0 && s1 == prefix1 {
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
    assert!(count_events(&env, &addr, symbol_short!("gov"), symbol_short!("defaults")) >= 1);

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
        (&owner, &DEFAULT_PREMIUM, &DEFAULT_PAYOFF, &DEFAULT_DELAY_HOURS),
    );
    let client = GovernanceModuleClient::new(&env, &contract_id);

    client.set_defaults(&100_0000000, &1000_0000000, &3);
}

#[test]
#[should_panic(expected = "premium must be positive")]
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
#[should_panic(expected = "payoff must exceed premium")]
fn test_constructor_rejects_payoff_le_premium() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    env.register(
        GovernanceModule,
        (&owner, &DEFAULT_PAYOFF, &DEFAULT_PREMIUM, &DEFAULT_DELAY_HOURS),
    );
}

#[test]
#[should_panic(expected = "delay_hours must be positive")]
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
#[should_panic(expected = "delay_hours must be positive")]
fn test_set_defaults_rejects_zero_delay_hours() {
    let (_env, client, _owner, _addr) = setup();
    client.set_defaults(&DEFAULT_PREMIUM, &DEFAULT_PAYOFF, &0u32);
}

#[test]
#[should_panic(expected = "payoff must exceed premium")]
fn test_set_defaults_rejects_payoff_le_premium() {
    let (_env, client, _owner, _addr) = setup();
    client.set_defaults(&DEFAULT_PAYOFF, &DEFAULT_PREMIUM, &DEFAULT_DELAY_HOURS);
}

#[test]
#[should_panic(expected = "payoff must exceed premium")]
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
#[should_panic(expected = "delay_hours must be positive")]
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
#[should_panic(expected = "payoff must exceed premium")]
fn test_update_route_terms_rejects_invalid_resolved() {
    let (_env, client, owner, _addr) = setup();
    let (flight_id, origin, dest) = route_ids();
    client.whitelist_route(
        &owner, &flight_id, &origin, &dest,
        &None::<i128>, &None::<i128>, &None::<u32>,
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

// =========================================================================
// Admin management
// =========================================================================

#[test]
fn test_add_admin_emits_event() {
    let (env, client, _owner, addr) = setup();
    let admin = Address::generate(&env);

    client.add_admin(&admin);
    assert!(
        count_events(&env, &addr, Symbol::new(&env, "gov"), Symbol::new(&env, "admin_added"))
            >= 1
    );
    assert!(client.is_admin(&admin));
}

#[test]
fn test_remove_admin_emits_event() {
    let (env, client, _owner, addr) = setup();
    let admin = Address::generate(&env);

    client.add_admin(&admin);
    client.remove_admin(&admin);
    assert!(
        count_events(&env, &addr, Symbol::new(&env, "gov"), Symbol::new(&env, "admin_removed"))
            >= 1
    );
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
    assert!(count_events(&env, &addr, symbol_short!("route"), symbol_short!("listed")) >= 1);

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
#[should_panic(expected = "not owner or admin")]
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
    assert!(count_events(&env, &addr, symbol_short!("route"), symbol_short!("disabled")) >= 1);

    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Disabled
    );
}

#[test]
#[should_panic(expected = "route already disabled")]
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
#[should_panic(expected = "route not whitelisted")]
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
    assert!(count_events(&env, &addr, symbol_short!("route"), symbol_short!("enabled")) >= 1);

    match client.route_status(&flight_id, &origin, &dest) {
        RouteStatus::Active(t) => {
            // Custom premium preserved through disable -> enable
            assert_eq!(t.premium, 75_0000000);
        }
        _ => panic!("expected Active after enable"),
    }
}

#[test]
#[should_panic(expected = "route already active")]
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
#[should_panic(expected = "route not whitelisted")]
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
    assert!(count_events(&env, &addr, symbol_short!("route"), symbol_short!("removed")) >= 1);

    // After remove, status is Unknown.
    assert_eq!(
        client.route_status(&flight_id, &origin, &dest),
        RouteStatus::Unknown
    );
}

#[test]
#[should_panic(expected = "route must be disabled before removal")]
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
#[should_panic(expected = "route not whitelisted")]
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
    assert!(count_events(&env, &addr, symbol_short!("route"), symbol_short!("updated")) >= 1);

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
            assert_eq!(t.payoff, 750_0000000);      // custom kept
            assert_eq!(t.delay_hours, 2);            // custom kept
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
            assert_eq!(t.premium, 99_0000000);             // Set
            assert_eq!(t.payoff, 750_0000000);              // Keep (was custom)
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
#[should_panic(expected = "route not whitelisted")]
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
// Re-whitelist overwrites previous terms
// =========================================================================

#[test]
fn test_whitelist_existing_route_overwrites_terms() {
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
