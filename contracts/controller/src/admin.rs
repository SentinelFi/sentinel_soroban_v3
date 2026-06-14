use crate::storage::{
    CtrlKey, MAX_CLAIM_EXPIRY_WINDOW_SECS, MAX_MIN_LEAD_TIME_SECS, MAX_SOLVENCY_RATIO,
    MIN_CLAIM_EXPIRY_WINDOW_SECS, MIN_SOLVENCY_RATIO,
};
use crate::{Controller, ControllerArgs, ControllerClient, Error};
pub(crate) use sentinel_types::ttl::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};
use soroban_sdk::{contractimpl, panic_with_error, Address, Env};
use stellar_access::ownable::{self as ownable};
use stellar_macros::only_owner;

fn assert_solvency_ratio(e: &Env, ratio: u32) {
    if !(MIN_SOLVENCY_RATIO..=MAX_SOLVENCY_RATIO).contains(&ratio) {
        panic_with_error!(e, Error::SolvencyRatioOutOfBounds);
    }
}

fn assert_min_lead_time(e: &Env, seconds: u64) {
    if seconds > MAX_MIN_LEAD_TIME_SECS {
        panic_with_error!(e, Error::MinLeadTimeExceedsMaximum);
    }
}

fn assert_claim_expiry_window(e: &Env, seconds: u64) {
    if !(MIN_CLAIM_EXPIRY_WINDOW_SECS..=MAX_CLAIM_EXPIRY_WINDOW_SECS).contains(&seconds) {
        panic_with_error!(e, Error::ClaimExpiryWindowOutOfBounds);
    }
}

#[contractimpl]
impl Controller {
    /// Initialize the controller — the orchestrator wiring together the
    /// governance, vault, oracle, and pool contracts.
    ///
    /// # Arguments
    /// * `owner` - Address granted owner rights (rotate the keeper, tune
    ///   parameters, pause, upgrade).
    /// * `governance` - Address of the GovernanceModule that resolves route
    ///   terms (premium/payoff/delay).
    /// * `risk_vault` - Address of the RiskVault holding collateral and paying
    ///   out claims.
    /// * `oracle` - Address of the OracleAggregator providing flight outcomes.
    /// * `flight_pool_manager` - Address of the FlightPoolManager tracking
    ///   per-flight buyers and premiums.
    /// * `asset_token` - SAC address of the settlement asset premiums are
    ///   collected in.
    /// * `authorized_keeper` - Address permitted to trigger settlement.
    /// * `min_lead_time_secs` - Minimum number of seconds between purchase and
    ///   departure; buys too close to departure are rejected.
    /// * `claim_expiry_window_secs` - Number of seconds after settlement during
    ///   which a payout remains claimable before it expires.
    pub fn __constructor(
        e: &Env,
        owner: Address,
        governance: Address,
        risk_vault: Address,
        oracle: Address,
        flight_pool_manager: Address,
        asset_token: Address,
        authorized_keeper: Address,
        min_lead_time_secs: u64,
        claim_expiry_window_secs: u64,
    ) {
        assert_min_lead_time(e, min_lead_time_secs);
        assert_claim_expiry_window(e, claim_expiry_window_secs);
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&CtrlKey::Governance, &governance);
        e.storage().instance().set(&CtrlKey::RiskVault, &risk_vault);
        e.storage().instance().set(&CtrlKey::Oracle, &oracle);
        e.storage()
            .instance()
            .set(&CtrlKey::FlightPoolManager, &flight_pool_manager);
        e.storage()
            .instance()
            .set(&CtrlKey::AssetToken, &asset_token);
        e.storage()
            .instance()
            .set(&CtrlKey::AuthorizedKeeper, &authorized_keeper);
        e.storage()
            .instance()
            .set(&CtrlKey::MinLeadTime, &min_lead_time_secs);
        e.storage()
            .instance()
            .set(&CtrlKey::ClaimExpiryWindow, &claim_expiry_window_secs);
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
        sentinel_types::upgrade::set_initial_version(e);
    }

    #[only_owner]
    pub fn set_keeper(e: &Env, keeper: Address) {
        e.storage()
            .instance()
            .set(&CtrlKey::AuthorizedKeeper, &keeper);
        Self::extend_ttl(e);
    }

    #[only_owner]
    pub fn set_solvency_ratio(e: &Env, ratio: u32) {
        assert_solvency_ratio(e, ratio);
        e.storage().instance().set(&CtrlKey::SolvencyRatio, &ratio);
        Self::extend_ttl(e);
    }

    #[only_owner]
    pub fn set_min_lead_time(e: &Env, seconds: u64) {
        assert_min_lead_time(e, seconds);
        e.storage().instance().set(&CtrlKey::MinLeadTime, &seconds);
        Self::extend_ttl(e);
    }

    #[only_owner]
    pub fn set_claim_expiry_window(e: &Env, seconds: u64) {
        assert_claim_expiry_window(e, seconds);
        e.storage()
            .instance()
            .set(&CtrlKey::ClaimExpiryWindow, &seconds);
        Self::extend_ttl(e);
    }

    /// Extend instance TTL. Called by cron as a safety net, and reused
    /// internally as the single instance-TTL entry point (other functions call
    /// `Self::extend_ttl`).
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
}
