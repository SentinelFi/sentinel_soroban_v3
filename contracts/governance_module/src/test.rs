use super::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Env};

const DEFAULT_PREMIUM: i128 = 50_0000000; // 50 USDC
const DEFAULT_PAYOFF: i128 = 500_0000000; // 500 USDC
const DEFAULT_DELAY_HOURS: u32 = 3;

fn setup() -> (Env, GovernanceModuleClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let contract_id = env.register(
        GovernanceModule,
        (&owner, &DEFAULT_PREMIUM, &DEFAULT_PAYOFF, &DEFAULT_DELAY_HOURS),
    );
    let client = GovernanceModuleClient::new(&env, &contract_id);

    (env, client, owner)
}

fn route_ids(_env: &Env) -> (Symbol, Symbol, Symbol) {
    (
        symbol_short!("AA100"),
        symbol_short!("JFK"),
        symbol_short!("LAX"),
    )
}

#[test]
fn test_constructor_and_defaults() {
    let (_env, client, owner) = setup();

    assert_eq!(client.get_owner(), Some(owner));
    let (premium, payoff, delay_hours) = client.get_defaults();
    assert_eq!(premium, DEFAULT_PREMIUM);
    assert_eq!(payoff, DEFAULT_PAYOFF);
    assert_eq!(delay_hours, DEFAULT_DELAY_HOURS);
    assert_eq!(client.get_whitelisted_routes().len(), 0);
}

#[test]
fn test_set_defaults() {
    let (_env, client, _owner) = setup();

    client.set_defaults(&100_0000000, &1000_0000000, &4);

    let (premium, payoff, delay_hours) = client.get_defaults();
    assert_eq!(premium, 100_0000000);
    assert_eq!(payoff, 1000_0000000);
    assert_eq!(delay_hours, 4);
}

#[test]
fn test_whitelist_route_with_defaults() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    assert!(client.is_route_whitelisted(&flight_id, &origin, &dest));
    assert_eq!(client.get_whitelisted_routes().len(), 1);

    let terms = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms.premium, DEFAULT_PREMIUM);
    assert_eq!(terms.payoff, DEFAULT_PAYOFF);
    assert_eq!(terms.delay_hours, DEFAULT_DELAY_HOURS);
}

#[test]
fn test_whitelist_route_with_custom_terms() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &Some(750_0000000i128),
        &Some(1u32),
    );

    let terms = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms.premium, 75_0000000);
    assert_eq!(terms.payoff, 750_0000000);
    assert_eq!(terms.delay_hours, 1);
}

#[test]
fn test_whitelist_route_partial_custom() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

    // Only custom premium, rest use defaults
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &Some(75_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );

    let terms = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms.premium, 75_0000000);
    assert_eq!(terms.payoff, DEFAULT_PAYOFF);
    assert_eq!(terms.delay_hours, DEFAULT_DELAY_HOURS);
}

#[test]
fn test_disable_route() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );
    assert!(client.is_route_whitelisted(&flight_id, &origin, &dest));

    client.disable_route(&owner, &flight_id, &origin, &dest);
    assert!(!client.is_route_whitelisted(&flight_id, &origin, &dest));

    // Route still in list (not removed, just disabled)
    assert_eq!(client.get_whitelisted_routes().len(), 1);
}

#[test]
fn test_update_route_terms() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

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
        &Some(80_0000000i128),
        &Some(800_0000000i128),
        &Some(4u32),
    );

    let terms = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms.premium, 80_0000000);
    assert_eq!(terms.payoff, 800_0000000);
    assert_eq!(terms.delay_hours, 4);
}

#[test]
fn test_admin_can_whitelist() {
    let (env, client, _owner) = setup();
    let admin = Address::generate(&env);
    let (flight_id, origin, dest) = route_ids(&env);

    client.add_admin(&admin);
    assert!(client.is_admin(&admin));

    client.whitelist_route(
        &admin,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    assert!(client.is_route_whitelisted(&flight_id, &origin, &dest));
}

#[test]
fn test_admin_can_disable_and_update() {
    let (env, client, owner) = setup();
    let admin = Address::generate(&env);
    let (flight_id, origin, dest) = route_ids(&env);

    client.add_admin(&admin);

    // Owner whitelists
    client.whitelist_route(
        &owner,
        &flight_id,
        &origin,
        &dest,
        &None::<i128>,
        &None::<i128>,
        &None::<u32>,
    );

    // Admin updates terms
    client.update_route_terms(
        &admin,
        &flight_id,
        &origin,
        &dest,
        &Some(60_0000000i128),
        &None::<i128>,
        &None::<u32>,
    );

    let terms = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms.premium, 60_0000000);

    // Admin disables
    client.disable_route(&admin, &flight_id, &origin, &dest);
    assert!(!client.is_route_whitelisted(&flight_id, &origin, &dest));
}

#[test]
fn test_remove_admin() {
    let (env, client, _owner) = setup();
    let admin = Address::generate(&env);

    client.add_admin(&admin);
    assert!(client.is_admin(&admin));

    client.remove_admin(&admin);
    assert!(!client.is_admin(&admin));
}

#[test]
#[should_panic(expected = "not owner or admin")]
fn test_unauthorized_whitelist() {
    let (env, client, _owner) = setup();
    let stranger = Address::generate(&env);
    let (flight_id, origin, dest) = route_ids(&env);

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

#[test]
#[should_panic]
fn test_unauthorized_set_defaults() {
    let env = Env::default();
    // No mock_all_auths — auth will fail
    let owner = Address::generate(&env);
    let contract_id = env.register(
        GovernanceModule,
        (&owner, &DEFAULT_PREMIUM, &DEFAULT_PAYOFF, &DEFAULT_DELAY_HOURS),
    );
    let client = GovernanceModuleClient::new(&env, &contract_id);

    client.set_defaults(&100_0000000, &1000_0000000, &3);
}

#[test]
#[should_panic(expected = "route is disabled")]
fn test_get_terms_disabled_route() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

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

    // Should panic — route is disabled
    client.get_route_terms(&flight_id, &origin, &dest);
}

#[test]
fn test_multiple_routes() {
    let (_env, client, owner) = setup();

    let r1 = (symbol_short!("AA100"), symbol_short!("JFK"), symbol_short!("LAX"));
    let r2 = (symbol_short!("UA200"), symbol_short!("SFO"), symbol_short!("ORD"));

    client.whitelist_route(&owner, &r1.0, &r1.1, &r1.2, &None::<i128>, &None::<i128>, &None::<u32>);
    client.whitelist_route(&owner, &r2.0, &r2.1, &r2.2, &Some(100_0000000i128), &Some(1000_0000000i128), &None::<u32>);

    assert_eq!(client.get_whitelisted_routes().len(), 2);

    let terms1 = client.get_route_terms(&r1.0, &r1.1, &r1.2);
    assert_eq!(terms1.premium, DEFAULT_PREMIUM);

    let terms2 = client.get_route_terms(&r2.0, &r2.1, &r2.2);
    assert_eq!(terms2.premium, 100_0000000);
    assert_eq!(terms2.payoff, 1000_0000000);
    assert_eq!(terms2.delay_hours, DEFAULT_DELAY_HOURS);
}

#[test]
fn test_whitelist_same_route_twice_no_duplicate() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

    client.whitelist_route(&owner, &flight_id, &origin, &dest, &None::<i128>, &None::<i128>, &None::<u32>);
    client.whitelist_route(&owner, &flight_id, &origin, &dest, &Some(75_0000000i128), &None::<i128>, &None::<u32>);

    // Should not duplicate in route list
    assert_eq!(client.get_whitelisted_routes().len(), 1);

    // Should have updated terms
    let terms = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms.premium, 75_0000000);
}

#[test]
fn test_defaults_change_affects_resolution() {
    let (env, client, owner) = setup();
    let (flight_id, origin, dest) = route_ids(&env);

    // Whitelist with no custom terms (uses defaults)
    client.whitelist_route(&owner, &flight_id, &origin, &dest, &None::<i128>, &None::<i128>, &None::<u32>);

    let terms_before = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms_before.premium, DEFAULT_PREMIUM);

    // Change defaults
    client.set_defaults(&100_0000000, &1000_0000000, &4);

    // Resolution should now use new defaults
    let terms_after = client.get_route_terms(&flight_id, &origin, &dest);
    assert_eq!(terms_after.premium, 100_0000000);
    assert_eq!(terms_after.payoff, 1000_0000000);
    assert_eq!(terms_after.delay_hours, 4);
}
