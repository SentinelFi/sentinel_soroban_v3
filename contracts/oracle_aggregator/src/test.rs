use super::*;
use crate::storage::OracleKey;
use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger as _, Address, Env, IntoVal, Symbol,
};

const FLIGHT_DATE: u64 = 1710400000; // arbitrary unix timestamp
const EST_ARRIVAL: u64 = 1710410000;
const ACT_ARRIVAL: u64 = 1710412000;

#[test]
fn version_initialized_to_one() {
    let (_env, client, ..) = setup();
    assert_eq!(client.version(), 1);
}

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
#[should_panic(expected = "Error(Contract, #601)")]
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
#[should_panic(expected = "Error(Contract, #604)")]
fn test_unauthorized_oracle_write() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    // Controller is not the oracle — should fail
    client.set_estimated_arrival(&controller, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
}

#[test]
#[should_panic(expected = "Error(Contract, #605)")]
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
fn test_arrival_timestamps_validated() {
    // Zero is the unset sentinel and an arrival cannot precede the departure
    // day's midnight. The forward-only machine has no correction path, so
    // malformed values are rejected at the door — a zero actual arrival
    // would otherwise saturate the delay math and settle a delayed flight
    // as on-time, denying payouts.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    assert!(client
        .try_set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &0)
        .is_err());
    assert!(client
        .try_set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &(FLIGHT_DATE - 1))
        .is_err());
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);

    assert!(client
        .try_set_landed(&oracle, &fid, &FLIGHT_DATE, &0)
        .is_err());
    assert!(client
        .try_set_landed(&oracle, &fid, &FLIGHT_DATE, &(FLIGHT_DATE - 1))
        .is_err());
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    assert_eq!(
        client
            .get_flight_data(&fid, &FLIGHT_DATE)
            .actual_arrival_time,
        ACT_ARRIVAL
    );
}

#[test]
fn test_arrival_timestamps_upper_bounded() {
    // A unit-confused write — milliseconds where the contract expects
    // seconds — clears every lower bound (a millisecond-scale value is far
    // above any day key) yet corrupts the delay classification just as
    // irreversibly: a ms-scale actual arrival computes to a ~10¹²-second
    // delay and pays every affected flight, while a ms-scale ETA zeroes the
    // saturating delay math and denies every genuinely delayed claim. Both
    // writes therefore also reject arrivals implausibly far past the
    // departure day.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    // The value a buggy backend would actually send, and the exact boundary.
    assert!(client
        .try_set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &(EST_ARRIVAL * 1000))
        .is_err());
    assert!(client
        .try_set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &(FLIGHT_DATE + 3 * 86_400 + 1))
        .is_err());
    // The latest plausible schedule is still accepted...
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &(FLIGHT_DATE + 3 * 86_400));

    assert!(client
        .try_set_landed(&oracle, &fid, &FLIGHT_DATE, &(ACT_ARRIVAL * 1000))
        .is_err());
    assert!(client
        .try_set_landed(
            &oracle,
            &fid,
            &FLIGHT_DATE,
            &(FLIGHT_DATE + 30 * 86_400 + 1)
        )
        .is_err());
    // ...and a days-late real resolution still lands.
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &(FLIGHT_DATE + 30 * 86_400));
}

#[test]
fn test_set_cancelled_before_registration_creates_purchase_blocking_record() {
    // A publicly known cancellation must be recordable BEFORE any purchase
    // registers the flight — otherwise the purchase gate, seeing no record,
    // admits buyers into a flight whose payout is already certain.
    let (env, client, _owner, oracle, _controller) = setup();
    let fid = flight_id(&env);

    // No register_flight call — the flight has no record yet.
    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);

    // The record now reads Cancelled, which the purchase gate rejects.
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Cancelled);

    // No policy exists, so nothing must enter the settlement pipeline: the
    // active list stays empty (classify/settle never see the tombstone) and
    // no pending outcome blocks the vault's entry/exit paths.
    assert_eq!(client.get_active_flights().len(), 0);
    assert_eq!(client.get_pending_outcomes(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #602)")]
fn test_set_cancelled_twice_on_preregistration_record_fails() {
    // The tombstone is a real Cancelled record — the forward-only state
    // machine still rejects a duplicate cancellation.
    let (env, client, _owner, oracle, _controller) = setup();
    let fid = flight_id(&env);

    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
}

#[test]
fn test_register_flight_after_preemptive_cancellation_is_noop() {
    // register_flight is idempotent on an existing record, so a controller
    // registration attempt cannot resurrect a preemptively cancelled flight
    // into the purchasable or settleable state.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Cancelled);
    assert_eq!(client.get_active_flights().len(), 0);
    assert_eq!(client.get_pending_outcomes(), 0);
}

#[test]
fn test_set_cancelled_from_not_initiated_enters_settlement_pipeline() {
    // A registered flight (buyers may exist) cancelled before its ETA was ever
    // set takes the normal pipeline: pending outcome recorded, classifiable,
    // settleable.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);

    assert_eq!(
        client.get_flight_data(&fid, &FLIGHT_DATE).status,
        FlightStatus::Cancelled
    );
    assert_eq!(client.get_active_flights().len(), 1);
    assert_eq!(client.get_pending_outcomes(), 1);

    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledCancelled,
    );
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    assert_eq!(client.get_pending_outcomes(), 0);
}

#[test]
fn test_stale_not_initiated_void_gated_by_timeout() {
    // A registered flight whose data never arrived can be classified straight
    // to ToBeSettledOnTime (the void path) — but only once the stale timeout
    // past departure has elapsed, so a flight the executor merely hasn't
    // fetched yet can never be voided. The void counts as a pending outcome
    // until settled, keeping the vault's settlement barrier consistent.
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    // Before the timeout: rejected.
    assert!(client
        .try_set_to_be_settled(
            &controller,
            &fid,
            &FLIGHT_DATE,
            &FlightStatus::ToBeSettledOnTime,
        )
        .is_err());

    env.ledger()
        .with_mut(|li| li.timestamp = FLIGHT_DATE + 14 * 86_400 + 1);

    // Delayed / cancelled are never valid targets from NotInitiated — a
    // dataless flight must not become payable.
    assert!(client
        .try_set_to_be_settled(
            &controller,
            &fid,
            &FLIGHT_DATE,
            &FlightStatus::ToBeSettledDelayed,
        )
        .is_err());
    assert!(client
        .try_set_to_be_settled(
            &controller,
            &fid,
            &FLIGHT_DATE,
            &FlightStatus::ToBeSettledCancelled,
        )
        .is_err());

    // Past the timeout the void classification lands, counts as pending, and
    // settles normally.
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledOnTime,
    );
    assert_eq!(client.get_pending_outcomes(), 1);
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    assert_eq!(client.get_pending_outcomes(), 0);
}

#[test]
fn test_active_timeout_void_gated_by_timeout() {
    // An Active flight whose terminal outcome never arrives can be classified
    // straight to ToBeSettledOnTime (the void path) — but only once the
    // active timeout past its recorded scheduled arrival has elapsed, so a
    // flight the oracle is merely late in resolving can never be voided. The
    // void counts as a pending outcome until settled, keeping the vault's
    // settlement barrier consistent.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);

    // Before the timeout: rejected.
    env.ledger()
        .with_mut(|li| li.timestamp = EST_ARRIVAL + 14 * 86_400 - 1);
    assert!(client
        .try_set_to_be_settled(
            &controller,
            &fid,
            &FLIGHT_DATE,
            &FlightStatus::ToBeSettledOnTime,
        )
        .is_err());

    env.ledger()
        .with_mut(|li| li.timestamp = EST_ARRIVAL + 14 * 86_400);

    // Delayed / cancelled are never valid targets from Active — a flight
    // without an attested outcome must not become payable.
    assert!(client
        .try_set_to_be_settled(
            &controller,
            &fid,
            &FLIGHT_DATE,
            &FlightStatus::ToBeSettledDelayed,
        )
        .is_err());
    assert!(client
        .try_set_to_be_settled(
            &controller,
            &fid,
            &FLIGHT_DATE,
            &FlightStatus::ToBeSettledCancelled,
        )
        .is_err());

    // Past the timeout the void classification lands, counts as pending, and
    // settles normally.
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledOnTime,
    );
    assert_eq!(client.get_pending_outcomes(), 1);
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    assert_eq!(client.get_pending_outcomes(), 0);
}

// --- Sale authorization (purchase-gate attestation) ---

#[test]
fn test_open_sale_round_trip_and_expiry() {
    let (env, client, _owner, oracle, _controller) = setup();
    let fid = flight_id(&env);

    // No authorization → closed.
    assert!(!client.is_sale_open(&fid, &FLIGHT_DATE));
    assert_eq!(client.get_sale_auth(&fid, &FLIGHT_DATE), None);

    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600);
    assert!(client.is_sale_open(&fid, &FLIGHT_DATE));
    assert_eq!(client.get_sale_auth(&fid, &FLIGHT_DATE), Some(3_600));

    // At the expiry timestamp the window is closed — the stored expiry, not
    // the storage lifetime, is what gates purchases.
    env.ledger().with_mut(|li| li.timestamp = 3_600);
    assert!(!client.is_sale_open(&fid, &FLIGHT_DATE));

    // A refresh re-opens it.
    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &(3_600 + 7_200));
    assert!(client.is_sale_open(&fid, &FLIGHT_DATE));
}

#[test]
fn test_open_sale_validates_expiry() {
    let (env, client, _owner, oracle, _controller) = setup();
    let fid = flight_id(&env);

    // Expiry must be strictly in the future...
    assert!(client
        .try_open_sale(&oracle, &fid, &FLIGHT_DATE, &0)
        .is_err());
    // ...within the max validity cap (24h)...
    assert!(client
        .try_open_sale(&oracle, &fid, &FLIGHT_DATE, &(86_400 + 1))
        .is_err());
    assert!(client
        .try_open_sale(&oracle, &fid, &FLIGHT_DATE, &86_400)
        .is_ok());

    // ...and never past the departure-day boundary.
    env.ledger().with_mut(|li| li.timestamp = FLIGHT_DATE - 100);
    assert!(client
        .try_open_sale(&oracle, &fid, &FLIGHT_DATE, &(FLIGHT_DATE + 1))
        .is_err());
    assert!(client
        .try_open_sale(&oracle, &fid, &FLIGHT_DATE, &FLIGHT_DATE)
        .is_ok());
}

#[test]
fn test_open_sale_allowed_pre_outcome_only() {
    // NotInitiated (registered, no data) and Active rows are attestable;
    // any recorded outcome makes the sale window unopenable.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600);

    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600);

    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    assert!(client
        .try_open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600)
        .is_err());
}

#[test]
#[should_panic(expected = "Error(Contract, #602)")]
fn test_open_sale_panics_on_cancelled_tombstone() {
    // A pre-registration cancellation tombstone must not be overridden by a
    // sale authorization — the flight is dead.
    let (env, client, _owner, oracle, _controller) = setup();
    let fid = flight_id(&env);

    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600);
}

#[test]
fn test_close_sale_removes_authorization() {
    let (env, client, _owner, oracle, _controller) = setup();
    let fid = flight_id(&env);

    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600);
    assert!(client.is_sale_open(&fid, &FLIGHT_DATE));

    client.close_sale(&oracle, &fid, &FLIGHT_DATE);
    assert!(!client.is_sale_open(&fid, &FLIGHT_DATE));
    assert_eq!(client.get_sale_auth(&fid, &FLIGHT_DATE), None);

    // Idempotent — closing an absent window is a silent no-op.
    client.close_sale(&oracle, &fid, &FLIGHT_DATE);
}

#[test]
fn test_close_sale_works_while_paused() {
    // A live sale window stays readable — and purchasable through the
    // controller — regardless of this contract's pause state, so the pause
    // switch must not disable the one write that can revoke it. Pausing
    // still blocks NEW attestations; only the strictly protective close
    // stays open.
    let (env, client, owner, oracle, _controller) = setup();
    let fid = flight_id(&env);
    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600);
    assert!(client.is_sale_open(&fid, &FLIGHT_DATE));

    client.pause(&owner);
    assert!(client
        .try_open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600)
        .is_err());
    client.close_sale(&oracle, &fid, &FLIGHT_DATE);
    assert!(!client.is_sale_open(&fid, &FLIGHT_DATE));
}

#[test]
fn test_set_cancelled_clears_sale_authorization() {
    let (env, client, _owner, oracle, controller) = setup();

    // Registered flight: the cancellation write kills the live window in the
    // same transaction.
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.open_sale(&oracle, &fid, &FLIGHT_DATE, &3_600);
    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
    assert!(!client.is_sale_open(&fid, &FLIGHT_DATE));

    // Unregistered flight: the tombstone write clears the window too.
    let fid2 = symbol_short!("UA200");
    client.open_sale(&oracle, &fid2, &FLIGHT_DATE, &3_600);
    client.set_cancelled(&oracle, &fid2, &FLIGHT_DATE);
    assert!(!client.is_sale_open(&fid2, &FLIGHT_DATE));
}

#[test]
#[should_panic(expected = "Error(Contract, #604)")]
fn test_open_sale_requires_oracle() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);
    client.open_sale(&controller, &fid, &FLIGHT_DATE, &3_600);
}

#[test]
#[should_panic(expected = "Error(Contract, #604)")]
fn test_close_sale_requires_oracle() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);
    client.close_sale(&controller, &fid, &FLIGHT_DATE);
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
#[should_panic(expected = "Error(Contract, #602)")]
fn test_invalid_transition_not_initiated_to_landed() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    // Skip Active — go straight to Landed
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
}

#[test]
#[should_panic(expected = "Error(Contract, #602)")]
fn test_invalid_transition_active_to_settled() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    // Skip Landed + classification — go straight to Settled
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "Error(Contract, #602)")]
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
fn test_set_landed_accepts_early_arrival() {
    // An early arrival (actual < estimated) is a legitimate
    // outcome and must land the flight rather than reverting and leaving it
    // stuck Active. Downstream delay math saturates to zero (on-time).
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &(EST_ARRIVAL - 1));

    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Landed);
    assert_eq!(data.actual_arrival_time, EST_ARRIVAL - 1);
}

#[test]
fn test_not_initiated_to_cancelled_short_notice() {
    // Short-notice cancellation: oracle may learn the flight is cancelled
    // before set_estimated_arrival fires.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_cancelled(&oracle, &fid, &FLIGHT_DATE);
    assert_eq!(
        client.get_flight_data(&fid, &FLIGHT_DATE).status,
        FlightStatus::Cancelled
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #602)")]
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
#[should_panic(expected = "Error(Contract, #603)")]
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
fn test_register_flight_twice_is_idempotent() {
    // Re-registering the same flight is a no-op so a parallel
    // buyer doesn't have their tx revert.
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    // Still NotInitiated, single entry in active list.
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::NotInitiated);
    assert_eq!(client.get_active_flights().len(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #606)")]
fn test_register_flight_rejects_when_active_list_full() {
    // The paginated active set carries an operational sanity cap. The cap
    // gate reads the O(1) stored count, so seed that directly to the cap and
    // confirm one more distinct registration is rejected.
    use crate::constants::MAX_ACTIVE_FLIGHTS;
    use sentinel_types::active_set::ActiveSetKey;
    let (env, client, _owner, _oracle, controller) = setup();

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&ActiveSetKey::ActiveCount, &MAX_ACTIVE_FLIGHTS);
    });

    client.register_flight(&controller, &symbol_short!("ZZ999"), &99_999_999u64);
}

#[test]
fn test_get_active_flights_page_windows_and_bounds() {
    // The paged view is the keeper's bounded enumeration: exact windows
    // inside the set, truncated at the end, empty beyond it.
    let (_env, client, _owner, _oracle, controller) = setup();
    for i in 0..5u64 {
        client.register_flight(&controller, &symbol_short!("AA100"), &(FLIGHT_DATE + i));
    }

    assert_eq!(client.get_active_flight_count(), 5);
    let win = client.get_active_flights_page(&1u32, &3u32);
    assert_eq!(win.len(), 3);
    assert_eq!(win.get(0).unwrap().1, FLIGHT_DATE + 1);
    assert_eq!(win.get(2).unwrap().1, FLIGHT_DATE + 3);
    // Truncated at the end of the set.
    assert_eq!(client.get_active_flights_page(&3u32, &10u32).len(), 2);
    // Degenerate windows are empty, not panics.
    assert_eq!(client.get_active_flights_page(&9u32, &1u32).len(), 0);
    assert_eq!(client.get_active_flights_page(&0u32, &0u32).len(), 0);
}

#[test]
fn test_is_flight_listed_tracks_membership() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);
    assert!(!client.is_flight_listed(&fid, &FLIGHT_DATE));

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    assert!(client.is_flight_listed(&fid, &FLIGHT_DATE));
    assert!(!client.is_flight_listed(&fid, &(FLIGHT_DATE + 1)));

    // Simulate FlightData archival, then evict — membership must read false.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&OracleKey::FlightData(fid.clone(), FLIGHT_DATE));
    });
    client.evict_missing_flight(&fid, &FLIGHT_DATE, &false);
    assert!(!client.is_flight_listed(&fid, &FLIGHT_DATE));
}

#[test]
fn test_active_set_spans_pages_and_swap_removes_across_them() {
    // More flights than one page holds (page size 100): registration must
    // spill onto a second page, enumeration must cover both, and evicting an
    // early entry must swap-move the globally last entry (page 1) into the
    // freed slot (page 0) without losing anything.
    let (env, client, _owner, _oracle, controller) = setup();
    for i in 0..105u64 {
        client.register_flight(&controller, &symbol_short!("AA100"), &(FLIGHT_DATE + i));
    }
    assert_eq!(client.get_active_flight_count(), 105);
    assert_eq!(client.get_active_flights().len(), 105);
    // A window crossing the page boundary reads both pages.
    let win = client.get_active_flights_page(&98u32, &4u32);
    assert_eq!(win.len(), 4);

    // Evict the entry in page 0, slot 3 (owner path requires its FlightData
    // to be missing — simulate archival by deleting the row in-contract).
    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&OracleKey::FlightData(
            symbol_short!("AA100"),
            FLIGHT_DATE + 3,
        ));
    });
    client.evict_missing_flight(&symbol_short!("AA100"), &(FLIGHT_DATE + 3), &false);

    assert_eq!(client.get_active_flight_count(), 104);
    assert!(!client.is_flight_listed(&symbol_short!("AA100"), &(FLIGHT_DATE + 3)));
    // The swap-moved old tail is still enumerable and individually listed.
    assert!(client.is_flight_listed(&symbol_short!("AA100"), &(FLIGHT_DATE + 104)));
    assert_eq!(client.get_active_flights().len(), 104);
}

#[test]
#[should_panic(expected = "restore it before adding")]
fn test_active_set_add_fails_closed_on_archived_tail_page() {
    // An archived tail page must block new registrations, not be silently
    // overwritten: writing a fresh one-entry vector over the archived key
    // would leave that page's flights permanently unenumerable AND
    // unrestorable (restoration needs the key to be dead).
    use sentinel_types::active_set::ActiveSetKey;
    let (env, client, _owner, _oracle, controller) = setup();
    client.register_flight(&controller, &symbol_short!("AA100"), &FLIGHT_DATE);

    // Simulate the tail page archiving past its TTL.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&ActiveSetKey::ActivePage(0));
    });

    client.register_flight(&controller, &symbol_short!("UA200"), &FLIGHT_DATE);
}

#[test]
#[should_panic(expected = "entry already in active set")]
fn test_active_set_add_rejects_duplicate_entry() {
    // Both consumers gate on their own flight entry before calling add; the
    // set still refuses a duplicate outright so a future third consumer (or
    // a refactor that drops the caller-side gate) cannot corrupt the
    // count/index invariants.
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    env.as_contract(&client.address, || {
        sentinel_types::active_set::add(&env, &fid, FLIGHT_DATE);
    });
}

#[test]
#[should_panic(expected = "entry already in active set")]
fn test_active_set_add_rejects_duplicate_when_index_archived() {
    // The reverse index can archive while the page holding the entry stays
    // live (pages are re-extended by every keeper sweep; index lifetimes are
    // sized to the flight date). The append backstop must stay exact in that
    // state — falling back to the page scan `contains` uses — or a second
    // registration would append a duplicate slot, corrupting the count and
    // the swap-remove bookkeeping.
    use sentinel_types::active_set::ActiveSetKey;
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    env.as_contract(&client.address, || {
        // Simulate the index archiving past its TTL while the page survives.
        env.storage()
            .persistent()
            .remove(&ActiveSetKey::ActiveIdx(fid.clone(), FLIGHT_DATE));
        sentinel_types::active_set::add(&env, &fid, FLIGHT_DATE);
    });
}

#[test]
fn test_unpause_restores_oracle_writes() {
    let (env, client, owner, oracle, controller) = setup();
    let fid = flight_id(&env);
    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    client.pause(&owner);
    assert!(client.paused());
    assert!(client
        .try_set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL)
        .is_err());

    client.unpause(&owner);
    assert!(!client.paused());
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    assert_eq!(
        client.get_flight_data(&fid, &FLIGHT_DATE).status,
        FlightStatus::Active
    );
}

#[test]
fn test_prune_settled_cursor_wraps_after_list_shrinks() {
    // The prune cursor persists between calls while the set shrinks as
    // entries are pruned or evicted. A stale cursor at or past the current
    // length must wrap to slot 0 and keep sweeping.
    let (env, client, _owner, oracle, controller) = setup();
    // Nonzero settle time — settled_at == 0 is prune's not-yet-settled
    // sentinel, and the test env's clock starts at 0.
    env.ledger().with_mut(|l| l.timestamp = FLIGHT_DATE);
    for fid in [symbol_short!("AA100"), symbol_short!("UA200")] {
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
    }
    // Age both flights past the settled-retention window, then leave a
    // cursor stranded beyond the 2-entry list.
    env.ledger().with_mut(|l| l.timestamp += 8 * 86_400);
    env.as_contract(&client.address, || {
        env.storage().instance().set(&OracleKey::PruneCursor, &9u32);
    });
    client.prune_settled();
    assert_eq!(client.get_active_flight_count(), 0);
}

#[test]
fn test_active_set_remove_absent_and_stale_index_fallbacks() {
    use sentinel_types::active_set::{self, ActiveSetKey};
    let (env, client, _owner, _oracle, controller) = setup();

    // Removing from an empty set is a clean refusal, not a panic.
    env.as_contract(&client.address, || {
        assert!(!active_set::remove(
            &env,
            &symbol_short!("AA100"),
            FLIGHT_DATE
        ));
    });

    // A stale reverse index pointing at ANOTHER entry's slot must not remove
    // the wrong entry: removal re-validates the index against the page
    // contents and falls back to the scan.
    client.register_flight(&controller, &symbol_short!("AA100"), &FLIGHT_DATE);
    client.register_flight(&controller, &symbol_short!("UA200"), &FLIGHT_DATE);
    env.as_contract(&client.address, || {
        env.storage().persistent().set(
            &ActiveSetKey::ActiveIdx(symbol_short!("AA100"), FLIGHT_DATE),
            &1u32,
        );
        assert!(active_set::remove(
            &env,
            &symbol_short!("AA100"),
            FLIGHT_DATE
        ));
        assert!(active_set::contains(
            &env,
            &symbol_short!("UA200"),
            FLIGHT_DATE
        ));
        assert!(!active_set::contains(
            &env,
            &symbol_short!("AA100"),
            FLIGHT_DATE
        ));
        assert_eq!(active_set::count(&env), 1);
    });
}

#[test]
fn test_paged_read_skips_archived_page_without_losing_count() {
    // An archived page degrades availability, never integrity: enumeration
    // skips it (emitting the page-miss diagnostic) instead of panicking, and
    // the count still reports the entries awaiting restoration.
    use sentinel_types::active_set::ActiveSetKey;
    let (env, client, _owner, _oracle, controller) = setup();
    client.register_flight(&controller, &symbol_short!("AA100"), &FLIGHT_DATE);
    client.register_flight(&controller, &symbol_short!("UA200"), &FLIGHT_DATE);

    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&ActiveSetKey::ActivePage(0));
    });

    let page = client.get_active_flights_page(&0, &10);
    assert_eq!(page.len(), 0);
    assert_eq!(client.get_active_flight_count(), 2);
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

// --- Delayed prune tests ---

const SECONDS_PER_DAY: u64 = 86_400;
const RETENTION_SECONDS: u64 = 7 * SECONDS_PER_DAY;

fn settle_full_lifecycle(
    env: &Env,
    client: &OracleAggregatorClient<'_>,
    oracle: &Address,
    controller: &Address,
    fid: &Symbol,
    date: u64,
) {
    client.register_flight(controller, fid, &date);
    client.set_estimated_arrival(oracle, fid, &date, &EST_ARRIVAL);
    client.set_landed(oracle, fid, &date, &ACT_ARRIVAL);
    client.set_to_be_settled(controller, fid, &date, &FlightStatus::ToBeSettledOnTime);
    client.set_settled(controller, fid, &date);
    let _ = env;
}

#[test]
fn test_set_settled_records_settled_at() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    // Pin the ledger timestamp so we can compare exactly.
    env.ledger().with_mut(|li| li.timestamp = 1_710_500_000);

    settle_full_lifecycle(&env, &client, &oracle, &controller, &fid, FLIGHT_DATE);

    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.status, FlightStatus::Settled);
    assert_eq!(data.settled_at, 1_710_500_000);
}

#[test]
fn test_settled_at_zero_before_settle() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.settled_at, 0);

    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.settled_at, 0);

    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledOnTime,
    );
    // Still not Settled — settled_at remains 0.
    let data = client.get_flight_data(&fid, &FLIGHT_DATE);
    assert_eq!(data.settled_at, 0);
}

#[test]
fn test_prune_settled_after_retention_window() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    env.ledger().with_mut(|li| li.timestamp = 1_710_500_000);
    settle_full_lifecycle(&env, &client, &oracle, &controller, &fid, FLIGHT_DATE);

    // Right after settle: flight stays in the active list.
    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 1);

    // Advance one second past the retention window.
    env.ledger()
        .with_mut(|li| li.timestamp = 1_710_500_000 + RETENTION_SECONDS + 1);

    client.prune_settled();

    // List is now empty.
    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 0);

    // Idempotent: re-call does not panic.
    client.prune_settled();
    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 0);
}

#[test]
fn test_prune_settled_no_op_before_retention_window() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    env.ledger().with_mut(|li| li.timestamp = 1_710_500_000);
    settle_full_lifecycle(&env, &client, &oracle, &controller, &fid, FLIGHT_DATE);

    // Advance only 6 days — still within the retention window.
    env.ledger()
        .with_mut(|li| li.timestamp = 1_710_500_000 + (6 * SECONDS_PER_DAY));

    client.prune_settled();

    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 1);
}

#[test]
fn test_prune_settled_retains_missing_flight_data() {
    // An archived FlightData entry is NOT settled — the flight may still have
    // unresolved settlement riding on it. Prune must keep its active-list
    // entry (so the tuple stays discoverable for recovery), must not panic,
    // and must process other entries normally.
    let (env, client, _owner, _oracle, controller) = setup();
    let fid_a = flight_id(&env);
    let fid_b = symbol_short!("BB200");

    client.register_flight(&controller, &fid_a, &FLIGHT_DATE);
    client.register_flight(&controller, &fid_b, &FLIGHT_DATE);
    assert_eq!(client.get_active_flight_count(), 2);

    // Simulate TTL archival of fid_a's persistent FlightData entry.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&OracleKey::FlightData(fid_a.clone(), FLIGHT_DATE));
    });

    // has_flight_data distinguishes the archived entry from the live one —
    // get_flight_data reports both fid_a (archived) and an unknown flight as
    // NotInitiated.
    assert!(!client.has_flight_data(&fid_a, &FLIGHT_DATE));
    assert!(client.has_flight_data(&fid_b, &FLIGHT_DATE));

    // Prune must not panic and must retain BOTH entries.
    client.prune_settled();
    assert_eq!(client.get_active_flight_count(), 2);
}

#[test]
fn test_evict_missing_flight_owner_path() {
    // Once the operator confirms (off-chain) that an archived flight needs no
    // further resolution, the owner frees its capped-list slot. The eviction
    // is bounded: it refuses flights whose data still exists and unknown
    // tuples.
    let (env, client, _owner, _oracle, controller) = setup();
    let fid_a = flight_id(&env);
    let fid_b = symbol_short!("BB200");

    client.register_flight(&controller, &fid_a, &FLIGHT_DATE);
    client.register_flight(&controller, &fid_b, &FLIGHT_DATE);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&OracleKey::FlightData(fid_a.clone(), FLIGHT_DATE));
    });

    // Live flight cannot be evicted through this path.
    assert!(client
        .try_evict_missing_flight(&fid_b, &FLIGHT_DATE, &false)
        .is_err());

    client.evict_missing_flight(&fid_a, &FLIGHT_DATE, &false);
    let remaining = client.get_active_flights();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining.get(0).unwrap(), (fid_b, FLIGHT_DATE));
    // fid_a never had a public outcome, so the barrier counter is untouched.
    assert_eq!(client.get_pending_outcomes(), 0);

    // Already evicted — no longer in the list.
    assert!(client
        .try_evict_missing_flight(&fid_a, &FLIGHT_DATE, &false)
        .is_err());
}

#[test]
fn test_evict_missing_flight_releases_pending_outcome() {
    // A flight whose outcome was already publicly recorded counts toward
    // PendingOutcomes, and only settlement decrements the counter. If such a
    // flight's data goes missing and the owner evicts it, the eviction must
    // release its count — otherwise the vault's entry/exit barrier would stay
    // engaged forever with no remaining on-chain path to clear it.
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    assert_eq!(client.get_pending_outcomes(), 1);
    assert!(client.has_pending_outcomes());

    // Simulate the flight's FlightData going missing before settlement.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&OracleKey::FlightData(fid.clone(), FLIGHT_DATE));
    });

    client.evict_missing_flight(&fid, &FLIGHT_DATE, &true);
    assert_eq!(client.get_active_flights().len(), 0);
    assert_eq!(client.get_pending_outcomes(), 0);
    assert!(!client.has_pending_outcomes());
}

#[test]
#[should_panic]
fn test_evict_missing_flight_unauthorized() {
    // Eviction frees capped-list capacity after off-chain finality
    // confirmation — an owner-only judgment call. A stranger must not be able
    // to remove entries.
    let env = Env::default();
    // No mock_all_auths — the owner auth check must fail.
    let owner = Address::generate(&env);
    let oracle = Address::generate(&env);
    let contract_id = env.register(OracleAggregator, (&owner, &oracle));
    let client = OracleAggregatorClient::new(&env, &contract_id);

    client.evict_missing_flight(&symbol_short!("AA100"), &FLIGHT_DATE, &false);
}

#[test]
fn test_prune_settled_evicts_aged_settled_while_retaining_missing() {
    // A retained missing-data entry must not stall the sweep: aged-out
    // settled entries around it are still evicted in the same pass, so a
    // stuck recovery case can't pin unrelated capacity.
    let (env, client, _owner, oracle, controller) = setup();
    let f_settled = flight_id(&env);
    let f_archived = symbol_short!("BB200");

    env.ledger().with_mut(|li| li.timestamp = 1_710_500_000);
    settle_full_lifecycle(&env, &client, &oracle, &controller, &f_settled, FLIGHT_DATE);
    client.register_flight(&controller, &f_archived, &FLIGHT_DATE);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&OracleKey::FlightData(f_archived.clone(), FLIGHT_DATE));
    });
    assert_eq!(client.get_active_flight_count(), 2);

    // Past the retention window: the settled flight ages out, the archived
    // one is retained for recovery.
    env.ledger()
        .with_mut(|li| li.timestamp = 1_710_500_000 + RETENTION_SECONDS + 1);
    client.prune_settled();

    let remaining = client.get_active_flights();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining.get(0).unwrap(), (f_archived, FLIGHT_DATE));
}

#[test]
fn test_prune_settled_no_op_when_no_flights_settled() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    // Flight is NotInitiated — should never be pruned regardless of time.

    env.ledger().with_mut(|li| li.timestamp = 9_999_999_999);
    client.prune_settled();

    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 1);
}

#[test]
fn test_prune_settled_only_removes_aged_settled() {
    // Mix: one settled-and-aged-out, one settled-and-recent, one unsettled.
    let (env, client, _owner, oracle, controller) = setup();

    let f1 = symbol_short!("AA100"); // will be settled long ago
    let f2 = symbol_short!("UA200"); // will be settled recently
    let f3 = symbol_short!("DL300"); // never settled
    let date: u64 = FLIGHT_DATE;

    // Settle f1 at t=1000
    env.ledger().with_mut(|li| li.timestamp = 1000);
    settle_full_lifecycle(&env, &client, &oracle, &controller, &f1, date);

    // Settle f2 at t = 1000 + 31 days
    env.ledger()
        .with_mut(|li| li.timestamp = 1000 + (31 * SECONDS_PER_DAY));
    settle_full_lifecycle(
        &env,
        &client,
        &oracle,
        &controller,
        &f2,
        date + 1, // different date so the (id, date) key differs
    );

    // Register f3 (NotInitiated) at t = 1000 + 31d
    client.register_flight(&controller, &f3, &(date + 2));

    // Now at t = 1000 + 31d + a tiny bit later: f1 is 31d aged, f2 is brand new.
    env.ledger()
        .with_mut(|li| li.timestamp = 1000 + (31 * SECONDS_PER_DAY) + 1);

    client.prune_settled();

    // f1 should be evicted (31d > 7d retention).
    // f2 stays (just settled).
    // f3 stays (not settled).
    let flights = client.get_active_flights();
    assert_eq!(flights.len(), 2);
    // Verify f1 is gone, f2 and f3 remain.
    let mut has_f1 = false;
    let mut has_f2 = false;
    let mut has_f3 = false;
    for i in 0..flights.len() {
        let (id, _d) = flights.get(i).unwrap();
        if id == f1 {
            has_f1 = true;
        }
        if id == f2 {
            has_f2 = true;
        }
        if id == f3 {
            has_f3 = true;
        }
    }
    assert!(!has_f1, "f1 (aged out) should have been pruned");
    assert!(has_f2, "f2 (recent) should remain");
    assert!(has_f3, "f3 (unsettled) should remain");
}

// --- Event emission tests ---

#[test]
fn test_event_emitted_on_register() {
    let (env, client, _owner, _oracle, controller) = setup();
    let fid = flight_id(&env);

    client.register_flight(&controller, &fid, &FLIGHT_DATE);

    let events = collect_events(&env);
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);
    let expected_topics = (
        symbol_short!("sentinel"),
        symbol_short!("flight"),
        fid.clone(),
        FLIGHT_DATE,
    )
        .into_val(&env);
    assert_eq!(last.1, expected_topics);
}

#[test]
fn test_event_emitted_on_each_transition() {
    let (env, client, _owner, oracle, controller) = setup();
    let fid = flight_id(&env);

    // Register → check event
    client.register_flight(&controller, &fid, &FLIGHT_DATE);
    let events = collect_events(&env);
    assert!(!events.is_empty());

    // Active → check event
    client.set_estimated_arrival(&oracle, &fid, &FLIGHT_DATE, &EST_ARRIVAL);
    let events = collect_events(&env);
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);

    // Landed → check event
    client.set_landed(&oracle, &fid, &FLIGHT_DATE, &ACT_ARRIVAL);
    let events = collect_events(&env);
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);

    // ToBeSettledOnTime → check event
    client.set_to_be_settled(
        &controller,
        &fid,
        &FLIGHT_DATE,
        &FlightStatus::ToBeSettledOnTime,
    );
    let events = collect_events(&env);
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);

    // Settled → check event
    client.set_settled(&controller, &fid, &FLIGHT_DATE);
    let events = collect_events(&env);
    let last = events.get(events.len() - 1).unwrap();
    assert_eq!(last.0, client.address);
}

#[test]
fn test_extend_ttl_is_callable() {
    let (_env, client, _owner, _oracle, _controller) = setup();
    client.extend_ttl();
}
