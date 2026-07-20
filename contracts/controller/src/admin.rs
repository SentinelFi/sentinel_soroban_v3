use crate::constants::{
    MAX_BOOK_AHEAD_SECS, MAX_CLAIM_EXPIRY_WINDOW_SECS, MAX_SOLVENCY_RATIO,
    MIN_CLAIM_EXPIRY_WINDOW_SECS, MIN_SOLVENCY_RATIO,
};
use crate::events::{ClaimExpiryWindowSet, KeeperSet, MinLeadTimeSet, SolvencyRatioSet};
use crate::interfaces::VaultClient;
use crate::storage::CtrlKey;
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
    // Strictly below the booking horizon. `buy_insurance`
    // requires `now + min_lead < date <= now + MAX_BOOK_AHEAD`; if min_lead were
    // allowed to equal MAX_BOOK_AHEAD the interval would be empty and every
    // purchase would revert while the config still looked valid.
    if seconds >= MAX_BOOK_AHEAD_SECS {
        panic_with_error!(e, Error::MinLeadTimeLeavesNoBookingWindow);
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

    /// Sets the authorized keeper address.
    #[only_owner]
    pub fn set_keeper(e: &Env, keeper: Address) {
        e.storage()
            .instance()
            .set(&CtrlKey::AuthorizedKeeper, &keeper);
        Self::extend_ttl(e);
        KeeperSet { keeper }.publish(e);
    }

    /// Sets the vault solvency ratio (validated against allowed bounds) and
    /// mirrors it into the RiskVault in the same transaction. The controller
    /// enforces the ratio when policies increase locked liabilities; the
    /// vault enforces the identical value when assets leave through LP exits.
    /// Pushing (rather than the vault reading it back) is required because
    /// the vault cannot call the controller while the controller is invoking
    /// it, and atomicity guarantees the two copies never diverge.
    #[only_owner]
    pub fn set_solvency_ratio(e: &Env, ratio: u32) {
        assert_solvency_ratio(e, ratio);
        e.storage().instance().set(&CtrlKey::SolvencyRatio, &ratio);
        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        VaultClient::new(e, &vault_addr).set_solvency_ratio(&e.current_contract_address(), &ratio);
        Self::extend_ttl(e);
        SolvencyRatioSet { ratio }.publish(e);
    }

    /// Sets the minimum lead time (in seconds) required between purchase and departure.
    #[only_owner]
    pub fn set_min_lead_time(e: &Env, seconds: u64) {
        assert_min_lead_time(e, seconds);
        e.storage().instance().set(&CtrlKey::MinLeadTime, &seconds);
        Self::extend_ttl(e);
        MinLeadTimeSet { seconds }.publish(e);
    }

    /// Sets the claim expiry window (in seconds) after settlement (validated against allowed bounds).
    ///
    /// Note: this window is measured from SETTLEMENT time, but the pool
    /// additionally caps each claim deadline at `flight_date +
    /// MAX_CLAIM_DEADLINE_AFTER_DATE_SECS` (the buyer-proof-lifetime bound). So
    /// when settlement runs late the EFFECTIVE window can be shorter than the
    /// value set here — it never extends a claim deadline past that date-anchored
    /// cap. Configure with that ceiling in mind.
    #[only_owner]
    pub fn set_claim_expiry_window(e: &Env, seconds: u64) {
        assert_claim_expiry_window(e, seconds);
        e.storage()
            .instance()
            .set(&CtrlKey::ClaimExpiryWindow, &seconds);
        Self::extend_ttl(e);
        ClaimExpiryWindowSet { seconds }.publish(e);
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
