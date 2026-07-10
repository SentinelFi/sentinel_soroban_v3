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

    /// Set (or update) the OracleAggregator address the vault consults to block
    /// entry/exit while a flight outcome is public but not yet settled. Owner-
    /// only. Until this is set the settlement-pending gate is inactive, so a
    /// production deployment must call it after the oracle is deployed.
    #[only_owner]
    pub fn set_oracle(e: &Env, oracle: Address) {
        e.storage().instance().set(&VaultKey::Oracle, &oracle);
        Self::extend_ttl(e);
    }

    /// Set the minimum asset value a queued withdrawal request must carry at
    /// submission time (owner-only). The withdrawal queue is a bounded shared
    /// resource: without a value floor, one participant can split shares
    /// across many addresses and occupy every slot with near-dust requests,
    /// locking later underwriters out of the FIFO exit path. A meaningful
    /// minimum makes each slot cost real escrowed capital. Zero disables the
    /// floor. Choose the value in underlying-asset units, well below typical
    /// LP position sizes so small underwriters can still queue their exits.
    ///
    /// The enforcement is clamped at request time to a small fraction of
    /// managed assets (see `MIN_REQUEST_FLOOR_DIVISOR`), so no configured
    /// value — however large — can lock ordinary positions out of the queue.
    #[only_owner]
    pub fn set_min_withdrawal_request(e: &Env, min_assets: i128) {
        if min_assets < 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        e.storage()
            .instance()
            .set(&VaultKey::MinWithdrawalRequest, &min_assets);
        Self::extend_ttl(e);
    }

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
}
