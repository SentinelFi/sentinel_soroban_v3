use soroban_sdk::{contractimpl, panic_with_error, Address, Env, String};
use stellar_access::ownable::{self as ownable};
use stellar_macros::only_owner;
use stellar_tokens::fungible::{Base, FungibleToken};
use stellar_tokens::vault::Vault;

use crate::auth::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};
use crate::events::ControllerSet;
use crate::storage::VaultKey;
use crate::{Error, RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl RiskVault {
    /// Initialize the vault.
    ///
    /// # Arguments
    /// * `owner` - Address granted owner rights (set the controller, pause,
    ///   upgrade, recover uncollected balances).
    /// * `asset_token` - SAC address of the underlying asset the vault
    ///   custodies and denominates its shares against.
    pub fn __constructor(e: &Env, owner: Address, asset_token: Address) {
        ownable::set_owner(e, &owner);
        Vault::set_asset(e, asset_token);
        Vault::set_decimals_offset(e, 3);
        Base::set_metadata(
            e,
            Self::decimals(e),
            String::from_str(e, "RiskVault Share"),
            String::from_str(e, "RVS"),
        );
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &0i128);
        e.storage().instance().set(&VaultKey::LockedCapital, &0i128);
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &0u64);
        sentinel_types::upgrade::set_initial_version(e);
    }

    /// Set the vault controller address (one-time, owner-only).
    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        if e.storage().instance().has(&VaultKey::Controller) {
            panic_with_error!(e, Error::ControllerAlreadySet);
        }
        e.storage()
            .instance()
            .set(&VaultKey::Controller, &controller);
        Self::extend_ttl(e);
        ControllerSet { controller }.publish(e);
    }

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
}
