use soroban_sdk::{contractimpl, panic_with_error, token, Address, BytesN, Env};
use stellar_access::ownable::{self as ownable};
use stellar_macros::{only_owner, when_not_paused};

use crate::auth::extend_instance_ttl;
use crate::events::RecoveredWithdrawn;
use crate::storage::PoolKey;
use crate::{Error, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient};

#[contractimpl]
impl FlightPoolManager {
    pub fn __constructor(e: &Env, owner: Address, usdc_token: Address, risk_vault: Address) {
        ownable::set_owner(e, &owner);
        e.storage().instance().set(&PoolKey::UsdcToken, &usdc_token);
        e.storage().instance().set(&PoolKey::RiskVault, &risk_vault);
        e.storage()
            .instance()
            .set(&PoolKey::RecoveredBalance, &0i128);
    }

    /// Set the authorized controller. One-time write — fails if already set.
    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        if e.storage().instance().has(&PoolKey::Controller) {
            panic_with_error!(e, Error::ControllerAlreadySet);
        }
        e.storage()
            .instance()
            .set(&PoolKey::Controller, &controller);
        extend_instance_ttl(e);
    }

    /// Owner withdraws funds credited to RecoveredBalance via sweep_expired.
    /// Transfers USDC from the contract to the owner.
    #[only_owner]
    #[when_not_paused]
    pub fn withdraw_recovered(e: &Env, amount: i128) {
        if amount <= 0 {
            panic_with_error!(e, Error::AmountNotPositive);
        }
        let recovered: i128 = e
            .storage()
            .instance()
            .get(&PoolKey::RecoveredBalance)
            .unwrap_or(0);
        if amount > recovered {
            panic_with_error!(e, Error::ExceedsRecoveredBalance);
        }

        // CEI: decrement balance before the external transfer.
        e.storage().instance().set(
            &PoolKey::RecoveredBalance,
            &recovered
                .checked_sub(amount)
                .expect("subtraction underflow"),
        );

        let owner = ownable::get_owner(e).expect("owner not set");
        let usdc_addr: Address = e.storage().instance().get(&PoolKey::UsdcToken).unwrap();
        let usdc = token::Client::new(e, &usdc_addr);
        usdc.transfer(&e.current_contract_address(), &owner, &amount);

        RecoveredWithdrawn { owner, amount }.publish(e);
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
