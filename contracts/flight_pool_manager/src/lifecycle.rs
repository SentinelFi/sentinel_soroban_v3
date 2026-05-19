use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};
use stellar_macros::when_not_paused;

use crate::auth::require_controller;
use crate::events::{BuyerAdded, FlightRegistered};
use crate::storage::{extend_flight_ttl, PoolKey, BUYER_TTL_LEDGERS};
use crate::{FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient, SettlementStatus};

#[contractimpl]
impl FlightPoolManager {
    /// Register a new flight on first purchase. Stores locked terms.
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
        assert!(premium > 0, "premium must be positive");
        assert!(payoff > 0, "payoff must be positive");

        let key = PoolKey::FlightConfig(flight_id.clone(), date);
        let existing: Option<FlightConfig> = e.storage().persistent().get(&key);
        assert!(existing.is_none(), "flight already registered");

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
        extend_flight_ttl(e, &flight_id, date);

        let mut list: Vec<(Symbol, u64)> = e
            .storage()
            .instance()
            .get(&PoolKey::ActiveFlightList)
            .unwrap_or(Vec::new(e));
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
    /// buy_insurance. Premium USDC is expected to have arrived separately
    /// (Controller transfers from traveler before calling this).
    #[when_not_paused]
    pub fn add_buyer(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        buyer: Address,
    ) {
        require_controller(e, &controller);

        let cfg_key = PoolKey::FlightConfig(flight_id.clone(), date);
        let mut cfg: FlightConfig = e
            .storage()
            .persistent()
            .get(&cfg_key)
            .expect("flight not registered");
        assert!(
            cfg.status == SettlementStatus::Active,
            "flight not active"
        );

        let buyer_key = PoolKey::Buyer(flight_id.clone(), date, buyer.clone());
        let existing: Option<bool> = e.storage().persistent().get(&buyer_key);
        assert!(existing.is_none(), "already a buyer");

        e.storage().persistent().set(&buyer_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&buyer_key, BUYER_TTL_LEDGERS, BUYER_TTL_LEDGERS);

        cfg.buyer_count = cfg
            .buyer_count
            .checked_add(1)
            .expect("addition overflow");
        e.storage().persistent().set(&cfg_key, &cfg);
        extend_flight_ttl(e, &flight_id, date);

        BuyerAdded {
            flight_id,
            date,
            buyer,
        }
        .publish(e);
    }
}
