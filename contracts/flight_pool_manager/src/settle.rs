use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::auth::require_controller;
use crate::constants::MAX_CLAIM_DEADLINE_AFTER_DATE_SECS;
use crate::events::FlightSettled;
use crate::storage::{extend_flight_ttl_to, prune_active_list, PoolKey};
use crate::{
    Error, FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient,
    SettlementStatus,
};

#[contractimpl]
impl FlightPoolManager {
    /// Settle on time: transfer premium*buyer_count to RiskVault as yield and
    /// return the transferred amount so the Controller can record it as vault
    /// income.
    ///
    /// The pool moves its own held premiums to the vault (a contract is
    /// implicitly authorized to spend its own balance), but it does NOT call
    /// the vault's controller-only `record_premium_income`. That accounting
    /// call requires the Controller's address to authorize it; since the pool —
    /// not the Controller — is the direct caller of the vault, the Controller's
    /// auth does not propagate to a call the pool initiates, so the only correct
    /// caller is the Controller itself. We therefore return the transferred
    /// total and let the Controller credit vault income directly.
    #[when_not_paused]
    pub fn settle_on_time(e: &Env, controller: Address, flight_id: Symbol, date: u64) -> i128 {
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

        cfg.status = SettlementStatus::SettledOnTime;
        e.storage().persistent().set(&cfg_key, &cfg);
        prune_active_list(e, &flight_id, date);

        let mut total_premium: i128 = 0;
        if cfg.buyer_count > 0 {
            total_premium = cfg
                .premium
                .checked_mul(cfg.buyer_count as i128)
                .expect("multiplication overflow");
            let asset_addr: Address = e.storage().instance().get(&PoolKey::AssetToken).unwrap();
            let vault_addr: Address = e.storage().instance().get(&PoolKey::RiskVault).unwrap();

            let asset = token::Client::new(e, &asset_addr);
            asset.transfer(&e.current_contract_address(), &vault_addr, &total_premium);
        }

        FlightSettled {
            flight_id,
            date,
            status: SettlementStatus::SettledOnTime,
            claim_expiry: 0,
        }
        .publish(e);

        total_premium
    }

    /// Settle delayed: open the claim window. RiskVault top-up handled by
    /// Controller separately (it calls vault.send_payout(self_addr, ...)).
    #[when_not_paused]
    pub fn settle_delayed(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    ) {
        require_controller(e, &controller);
        settle_with_claim_window(
            e,
            flight_id,
            date,
            claim_expiry,
            SettlementStatus::SettledDelayed,
        );
    }

    /// Settle cancelled: identical state shape to settle_delayed.
    #[when_not_paused]
    pub fn settle_cancelled(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    ) {
        require_controller(e, &controller);
        settle_with_claim_window(
            e,
            flight_id,
            date,
            claim_expiry,
            SettlementStatus::SettledCancelled,
        );
    }
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
    if !(cfg.status == SettlementStatus::Active) {
        panic_with_error!(e, Error::FlightNotActive);
    }
    if claim_expiry <= e.ledger().timestamp() {
        panic_with_error!(e, Error::ClaimExpiryNotInFuture);
    }
    // Cap the deadline at the buyer proofs' guaranteed lifetime (see
    // MAX_CLAIM_DEADLINE_AFTER_DATE_SECS) — a later deadline would outlive
    // the entitlement records it is supposed to serve. If settlement ran so
    // late that the cap is already in the past, the bucket still settles
    // (refusing would strand it and jam the settlement pipeline) but the
    // window is born expired: `sweep_expired` then routes the funds to the
    // recovered balance for owner-driven manual remediation.
    let claim_expiry = claim_expiry.min(
        date.checked_add(MAX_CLAIM_DEADLINE_AFTER_DATE_SECS)
            .expect("addition overflow"),
    );

    cfg.status = new_status.clone();
    cfg.claim_expiry = claim_expiry;
    e.storage().persistent().set(&cfg_key, &cfg);
    extend_flight_ttl_to(e, &flight_id, date, claim_expiry);
    prune_active_list(e, &flight_id, date);

    FlightSettled {
        flight_id,
        date,
        status: new_status,
        claim_expiry,
    }
    .publish(e);
}
