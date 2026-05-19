use soroban_sdk::{contractimpl, token, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::auth::require_controller;
use crate::events::FlightSettled;
use crate::storage::{extend_flight_ttl_to, prune_active_list, PoolKey};
use crate::{FlightConfig, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient, SettlementStatus};

#[contractimpl]
impl FlightPoolManager {
    /// Settle on time: transfer premium*buyer_count to RiskVault as yield.
    #[when_not_paused]
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
    #[when_not_paused]
    pub fn settle_delayed(
        e: &Env,
        controller: Address,
        flight_id: Symbol,
        date: u64,
        claim_expiry: u64,
    ) {
        require_controller(e, &controller);
        settle_with_claim_window(e, flight_id, date, claim_expiry, SettlementStatus::SettledDelayed);
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
        settle_with_claim_window(e, flight_id, date, claim_expiry, SettlementStatus::SettledCancelled);
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
