use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::auth::extend_instance_ttl;
use crate::constants::BUYER_TTL_LEDGERS;
use crate::events::{ExpiredSwept, PayoutClaimed};
use crate::storage::{extend_flight_ttl, PoolKey};
use crate::{
    Error, FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient,
    SettlementStatus,
};

#[contractimpl]
impl FlightPoolManager {
    /// Buyer claims their payoff after delayed/cancelled settlement.
    ///
    /// Intentionally NOT `#[when_not_paused]`. Claim windows run on
    /// the ledger clock, which keeps advancing during a pause; gating claims
    /// would let an emergency pause silently expire valid, already-funded
    /// payouts that travelers could never recover after unpause. Claiming only
    /// moves funds already earmarked to the rightful policy holder (full auth +
    /// status + window + double-claim checks below), so it is safe to keep open.
    pub fn claim(e: &Env, traveler: Address, flight_id: Symbol, date: u64) {
        traveler.require_auth();
        // Renew the instance alongside every other user-facing path so
        // ongoing claim traffic keeps the contract alive if the TTL cron
        // lapses (mirrors the vault's collect()).
        extend_instance_ttl(e);

        let cfg_key = PoolKey::FlightConfig(flight_id.clone(), date);
        let mut cfg: FlightConfig = e
            .storage()
            .persistent()
            .get(&cfg_key)
            .expect("flight not registered");
        if !(matches!(
            cfg.status,
            SettlementStatus::SettledDelayed | SettlementStatus::SettledCancelled
        )) {
            panic_with_error!(e, Error::FlightNotClaimable);
        }
        if e.ledger().timestamp() >= cfg.claim_expiry {
            panic_with_error!(e, Error::ClaimWindowClosed);
        }

        let buyer_key = PoolKey::Buyer(flight_id.clone(), date, traveler.clone());
        let has_policy: bool = e.storage().persistent().get(&buyer_key).unwrap_or(false);
        if !(has_policy) {
            panic_with_error!(e, Error::NoPolicy);
        }

        let claimed_key = PoolKey::Claimed(flight_id.clone(), date, traveler.clone());
        let already_claimed: bool = e.storage().persistent().get(&claimed_key).unwrap_or(false);
        if already_claimed {
            panic_with_error!(e, Error::AlreadyClaimed);
        }

        e.storage().persistent().set(&claimed_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&claimed_key, BUYER_TTL_LEDGERS, BUYER_TTL_LEDGERS);

        cfg.claimed_count = cfg.claimed_count.checked_add(1).expect("addition overflow");
        e.storage().persistent().set(&cfg_key, &cfg);
        extend_flight_ttl(e, &flight_id, date);

        let asset_addr: Address = e.storage().instance().get(&PoolKey::AssetToken).unwrap();
        let asset = token::Client::new(e, &asset_addr);
        asset.transfer(&e.current_contract_address(), &traveler, &cfg.payoff);

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
        if !(matches!(
            cfg.status,
            SettlementStatus::SettledDelayed | SettlementStatus::SettledCancelled
        )) {
            panic_with_error!(e, Error::FlightNotClaimable);
        }
        if e.ledger().timestamp() <= cfg.claim_expiry {
            panic_with_error!(e, Error::ClaimWindowStillOpen);
        }
        extend_instance_ttl(e);

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
