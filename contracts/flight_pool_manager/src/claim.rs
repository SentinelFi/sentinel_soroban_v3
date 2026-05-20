use soroban_sdk::{contractimpl, token, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::events::{ExpiredSwept, PayoutClaimed};
use crate::storage::{extend_flight_ttl, PoolKey, BUYER_TTL_LEDGERS};
use crate::{
    FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient,
    SettlementStatus,
};

#[contractimpl]
impl FlightPoolManager {
    /// Buyer claims their payoff after delayed/cancelled settlement.
    #[when_not_paused]
    pub fn claim(e: &Env, traveler: Address, flight_id: Symbol, date: u64) {
        traveler.require_auth();

        let cfg_key = PoolKey::FlightConfig(flight_id.clone(), date);
        let mut cfg: FlightConfig = e
            .storage()
            .persistent()
            .get(&cfg_key)
            .expect("flight not registered");
        assert!(
            matches!(
                cfg.status,
                SettlementStatus::SettledDelayed | SettlementStatus::SettledCancelled
            ),
            "flight not in claimable status"
        );
        assert!(
            e.ledger().timestamp() < cfg.claim_expiry,
            "claim window closed"
        );

        let buyer_key = PoolKey::Buyer(flight_id.clone(), date, traveler.clone());
        let has_policy: bool = e.storage().persistent().get(&buyer_key).unwrap_or(false);
        assert!(has_policy, "no policy");

        let claimed_key = PoolKey::Claimed(flight_id.clone(), date, traveler.clone());
        let already_claimed: bool = e.storage().persistent().get(&claimed_key).unwrap_or(false);
        assert!(!already_claimed, "already claimed");

        e.storage().persistent().set(&claimed_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&claimed_key, BUYER_TTL_LEDGERS, BUYER_TTL_LEDGERS);

        cfg.claimed_count = cfg.claimed_count.checked_add(1).expect("addition overflow");
        e.storage().persistent().set(&cfg_key, &cfg);
        extend_flight_ttl(e, &flight_id, date);

        let usdc_addr: Address = e.storage().instance().get(&PoolKey::UsdcToken).unwrap();
        let usdc = token::Client::new(e, &usdc_addr);
        usdc.transfer(&e.current_contract_address(), &traveler, &cfg.payoff);

        PayoutClaimed {
            flight_id,
            date,
            traveler,
            amount: cfg.payoff,
        }
        .publish(e);
    }

    /// After claim_expiry, credit unclaimed payouts to RecoveredBalance.
    /// Idempotent: subsequent calls find unclaimed == 0 and return.
    #[when_not_paused]
    pub fn sweep_expired(e: &Env, flight_id: Symbol, date: u64) {
        let cfg_key = PoolKey::FlightConfig(flight_id.clone(), date);
        let mut cfg: FlightConfig = e
            .storage()
            .persistent()
            .get(&cfg_key)
            .expect("flight not registered");
        assert!(
            matches!(
                cfg.status,
                SettlementStatus::SettledDelayed | SettlementStatus::SettledCancelled
            ),
            "flight not in claimable status"
        );
        assert!(
            e.ledger().timestamp() > cfg.claim_expiry,
            "claim window still open"
        );

        let unclaimed_buyers = cfg
            .buyer_count
            .checked_sub(cfg.claimed_count)
            .expect("subtraction underflow") as i128;
        let unclaimed = cfg
            .payoff
            .checked_mul(unclaimed_buyers)
            .expect("multiplication overflow");
        if unclaimed == 0 {
            return;
        }

        let recovered: i128 = e
            .storage()
            .instance()
            .get(&PoolKey::RecoveredBalance)
            .unwrap_or(0);
        e.storage().instance().set(
            &PoolKey::RecoveredBalance,
            &recovered.checked_add(unclaimed).expect("addition overflow"),
        );

        // Mark fully-swept by setting claimed_count = buyer_count so re-entry
        // computes unclaimed = 0. No separate Swept flag needed.
        cfg.claimed_count = cfg.buyer_count;
        e.storage().persistent().set(&cfg_key, &cfg);

        ExpiredSwept {
            flight_id,
            date,
            unclaimed,
        }
        .publish(e);
    }
}
