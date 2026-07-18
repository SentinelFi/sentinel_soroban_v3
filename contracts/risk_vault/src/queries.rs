use soroban_sdk::{contractimpl, Address, Env, Vec};

use crate::storage::{DepositRequest, VaultKey};
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

    /// Return the nominal margin above locked payoff liabilities
    /// (`TMA − LockedCapital`). This is an accounting view, NOT the exit
    /// gate: withdrawals are bounded by `get_withdrawable_capital`, which
    /// additionally holds back the configured solvency reserve.
    pub fn get_free_capital(e: &Env) -> i128 {
        let tma = Self::get_total_managed_assets(e);
        let locked = Self::get_locked_capital(e);
        tma.checked_sub(locked).expect("subtraction underflow")
    }

    /// Return the solvency ratio (percent) the vault holds in reserve against
    /// locked capital. Pushed by the controller alongside its own copy; 100
    /// (nominal backing only) until the controller first configures it.
    pub fn get_solvency_ratio(e: &Env) -> u32 {
        e.storage()
            .instance()
            .get(&VaultKey::SolvencyRatio)
            .unwrap_or(100)
    }

    /// Return the capital LP exits may remove:
    /// `max(TMA − ceil(LockedCapital × SolvencyRatio / 100), 0)`.
    /// The same required-backing formula the controller admits new policies
    /// against — using the nominal margin here instead would let exits drain
    /// the configured reserve down to 100% backing the moment a purchase
    /// passed. Gates direct withdraw/redeem, the `max_*` views, and
    /// withdrawal-queue processing.
    pub fn get_withdrawable_capital(e: &Env) -> i128 {
        let tma = Self::get_total_managed_assets(e);
        let locked = Self::get_locked_capital(e);
        let ratio = Self::get_solvency_ratio(e);
        // ceil(locked * ratio / 100) — the same shared formula the
        // controller's purchase admission uses, so the reserve exits are
        // held back from is exactly the reserve admission verified.
        let required = sentinel_types::solvency::required_reserve(locked, ratio);
        // A ratio raised after capital was locked can push the required
        // reserve above current assets; report zero withdrawable rather than
        // a negative amount.
        tma.checked_sub(required)
            .expect("subtraction underflow")
            .max(0)
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

    /// Return the current pending deposit request queue (escrowed LP entries
    /// awaiting delayed pricing).
    pub fn get_deposit_queue(e: &Env) -> Vec<DepositRequest> {
        e.storage()
            .instance()
            .get(&VaultKey::DepositQueue)
            .unwrap_or(Vec::new(e))
    }

    /// Return the number of pending deposit requests — the entry-side
    /// occupancy gauge (see `get_withdrawal_queue_len`).
    pub fn get_deposit_queue_len(e: &Env) -> u32 {
        Self::get_deposit_queue(e).len()
    }

    /// Return the minimum asset value a queued request (withdrawal or
    /// deposit) must carry (0 = no minimum configured).
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
