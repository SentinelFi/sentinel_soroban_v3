use soroban_sdk::{contractimpl, Address, Env, Vec};

use crate::storage::VaultKey;
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    /// Return the total assets under management by the vault.
    pub fn get_total_managed_assets(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&VaultKey::TotalManagedAssets)
            .unwrap_or(0)
    }

    /// Return the amount of capital currently locked as collateral.
    pub fn get_locked_capital(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&VaultKey::LockedCapital)
            .unwrap_or(0)
    }

    /// Return free (unlocked) capital available for withdrawal/payout.
    pub fn get_free_capital(e: &Env) -> i128 {
        let tma = Self::get_total_managed_assets(e);
        let locked = Self::get_locked_capital(e);
        tma.checked_sub(locked).expect("subtraction underflow")
    }

    /// Return the configured controller address.
    pub fn get_controller(e: &Env) -> Address {
        e.storage().instance().get(&VaultKey::Controller).unwrap()
    }

    /// Return the configured oracle address, or None if the settlement-pending
    /// gate has not been wired yet.
    pub fn get_oracle(e: &Env) -> Option<Address> {
        e.storage().instance().get(&VaultKey::Oracle)
    }

    /// Return the current pending withdrawal request queue.
    pub fn get_withdrawal_queue(e: &Env) -> Vec<WithdrawalRequest> {
        e.storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e))
    }

    /// Return the claimable (collectible) balance owed to an address.
    pub fn get_claimable_balance(e: &Env, address: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&VaultKey::ClaimableBalance(address))
            .unwrap_or(0)
    }
}
