use soroban_sdk::{contractimpl, Address, Env, Symbol, Vec};
use stellar_macros::when_not_paused;

use crate::auth::require_controller;
use crate::events::{BuyerAdded, FlightRegistered};
use crate::storage::{extend_flight_ttl, PoolKey, BUYER_TTL_LEDGERS};
use crate::{FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient, SettlementStatus};

#[contractimpl]
impl FlightPoolManager {
    /// Register a flight. Idempotent: re-registering the same
    /// `(flight_id, date)` is a no-op when the new terms match the existing
    /// entry, and panics when they would diverge. This lets two travelers
    /// race to the first purchase of a new route in the same ledger without
    /// the second tx reverting (audit M-05).
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
        if let Some(existing) = e.storage().persistent().get::<_, FlightConfig>(&key) {
            // Terms must match — protects against admin route updates between
            // a buyer's tx submission and inclusion changing locked terms
            // under their feet.
            assert!(
                existing.premium == premium
                    && existing.payoff == payoff
                    && existing.delay_hours == delay_hours,
                "flight already registered with different terms",
            );
            extend_flight_ttl(e, &flight_id, date);
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
