use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env};
use stellar_access::ownable::{self as ownable};
use stellar_macros::{only_owner, when_not_paused};

use crate::auth::extend_instance_ttl;
use crate::events::RecoveredWithdrawn;
use crate::storage::PoolKey;
use crate::{Error, FlightPoolManager, FlightPoolManagerArgs, FlightPoolManagerClient};

#[contractimpl]
impl FlightPoolManager {
    /// Initialize the flight pool manager.
    ///
    /// # Arguments
    /// * `owner` - Address granted owner rights (set the controller, recover
    ///   stranded balances, upgrade).
    /// * `asset_token` - SAC address of the asset in which premiums are held
    ///   and payouts are made to buyers.
    /// * `risk_vault` - Address of the RiskVault that collected premiums are
    ///   swept to on settlement.
    pub fn __constructor(e: &Env, owner: Address, asset_token: Address, risk_vault: Address) {
        ownable::set_owner(e, &owner);
        e.storage()
            .instance()
            .set(&PoolKey::AssetToken, &asset_token);
        e.storage().instance().set(&PoolKey::RiskVault, &risk_vault);
        e.storage()
            .instance()
            .set(&PoolKey::RecoveredBalance, &0i128);
        sentinel_types::upgrade::set_initial_version(e);
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
    /// Transfers asset from the contract to the owner.
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

        // Decrement the balance before the external transfer.
        e.storage().instance().set(
            &PoolKey::RecoveredBalance,
            &recovered
                .checked_sub(amount)
                .expect("subtraction underflow"),
        );

        let owner = ownable::get_owner(e).expect("owner not set");
        let asset_addr: Address = e.storage().instance().get(&PoolKey::AssetToken).unwrap();
        let asset = token::Client::new(e, &asset_addr);
        asset.transfer(&e.current_contract_address(), &owner, &amount);

        RecoveredWithdrawn { owner, amount }.publish(e);
    }

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        extend_instance_ttl(e);
    }
}
