use soroban_sdk::{contractimpl, Address, BytesN, Env};
use stellar_access::ownable::{self as ownable};
use stellar_macros::only_owner;

use crate::auth::extend_instance_ttl;
use crate::storage::{
    CtrlKey, MAX_CLAIM_EXPIRY_WINDOW_SECS, MAX_MIN_LEAD_TIME_SECS, MAX_SOLVENCY_RATIO,
    MIN_CLAIM_EXPIRY_WINDOW_SECS, MIN_SOLVENCY_RATIO,
};
use crate::{Controller, ControllerArgs, ControllerClient};

fn assert_solvency_ratio(ratio: u32) {
    assert!(
        (MIN_SOLVENCY_RATIO..=MAX_SOLVENCY_RATIO).contains(&ratio),
        "solvency_ratio out of bounds",
    );
}

fn assert_min_lead_time(seconds: u64) {
    assert!(
        seconds <= MAX_MIN_LEAD_TIME_SECS,
        "min_lead_time exceeds maximum",
    );
}

fn assert_claim_expiry_window(seconds: u64) {
    assert!(
        (MIN_CLAIM_EXPIRY_WINDOW_SECS..=MAX_CLAIM_EXPIRY_WINDOW_SECS).contains(&seconds),
        "claim_expiry_window out of bounds",
    );
}

#[contractimpl]
impl Controller {
    pub fn __constructor(
        e: &Env,
        owner: Address,
        governance: Address,
        risk_vault: Address,
        oracle: Address,
        flight_pool_manager: Address,
        usdc_token: Address,
        authorized_keeper: Address,
        min_lead_time: u64,
        claim_expiry_window: u64,
    ) {
        assert_min_lead_time(min_lead_time);
        assert_claim_expiry_window(claim_expiry_window);
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&CtrlKey::Governance, &governance);
        e.storage().instance().set(&CtrlKey::RiskVault, &risk_vault);
        e.storage().instance().set(&CtrlKey::Oracle, &oracle);
        e.storage()
            .instance()
            .set(&CtrlKey::FlightPoolManager, &flight_pool_manager);
        e.storage().instance().set(&CtrlKey::UsdcToken, &usdc_token);
        e.storage()
            .instance()
            .set(&CtrlKey::AuthorizedKeeper, &authorized_keeper);
        e.storage()
            .instance()
            .set(&CtrlKey::MinLeadTime, &min_lead_time);
        e.storage()
            .instance()
            .set(&CtrlKey::ClaimExpiryWindow, &claim_expiry_window);
        e.storage().instance().set(&CtrlKey::SolvencyRatio, &100u32);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPoliciesSold, &0u64);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPremiumsCollected, &0i128);
        e.storage()
            .instance()
            .set(&CtrlKey::TotalPayoutsDistributed, &0i128);
    }

    #[only_owner]
    pub fn set_keeper(e: &Env, keeper: Address) {
        e.storage()
            .instance()
            .set(&CtrlKey::AuthorizedKeeper, &keeper);
        extend_instance_ttl(e);
    }

    #[only_owner]
    pub fn set_solvency_ratio(e: &Env, ratio: u32) {
        assert_solvency_ratio(ratio);
        e.storage().instance().set(&CtrlKey::SolvencyRatio, &ratio);
        extend_instance_ttl(e);
    }

    #[only_owner]
    pub fn set_min_lead_time(e: &Env, seconds: u64) {
        assert_min_lead_time(seconds);
        e.storage().instance().set(&CtrlKey::MinLeadTime, &seconds);
        extend_instance_ttl(e);
    }

    #[only_owner]
    pub fn set_claim_expiry_window(e: &Env, seconds: u64) {
        assert_claim_expiry_window(seconds);
        e.storage()
            .instance()
            .set(&CtrlKey::ClaimExpiryWindow, &seconds);
        extend_instance_ttl(e);
    }

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }

    #[only_owner]
    pub fn upgrade(e: &Env, wasm_hash: BytesN<32>) {
        e.deployer().update_current_contract_wasm(wasm_hash);
    }
}
