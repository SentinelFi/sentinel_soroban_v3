use soroban_sdk::{contractimpl, Address, BytesN, Env, String};
use stellar_access::ownable::{self as ownable};
use stellar_macros::only_owner;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::auth::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};
use crate::storage::VaultKey;
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl RiskVault {
    pub fn __constructor(e: &Env, owner: Address, usdc_token: Address) {
        ownable::set_owner(e, &owner);
        Base::set_metadata(
            e,
            10,
            String::from_str(e, "RiskVault Share"),
            String::from_str(e, "RVS"),
        );
        Vault::set_asset(e, usdc_token);
        Vault::set_decimals_offset(e, 3);
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &0i128);
        e.storage().instance().set(&VaultKey::LockedCapital, &0i128);
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &0u64);
    }

    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        assert!(
            !e.storage().instance().has(&VaultKey::Controller),
            "controller already set"
        );
        e.storage()
            .instance()
            .set(&VaultKey::Controller, &controller);
    }

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    #[only_owner]
    pub fn upgrade(e: &Env, wasm_hash: BytesN<32>) {
        e.deployer().update_current_contract_wasm(wasm_hash);
    }
}
