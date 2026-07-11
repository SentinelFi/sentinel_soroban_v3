use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Symbol, Vec};
use stellar_macros::when_not_paused;

use crate::auth::{extend_instance_ttl, require_controller};
use crate::constants::{BUYER_TTL_LEDGERS, MAX_ACTIVE_FLIGHTS};
use crate::events::{BuyerAdded, FlightRegistered};
use crate::storage::{extend_flight_ttl_to, PoolKey};
use crate::{
    Error, FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient,
    SettlementStatus,
};

#[contractimpl]
impl FlightPoolManager {
    /// Register a flight. Idempotent: re-registering the same
    /// `(flight_id, date)` is a no-op when the new terms match the existing
    /// entry, and panics when they would diverge. This lets two travelers
    /// race to the first purchase of a new route in the same ledger without
    /// the second tx reverting.
    #[when_not_paused]
    pub fn register_flight(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        premium: i128,
        payoff: i128,
        delay_hours: u32,
    ) {
        require_controller(e, &controller);
        extend_instance_ttl(e);
        if premium <= 0 {
            panic_with_error!(e, Error::PremiumNotPositive);
        }
        if payoff <= 0 {
            panic_with_error!(e, Error::PayoffNotPositive);
        }
        // Defense in depth. Governance resolves partially-
        // defaulted route terms against MUTABLE defaults, and a later
        // set_defaults can make a route resolve to payoff <= premium without
        // revalidation. Settlement computes `payoff - premium`, which would
        // underflow and brick the flight. Reject such terms here so the bad
        // config can never be stored (the purchase reverts instead).
        if payoff <= premium {
            panic_with_error!(e, Error::PayoffNotAbovePremium);
        }
        // Same defense-in-depth tier as the payoff/premium checks above: a
        // zero threshold would classify every landed flight as delayed
        // (`delay >= 0` always holds), turning the bucket into a guaranteed
        // payout. Governance validates this on its own write paths; reject it
        // here too so no caller-side gap can ever store such a config.
        if delay_hours == 0 {
            panic_with_error!(e, Error::DelayHoursNotPositive);
        }

        let key = PoolKey::FlightConfig(flight_id.clone(), date);
        if let Some(existing) = e.storage().persistent().get::<_, FlightConfig>(&key) {
            // Terms must match — protects against admin route updates between
            // a buyer's tx submission and inclusion changing locked terms
            // under their feet.
            if !(existing.premium == premium
                && existing.payoff == payoff
                && existing.delay_hours == delay_hours)
            {
                panic_with_error!(e, Error::FlightTermsMismatch);
            }
            // Keep the config alive through the flight date
            // (+buffer), not just a flat ~31 days — a flight booked far ahead
            // could otherwise archive before settlement.
            extend_flight_ttl_to(e, &flight_id, date, date);
            return;
        }

        let cfg = FlightConfig {
            premium,
            payoff,
            delay_hours,
            buyer_count: 0,
            claimed_count: 0,
            status: SettlementStatus::Active,
            claim_expiry: 0,
        };
        e.storage().persistent().set(&key, &cfg);
        // Cover the flight date (+buffer) so a far-booked
        // flight's config survives until settlement.
        extend_flight_ttl_to(e, &flight_id, date, date);

        let mut list: Vec<(Symbol, u64)> = e
            .storage()
            .instance()
            .get(&PoolKey::ActiveFlightList)
            .unwrap_or(Vec::new(e));
        // Bound the single-vector active list so it can't grow into the
        // contract-instance entry-size limit and become unwritable. Settled
        // flights are removed on settlement, freeing capacity.
        if list.len() >= MAX_ACTIVE_FLIGHTS {
            panic_with_error!(e, Error::ActiveFlightListFull);
        }
        list.push_back((flight_id.clone(), date));
        e.storage()
            .instance()
            .set(&PoolKey::ActiveFlightList, &list);

        FlightRegistered {
            flight_id,
            date,
            premium,
            payoff,
            delay_hours,
        }
        .publish(e);
    }

    /// Record a buyer for an active flight. Called by Controller during
    /// buy_insurance. Premium asset is expected to have arrived separately
    /// (Controller transfers from traveler before calling this).
    #[when_not_paused]
    pub fn add_buyer(e: &Env, controller: Address, flight_id: Symbol, date: u64, buyer: Address) {
        require_controller(e, &controller);

        let cfg_key = PoolKey::FlightConfig(flight_id.clone(), date);
        let mut cfg: FlightConfig = e
            .storage()
            .persistent()
            .get(&cfg_key)
            .expect("flight not registered");
        if !(cfg.status == SettlementStatus::Active) {
            panic_with_error!(e, Error::FlightNotActive);
        }

        let buyer_key = PoolKey::Buyer(flight_id.clone(), date, buyer.clone());
        let existing: Option<bool> = e.storage().persistent().get(&buyer_key);
        if existing.is_some() {
            panic_with_error!(e, Error::AlreadyBuyer);
        }

        e.storage().persistent().set(&buyer_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&buyer_key, BUYER_TTL_LEDGERS, BUYER_TTL_LEDGERS);

        cfg.buyer_count = cfg.buyer_count.checked_add(1).expect("addition overflow");
        e.storage().persistent().set(&cfg_key, &cfg);
        // Keep config alive through the flight date (+buffer).
        extend_flight_ttl_to(e, &flight_id, date, date);

        BuyerAdded {
            flight_id,
            date,
            buyer,
        }
        .publish(e);
    }
}
