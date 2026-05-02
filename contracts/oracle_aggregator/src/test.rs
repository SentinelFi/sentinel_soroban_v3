use super::*;
use soroban_sdk::{symbol_short, testutils::Address as _, testutils::Events as _, Env, IntoVal};

const FLIGHT_DATE: u64 = 1710400000; // arbitrary unix timestamp
const EST_ARRIVAL: u64 = 1710410000;
const ACT_ARRIVAL: u64 = 1710412000;

fn setup() -> (
    Env,
    OracleAggregatorClient<'static>,
    Address, // owner
    Address, // oracle
    Address, // controller
) {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let oracle = Address::generate(&env);
    let controller = Address::generate(&env);

    let contract_id = env.register(OracleAggregator, (&owner, &oracle));
    let client = OracleAggregatorClient::new(&env, &contract_id);

    client.set_controller(&controller);

    (env, client, owner, oracle, controller)
}

fn flight_id(env: &Env) -> Symbol {
    let _ = env;
    symbol_short!("AA100")
}

// --- Initialization & authorization tests ---

#[test]
fn test_constructor() {
    let (_env, client, owner, oracle, controller) = setup();

    assert_eq!(client.get_owner(), Some(owner));
    assert_eq!(client.get_authorized_oracle(), oracle);
    assert_eq!(client.get_authorized_controller(), Some(controller));
}

#[test]
fn test_set_oracle_updates_address() {
    let (env, client, _owner, _oracle, _controller) = setup();
    let new_oracle = Address::generate(&env);

    client.set_oracle(&new_oracle);
    assert_eq!(client.get_authorized_oracle(), new_oracle);
}

#[test]
#[should_panic(expected = "controller already set")]
fn test_set_controller_twice_fails() {
    let (env, client, _owner, _oracle, _controller) = setup();
    let new_controller = Address::generate(&env);

    // Controller already set in setup — second call should fail
    client.set_controller(&new_controller);
}

#[test]
#[should_panic]
fn test_unauthorized_set_controller() {
    let env = Env::default();
    // No mock_all_auths
    let owner = Address::generate(&env);
    let oracle = Address::generate(&env);
    let controller = Address::generate(&env);

    let contract_id = env.register(OracleAggregator, (&owner, &oracle));
    let client = OracleAggregatorClient::new(&env, &contract_id);

    // Should fail — no auth
    client.set_controller(&controller);
}

#[test]
#[should_panic]
fn test_unauthorized_set_oracle() {
    let env = Env::default();
    // No mock_all_auths
    let owner = Address::generate(&env);
    let oracle = Address::generate(&env);

    let contract_id = env.register(OracleAggregator, (&owner, &oracle));
    let client = OracleAggregatorClient::new(&env, &contract_id);

    let new_oracle = Address::generate(&env);
    client.set_oracle(&new_oracle);
}

#[test]
#[should_panic(expected = "not authorized oracle")]
fn test_unauthorized_oracle_write() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    // Controller is not the oracle — should fail
    client.set_estimated_arrival(&controller, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
}

#[test]
#[should_panic(expected = "not authorized controller")]
fn test_unauthorized_controller_write() {
    let (env, client, _owner, oracle, _controller) = setup();
    let fid = flight_id(&env);

    // Oracle is not the controller — should fail
    client.register_flight(&oracle, &fid, &FLIGHT_DATE);
}

// --- Full state machine happy path ---

#[test]
fn test_full_lifecycle_on_time() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    // Register → NotInitiated
    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::NotInitiated);
    assert_eq!(data.estimated_arrival_time, 0);
    assert_eq!(data.actual_arrival_time, 0);

    // Set estimated arrival → Active
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Active);
    assert_eq!(data.estimated_arrival_time, EST_ARRIVAL);

    // Set landed → Landed
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Landed);
    assert_eq!(data.actual_arrival_time, ACT_ARRIVAL);

    // Classify as on-time → ToBeSettledOnTime
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledOnTime,
    );
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::ToBeSettledOnTime);

    // Settle → Settled
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Settled);
}

#[test]
fn test_full_lifecycle_delayed() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);

    // Classify as delayed
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledDelayed,
    );
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::ToBeSettledDelayed);

    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Settled);
}

#[test]
fn test_full_lifecycle_cancelled() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);

    // Cancel from Active
    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Cancelled);
    assert_eq!(data.actual_arrival_time, 0); // not set for cancelled

    // Classify
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledCancelled,
    );
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::ToBeSettledCancelled);

    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Settled);
}

// --- Invalid transition tests ---

#[test]
#[should_panic(expected = "invalid transition")]
fn test_invalid_transition_not_initiated_to_landed() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    // Skip Active — go straight to Landed
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
}

#[test]
#[should_panic(expected = "invalid transition")]
fn test_invalid_transition_active_to_settled() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    // Skip Landed + classification — go straight to Settled
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "invalid transition")]
fn test_invalid_transition_landed_to_settled() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    // Skip classification — go straight to Settled
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "invalid transition")]
fn test_invalid_transition_not_initiated_to_cancelled() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    // Can't cancel from NotInitiated — must be Active first
    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "invalid transition")]
fn test_invalid_transition_landed_to_settled_cancelled() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    // Landed → ToBeSettledCancelled is invalid (should be OnTime or Delayed)
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledCancelled,
    );
}

#[test]
#[should_panic(expected = "invalid settlement status")]
fn test_set_to_be_settled_with_non_settlement_status() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    // Pass Active as status — not a valid settlement status
    client.set_to_be_settled(&controller, &fid, &FLIGHT_DATE, &FlightStatus::Active);
}

#[test]
#[should_panic(expected = "flight already registered")]
fn test_register_flight_twice() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);
}

// --- Read function tests ---

#[test]
fn test_get_flight_data_missing_returns_default() {
    let (env, client, _owner, _oracle, _controller) = setup();
    let fid = flight_id(&env);

    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::NotInitiated);
    assert_eq!(data.estimated_arrival_time, 0);
    assert_eq!(data.actual_arrival_time, 0);
}

#[test]
fn test_get_active_flights() {
    let (_env, client, _owner, _oracle, controller) = setup();

    let f1 = symbol_short!("AA100");
    let f2 = symbol_short!("UA200");
    let date1: u64 = 1710400000;
    let date2: u64 = 1710500000;

    client.register_flight(&controller, &f1, &date1);
    client.register_flight(&controller, &f2, &date2);

    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 2);
    assert_eq!(flights.get(0), Some((f1, date1)));
    assert_eq!(flights.get(1), Some((f2, date2)));
}

#[test]
fn test_get_flights_by_status() {
    let (_env, client, _owner, oracle, controller) = setup();

    let f1 = symbol_short!("AA100");
    let f2 = symbol_short!("UA200");
    let f3 = symbol_short!("DL300");
    let date: u64 = FLIGHT_DATE;

    client.register_flight(&controller, &f1, &date);
    client.register_flight(&controller, &f2, &date);
    client.register_flight(&controller, &f3, &date);

    // Move f1 to Active
    client.set_estimated_arrival(&oracle, &f1, &date, &EST_ARRIVAL);
    // Move f2 to Landed
    client.set_estimated_arrival(&oracle, &f2, &date, &EST_ARRIVAL);
    client.set_landed(&oracle, &f2, &date, &ACT_ARRIVAL);
    // f3 stays NotInitiated

    let not_initiated = client.get_flights_by_status(&FlightStatus::NotInitiated);
    assert_eq!(not_initiated.len(), 1);
    assert_eq!(not_initiated.get(0), Some((f3, date)));

    let active = client.get_flights_by_status(&FlightStatus::Active);
    assert_eq!(active.len(), 1);
    assert_eq!(active.get(0), Some((f1, date)));

    let landed = client.get_flights_by_status(&FlightStatus::Landed);
    assert_eq!(landed.len(), 1);
    assert_eq!(landed.get(0), Some((f2, date)));

    let settled = client.get_flights_by_status(&FlightStatus::Settled);
    assert_eq!(settled.len(), 0);
}

#[test]
fn test_active_flights_not_removed_on_settlement() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledOnTime,
    );
    client.set_settled(&controller, &fid, &FLIGHT_DATE);

    // Flight should still be in active list
    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 1);

    // But filterable as Settled
    let settled = client.get_flights_by_status(&FlightStatus::Settled);
    assert_eq!(settled.len(), 1);
}

// --- Event emission tests ---

#[test]
fn test_event_emitted_on_register() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    let events = env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);
    let expected_topics = (symbol_short!("flight"), fid.clone(), FLIGHT_DATE).into_val(&env);
    assert_eq!(last.1, expected_topics);
}

#[test]
fn test_event_emitted_on_each_transition() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    // Register → check event
    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    let events = env.events().all();
    assert!(events.len() > 0);

    // Active → check event
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    let events = env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);

    // Landed → check event
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    let events = env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);

    // ToBeSettledOnTime → check event
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledOnTime,
    );
    let events = env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);

    // Settled → check event
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    let events = env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);
}
