#![no_std]

mod auth;
mod events;
mod storage;

use soroban_sdk::{contract, contractimpl, token, Address, Env, Symbol, Vec};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

use auth::{extend_instance_ttl, require_controller};
use events::{
    BuyerAdded, ExpiredSwept, FlightRegistered, FlightSettled, PayoutClaimed, RecoveredWithdrawn,
};
use storage::{extend_flight_ttl, prune_active_list, PoolKey, BUYER_TTL_LEDGERS};

pub use storage::{FlightConfig, SettlementStatus};

#[contract]
pub struct FlightPoolManager;

#[contractimpl]
impl FlightPoolManager {
    pub fn __constructor(e: &Env, owner: Address, usdc_token: Address, risk_vault: Address) {
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&PoolKey::UsdcToken, &usdc_token);
        e.storage()
            .instance()
            .set(&PoolKey::RiskVault, &risk_vault);
        e.storage()
            .instance()
            .set(&PoolKey::RecoveredBalance, &0i128);
    }

    // --- Owner-only ---

    /// Set the authorized controller. One-time write — fails if already set.
    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        assert!(
            !e.storage().instance().has(&PoolKey::Controller),
            "controller already set"
        );
        e.storage()
            .instance()
            .set(&PoolKey::Controller, &controller);
        extend_instance_ttl(e);
    }

    /// Owner withdraws funds credited to RecoveredBalance via sweep_expired.
    /// Transfers USDC from the contract to the owner.
    #[only_owner]
    pub fn withdraw_recovered(e: &Env, amount: i128) {
        assert!(amount > 0, "amount must be positive");
        let recovered: i128 = e
            .storage()
            .instance()
            .get(&PoolKey::RecoveredBalance)
            .unwrap_or(0);
        assert!(amount <= recovered, "exceeds recovered balance");

        let owner = ownable::get_owner(e).expect("owner not set");
        let usdc_addr: Address = e.storage().instance().get(&PoolKey::UsdcToken).unwrap();
        let usdc = token::Client::new(e, &usdc_addr);
        usdc.transfer(&e.current_contract_address(), &owner, &amount);

        e.storage().instance().set(
            &PoolKey::RecoveredBalance,
            &recovered
                .checked_sub(amount)
                .expect("subtraction underflow"),
        );

        RecoveredWithdrawn { owner, amount }.publish(e);
    }

    // --- Controller-only flight lifecycle ---

    /// Register a new flight on first purchase. Stores locked terms.
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

    // --- Controller-only settlement ---

    /// Settle on time: transfer premium*buyer_count to RiskVault as yield.
    pub fn settle_on_time(e: &Env, controller: Address, flight_id: Symbol, date: u64) {
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

        cfg.status = SettlementStatus::SettledOnTime;
        e.storage().persistent().set(&cfg_key, &cfg);
        prune_active_list(e, &flight_id, date);

        if cfg.buyer_count > 0 {
            let total_premium = cfg
                .premium
                .checked_mul(cfg.buyer_count as i128)
                .expect("multiplication overflow");
            let usdc_addr: Address = e.storage().instance().get(&PoolKey::UsdcToken).unwrap();
            let vault_addr: Address = e.storage().instance().get(&PoolKey::RiskVault).unwrap();

            let usdc = token::Client::new(e, &usdc_addr);
            usdc.transfer(&e.current_contract_address(), &vault_addr, &total_premium);

            // record_premium_income is controller-only on the vault. Forward the
            // controller's auth (already present from this call's require_controller)
            // so the vault's auth check sees the same address it has stored.
            let vault_client = risk_vault::RiskVaultClient::new(e, &vault_addr);
            vault_client.record_premium_income(&controller, &total_premium);
        }

        FlightSettled {
            flight_id,
            date,
            status: SettlementStatus::SettledOnTime,
            claim_expiry: 0,
        }
        .publish(e);
    }

    /// Settle delayed: open the claim window. RiskVault top-up handled by
    /// Controller separately (it calls vault.send_payout(self_addr, ...)).
    pub fn settle_delayed(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    ) {
        require_controller(e, &controller);
        Self::settle_with_claim_window(e, flight_id, date, claim_expiry, SettlementStatus::SettledDelayed);
    }

    /// Settle cancelled: identical state shape to settle_delayed.
    pub fn settle_cancelled(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    ) {
        require_controller(e, &controller);
        Self::settle_with_claim_window(e, flight_id, date, claim_expiry, SettlementStatus::SettledCancelled);
    }

    fn settle_with_claim_window(
        e: &Env,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
        new_status: SettlementStatus,
    ) {
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
        assert!(
            claim_expiry > e.ledger().timestamp(),
            "claim_expiry must be in the future"
        );

        cfg.status = new_status.clone();
        cfg.claim_expiry = claim_expiry;
        e.storage().persistent().set(&cfg_key, &cfg);
        extend_flight_ttl(e, &flight_id, date);
        prune_active_list(e, &flight_id, date);

        FlightSettled {
            flight_id,
            date,
            status: new_status,
            claim_expiry,
        }
        .publish(e);
    }

    // --- Traveler claim ---

    /// Buyer claims their payoff after delayed/cancelled settlement.
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
        let has_policy: bool = e
            .storage()
            .persistent()
            .get(&buyer_key)
            .unwrap_or(false);
        assert!(has_policy, "no policy");

        let claimed_key = PoolKey::Claimed(flight_id.clone(), date, traveler.clone());
        let already_claimed: bool = e
            .storage()
            .persistent()
            .get(&claimed_key)
            .unwrap_or(false);
        assert!(!already_claimed, "already claimed");

        e.storage().persistent().set(&claimed_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&claimed_key, BUYER_TTL_LEDGERS, BUYER_TTL_LEDGERS);

        cfg.claimed_count = cfg
            .claimed_count
            .checked_add(1)
            .expect("addition overflow");
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

    // --- Permissionless sweep ---

    /// After claim_expiry, credit unclaimed payouts to RecoveredBalance.
    /// Idempotent: subsequent calls find unclaimed == 0 and return.
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
            &recovered
                .checked_add(unclaimed)
                .expect("addition overflow"),
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

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }

    // --- Read functions ---

    /// Returns `Some(cfg)` if the flight is registered, `None` otherwise.
    /// Caller decides how to handle missing entries — controllers use this
    /// for the "look up; if missing, register" pattern in `buy_insurance`
    /// without forcing a panic + restart.
    pub fn get_flight_config(
        e: &Env,
        flight_id: Symbol,
        date: u64,
    ) -> Option<FlightConfig> {
        e.storage()
            .persistent()
            .get(&PoolKey::FlightConfig(flight_id, date))
    }

    pub fn has_policy(e: &Env, flight_id: Symbol, date: u64, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Buyer(flight_id, date, traveler))
            .unwrap_or(false)
    }

    pub fn has_claimed(e: &Env, flight_id: Symbol, date: u64, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Claimed(flight_id, date, traveler))
            .unwrap_or(false)
    }

    pub fn get_active_flights(e: &Env) -> Vec<(Symbol, u64)> {
        e.storage()
            .instance()
            .get(&PoolKey::ActiveFlightList)
            .unwrap_or(Vec::new(e))
    }

    pub fn get_recovered_balance(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&PoolKey::RecoveredBalance)
            .unwrap_or(0)
    }

    pub fn get_controller(e: &Env) -> Option<Address> {
        e.storage().instance().get(&PoolKey::Controller)
    }

    pub fn get_usdc_token(e: &Env) -> Address {
        e.storage().instance().get(&PoolKey::UsdcToken).unwrap()
    }

    pub fn get_risk_vault(e: &Env) -> Address {
        e.storage().instance().get(&PoolKey::RiskVault).unwrap()
    }
}

#[contractimpl(contracttrait)]
impl Ownable for FlightPoolManager {}

#[cfg(test)]
mod test;
