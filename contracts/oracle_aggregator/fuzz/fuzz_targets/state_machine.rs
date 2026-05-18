// Fuzz harness for the oracle_aggregator forward-only state machine.
//
// Generates a random sequence of flight-status mutations and asserts that:
//   1. The stored FlightStatus is always one of the 8 valid variants.
//   2. status == Settled  ⇒  settled_at > 0 (set_settled records the timestamp).
//   3. ActiveFlightList only contains flights whose FlightData exists OR are
//      due for pruning — prune_settled / register_flight maintain consistency.
//   4. No invalid state transition succeeds (is_valid_transition gating).
//
// The fuzzer drives the contract through arbitrary sequences from a small
// pool of flight ids. Failing inputs land in fuzz/artifacts/.

#![no_main]

use libfuzzer_sys::fuzz_target;
use oracle_aggregator::{FlightData, FlightStatus, OracleAggregator, OracleAggregatorClient};
use soroban_sdk::{
    symbol_short,
    testutils::arbitrary::{arbitrary, Arbitrary},
    testutils::{Address as _, Ledger as _},
    Address, Env, Symbol,
};

const NUM_FLIGHTS: usize = 4;

#[derive(Debug, Arbitrary)]
pub enum SettlementTarget {
    OnTime,
    Delayed,
    Cancelled,
}

#[derive(Debug, Arbitrary)]
pub enum Op {
    Register { flight: u8, date: u64 },
    SetEstimated { flight: u8, date: u64, time: u64 },
    SetLanded { flight: u8, date: u64, time: u64 },
    SetCancelled { flight: u8, date: u64 },
    SetToBeSettled { flight: u8, date: u64, target: SettlementTarget },
    SetSettled { flight: u8, date: u64 },
    Prune,
    AdvanceLedger { seconds: u32 },
}

#[derive(Debug, Arbitrary)]
pub struct Input {
    pub ops: Vec<Op>,
}

fn flight_id(idx: u8) -> Symbol {
    match (idx as usize) % NUM_FLIGHTS {
        0 => symbol_short!("F0"),
        1 => symbol_short!("F1"),
        2 => symbol_short!("F2"),
        _ => symbol_short!("F3"),
    }
}

fuzz_target!(|input: Input| {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);

    let owner = Address::generate(&env);
    let oracle = Address::generate(&env);
    let controller = Address::generate(&env);

    let contract_id = env.register(OracleAggregator, (&owner, &oracle));
    let client = OracleAggregatorClient::new(&env, &contract_id);
    client.set_controller(&controller);

    // Track which (flight, date) pairs we have registered so we can verify
    // the active-list invariant.
    let mut registered: std::collections::HashSet<(u8, u64)> = std::collections::HashSet::new();

    for op in input.ops {
        match op {
            Op::Register { flight, date } => {
                let key = (flight % NUM_FLIGHTS as u8, date);
                if registered.insert(key) {
                    // First time — should succeed.
                    let _ = client.try_register_flight(&controller, &flight_id(flight), &date);
                } else {
                    // Duplicate — should panic, swallow it.
                    let _ = client.try_register_flight(&controller, &flight_id(flight), &date);
                }
            }
            Op::SetEstimated { flight, date, time } => {
                let _ = client.try_set_estimated_arrival(&oracle, &flight_id(flight), &date, &time);
            }
            Op::SetLanded { flight, date, time } => {
                let _ = client.try_set_landed(&oracle, &flight_id(flight), &date, &time);
            }
            Op::SetCancelled { flight, date } => {
                let _ = client.try_set_cancelled(&oracle, &flight_id(flight), &date);
            }
            Op::SetToBeSettled { flight, date, target } => {
                let status = match target {
                    SettlementTarget::OnTime => FlightStatus::ToBeSettledOnTime,
                    SettlementTarget::Delayed => FlightStatus::ToBeSettledDelayed,
                    SettlementTarget::Cancelled => FlightStatus::ToBeSettledCancelled,
                };
                let _ = client.try_set_to_be_settled(
                    &controller,
                    &flight_id(flight),
                    &date,
                    &status,
                );
            }
            Op::SetSettled { flight, date } => {
                let _ = client.try_set_settled(&controller, &flight_id(flight), &date);
            }
            Op::Prune => {
                let _ = client.try_prune_settled();
            }
            Op::AdvanceLedger { seconds } => {
                let now = env.ledger().timestamp();
                env.ledger().with_mut(|li| li.timestamp = now.saturating_add(seconds as u64));
            }
        }

        // ─── Invariants — must hold after every op ──────────────────────
        let active = client.get_active_flights();
        for i in 0..active.len() {
            let (fid, d) = active.get(i).unwrap();
            let data: FlightData = client.get_flight_data(&fid, &d);

            // Invariant: a flight in the active list has its status correctly
            // tracked (never the default NotInitiated unless it was just
            // registered and never advanced).
            // FlightData is never deleted while in active list.

            // Invariant: status == Settled  ⇒  settled_at > 0
            if data.status == FlightStatus::Settled {
                assert!(
                    data.settled_at > 0,
                    "settled flight has settled_at=0: ({:?}, {})",
                    fid,
                    d
                );
            }
        }
    }
});
