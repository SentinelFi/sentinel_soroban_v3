#![no_std]
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, token, Address, Env, Symbol};

// --- Storage keys ---

#[contracttype]
pub enum PoolKey {
    Controller,
    FlightId,
    Date,
    Premium,
    Payoff,
    DelayHours,
    UsdcToken,
    RiskVault,
    RecoveryPool,
    BuyerCount,
    Buyer(Address),
    Claimed(Address),
    Settled,
    ClaimExpiry,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}

// --- Events ---

#[contractevent(topics = ["pool"], data_format = "single-value")]
pub struct InsurancePurchased {
    #[topic]
    traveler: Address,
    premium: i128,
}

#[contractevent(topics = ["pool"], data_format = "single-value")]
pub struct PoolSettled {
    #[topic]
    status: SettlementStatus,
    buyer_count: u32,
}

#[contractevent(topics = ["pool"], data_format = "single-value")]
pub struct PayoutClaimed {
    #[topic]
    traveler: Address,
    amount: i128,
}

#[contractevent(topics = ["pool"], data_format = "single-value")]
pub struct ExpiredSwept {
    #[topic]
    recovery_pool: Address,
    amount: i128,
}

// --- TTL constants ---

const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 1_036_800; // ~60 days (covers claim window)
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 1_036_800;

// --- Helpers ---

fn require_controller(e: &Env, caller: &Address) {
    caller.require_auth();
    let controller: Address = e
        .storage()
        .instance()
        .get(&PoolKey::Controller)
        .expect("controller not set");
    assert!(caller == &controller, "not controller");
}

fn get_status(e: &Env) -> SettlementStatus {
    e.storage()
        .instance()
        .get(&PoolKey::Settled)
        .unwrap_or(SettlementStatus::Active)
}

fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

fn extend_buyer_ttl(e: &Env, buyer: &Address) {
    e.storage().persistent().extend_ttl(
        &PoolKey::Buyer(buyer.clone()),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
}

/// Shared logic for settle_delayed and settle_cancelled.
fn settle_with_payout(
    e: &Env,
    controller: &Address,
    claim_expiry: u64,
    status: SettlementStatus,
) {
    require_controller(e, controller);
    assert!(get_status(e) == SettlementStatus::Active, "already settled");

    e.storage().instance().set(&PoolKey::Settled, &status);
    e.storage()
        .instance()
        .set(&PoolKey::ClaimExpiry, &claim_expiry);

    let buyer_count: u32 = e
        .storage()
        .instance()
        .get(&PoolKey::BuyerCount)
        .unwrap_or(0);

    extend_instance_ttl(e);

    PoolSettled {
        status,
        buyer_count,
    }
    .publish(e);
}

// --- Contract ---

#[contract]
pub struct FlightPool;

#[contractimpl]
impl FlightPool {
    pub fn __constructor(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        premium: i128,
        payoff: i128,
        delay_hours: u32,
        usdc_token: Address,
        risk_vault: Address,
        recovery_pool: Address,
    ) {
        e.storage()
            .instance()
            .set(&PoolKey::Controller, &controller);
        e.storage()
            .instance()
            .set(&PoolKey::FlightId, &flight_id);
        e.storage().instance().set(&PoolKey::Date, &date);
        e.storage().instance().set(&PoolKey::Premium, &premium);
        e.storage().instance().set(&PoolKey::Payoff, &payoff);
        e.storage()
            .instance()
            .set(&PoolKey::DelayHours, &delay_hours);
        e.storage()
            .instance()
            .set(&PoolKey::UsdcToken, &usdc_token);
        e.storage()
            .instance()
            .set(&PoolKey::RiskVault, &risk_vault);
        e.storage()
            .instance()
            .set(&PoolKey::RecoveryPool, &recovery_pool);
        e.storage().instance().set(&PoolKey::BuyerCount, &0u32);
        e.storage()
            .instance()
            .set(&PoolKey::Settled, &SettlementStatus::Active);
    }

    // --- Controller-only functions ---

    /// Record a new insurance purchase. The Controller has already transferred
    /// the premium USDC to this pool before calling this function.
    pub fn buy_insurance(e: &Env, controller: Address, traveler: Address) {
        require_controller(e, &controller);
        assert!(get_status(e) == SettlementStatus::Active, "pool is settled");

        let buyer_key = PoolKey::Buyer(traveler.clone());
        let already_bought: bool = e.storage().persistent().get(&buyer_key).unwrap_or(false);
        assert!(!already_bought, "already has policy");

        e.storage().persistent().set(&buyer_key, &true);

        let count: u32 = e
            .storage()
            .instance()
            .get(&PoolKey::BuyerCount)
            .unwrap_or(0);
        e.storage()
            .instance()
            .set(&PoolKey::BuyerCount, &(count + 1));

        let premium: i128 = e.storage().instance().get(&PoolKey::Premium).unwrap();

        extend_buyer_ttl(e, &traveler);
        extend_instance_ttl(e);

        InsurancePurchased { traveler, premium }.publish(e);
    }

    /// Settle as on-time. Transfers all premiums from this pool to the RiskVault.
    /// The Controller will then call vault.record_premium_income() and vault.decrease_locked().
    pub fn settle_on_time(e: &Env, controller: Address) {
        require_controller(e, &controller);
        assert!(get_status(e) == SettlementStatus::Active, "already settled");

        let buyer_count: u32 = e
            .storage()
            .instance()
            .get(&PoolKey::BuyerCount)
            .unwrap_or(0);
        let premium: i128 = e.storage().instance().get(&PoolKey::Premium).unwrap();
        let total_premiums = premium * (buyer_count as i128);

        if total_premiums > 0 {
            let usdc_addr: Address = e.storage().instance().get(&PoolKey::UsdcToken).unwrap();
            let vault_addr: Address = e.storage().instance().get(&PoolKey::RiskVault).unwrap();
            let usdc = token::Client::new(e, &usdc_addr);
            usdc.transfer(&e.current_contract_address(), &vault_addr, &total_premiums);
        }

        e.storage()
            .instance()
            .set(&PoolKey::Settled, &SettlementStatus::SettledOnTime);

        extend_instance_ttl(e);

        PoolSettled {
            status: SettlementStatus::SettledOnTime,
            buyer_count,
        }
        .publish(e);
    }

    /// Settle as delayed. The Controller has already sent payout funds to this pool
    /// via vault.send_payout() before calling this.
    pub fn settle_delayed(e: &Env, controller: Address, claim_expiry: u64) {
        settle_with_payout(e, &controller, claim_expiry, SettlementStatus::SettledDelayed);
    }

    /// Settle as cancelled. Same payout flow as delayed.
    pub fn settle_cancelled(e: &Env, controller: Address, claim_expiry: u64) {
        settle_with_payout(
            e,
            &controller,
            claim_expiry,
            SettlementStatus::SettledCancelled,
        );
    }

    // --- Traveler functions ---

    /// Claim payout after delayed/cancelled settlement. Pull-based.
    pub fn claim(e: &Env, traveler: Address) {
        traveler.require_auth();

        let status = get_status(e);
        assert!(
            status == SettlementStatus::SettledDelayed
                || status == SettlementStatus::SettledCancelled,
            "not settled for payout"
        );

        assert!(
            e.storage()
                .persistent()
                .get::<_, bool>(&PoolKey::Buyer(traveler.clone()))
                .unwrap_or(false),
            "no policy"
        );
        assert!(
            !e.storage()
                .persistent()
                .get::<_, bool>(&PoolKey::Claimed(traveler.clone()))
                .unwrap_or(false),
            "already claimed"
        );

        let claim_expiry: u64 = e.storage().instance().get(&PoolKey::ClaimExpiry).unwrap();
        assert!(e.ledger().timestamp() <= claim_expiry, "claim expired");

        let payoff: i128 = e.storage().instance().get(&PoolKey::Payoff).unwrap();
        let usdc_addr: Address = e.storage().instance().get(&PoolKey::UsdcToken).unwrap();
        let usdc = token::Client::new(e, &usdc_addr);
        usdc.transfer(&e.current_contract_address(), &traveler, &payoff);

        e.storage()
            .persistent()
            .set(&PoolKey::Claimed(traveler.clone()), &true);
        e.storage().persistent().extend_ttl(
            &PoolKey::Claimed(traveler.clone()),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        extend_instance_ttl(e);

        PayoutClaimed {
            traveler,
            amount: payoff,
        }
        .publish(e);
    }

    // --- Public functions ---

    /// Sweep expired unclaimed payouts to RecoveryPool. Anyone can call.
    pub fn sweep_expired(e: &Env, caller: Address) {
        caller.require_auth();

        let status = get_status(e);
        assert!(
            status == SettlementStatus::SettledDelayed
                || status == SettlementStatus::SettledCancelled,
            "not settled for payout"
        );

        let claim_expiry: u64 = e.storage().instance().get(&PoolKey::ClaimExpiry).unwrap();
        assert!(
            e.ledger().timestamp() > claim_expiry,
            "claim window still open"
        );

        let usdc_addr: Address = e.storage().instance().get(&PoolKey::UsdcToken).unwrap();
        let recovery_addr: Address =
            e.storage().instance().get(&PoolKey::RecoveryPool).unwrap();
        let usdc = token::Client::new(e, &usdc_addr);
        let remaining = usdc.balance(&e.current_contract_address());

        if remaining > 0 {
            // Transfer USDC directly to RecoveryPool
            usdc.transfer(&e.current_contract_address(), &recovery_addr, &remaining);

            // Intentionally NOT extending TTL — let the contract naturally archive
            ExpiredSwept {
                recovery_pool: recovery_addr,
                amount: remaining,
            }
            .publish(e);
        }
    }

    // --- Read functions ---

    pub fn get_flight_info(e: &Env) -> (Symbol, u64, i128, i128, u32) {
        let flight_id: Symbol = e.storage().instance().get(&PoolKey::FlightId).unwrap();
        let date: u64 = e.storage().instance().get(&PoolKey::Date).unwrap();
        let premium: i128 = e.storage().instance().get(&PoolKey::Premium).unwrap();
        let payoff: i128 = e.storage().instance().get(&PoolKey::Payoff).unwrap();
        let delay_hours: u32 = e.storage().instance().get(&PoolKey::DelayHours).unwrap();
        (flight_id, date, premium, payoff, delay_hours)
    }

    pub fn get_buyer_count(e: &Env) -> u32 {
        e.storage()
            .instance()
            .get(&PoolKey::BuyerCount)
            .unwrap_or(0)
    }

    pub fn get_settlement_status(e: &Env) -> SettlementStatus {
        get_status(e)
    }

    pub fn has_policy(e: &Env, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Buyer(traveler))
            .unwrap_or(false)
    }

    pub fn has_claimed(e: &Env, traveler: Address) -> bool {
        e.storage()
            .persistent()
            .get(&PoolKey::Claimed(traveler))
            .unwrap_or(false)
    }

    pub fn get_delay_hours(e: &Env) -> u32 {
        e.storage()
            .instance()
            .get(&PoolKey::DelayHours)
            .unwrap()
    }

    pub fn get_premium(e: &Env) -> i128 {
        e.storage().instance().get(&PoolKey::Premium).unwrap()
    }

    pub fn get_payoff(e: &Env) -> i128 {
        e.storage().instance().get(&PoolKey::Payoff).unwrap()
    }

    pub fn get_claim_expiry(e: &Env) -> u64 {
        e.storage()
            .instance()
            .get(&PoolKey::ClaimExpiry)
            .unwrap_or(0)
    }

    pub fn get_controller(e: &Env) -> Address {
        e.storage().instance().get(&PoolKey::Controller).unwrap()
    }
}

#[cfg(test)]
mod test;
