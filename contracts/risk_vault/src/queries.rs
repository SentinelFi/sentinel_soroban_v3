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

    /// Return the configured oracle address. Wired at construction, so this
    /// is always `Some` on a live vault; the `Option` shape is kept for ABI
    /// stability with existing tooling.
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

    /// Return the number of pending withdrawal requests. Cheap saturation
    /// gauge for operators: the queue is capped, so occupancy approaching the
    /// cap means new exit requests are about to be rejected and warrants
    /// intervention (more frequent draining, or raising the request minimum).
    pub fn get_withdrawal_queue_len(e: &Env) -> u32 {
        Self::get_withdrawal_queue(e).len()
    }

    /// Return the minimum asset value a queued withdrawal request must carry
    /// (0 = no minimum configured).
    pub fn get_min_withdrawal_request(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&VaultKey::MinWithdrawalRequest)
            .unwrap_or(0)
    }

    /// Return the claimable (collectible) balance owed to an address.
    pub fn get_claimable_balance(e: &Env, address: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&VaultKey::ClaimableBalance(address))
            .unwrap_or(0)
    }
}
