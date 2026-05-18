// Controller-only capital management: lock/unlock collateral, record premium
// income, send payouts, drain the withdrawal queue into ClaimableBalance.

use soroban_sdk::{contractimpl, token, Address, Env, Vec};
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::auth::require_controller;
use crate::events::Credited;
use crate::storage::{VaultKey, CLAIMABLE_TTL_LEDGERS};
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    pub fn increase_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let locked = Self::get_locked_capital(e);
        let tma = Self::get_total_managed_assets(e);
        let new_locked = locked.checked_add(amount).expect("addition overflow");
        assert!(new_locked <= tma, "would exceed total managed assets");
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &new_locked);
    }

    pub fn decrease_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let locked = Self::get_locked_capital(e);
        assert!(amount <= locked, "would go negative");
        e.storage().instance().set(
            &VaultKey::LockedCapital,
            &locked.checked_sub(amount).expect("subtraction underflow"),
        );
    }

    pub fn record_premium_income(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(amount).expect("addition overflow"),
        );
    }

    pub fn send_payout(e: &Env, controller: Address, to: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let tma = Self::get_total_managed_assets(e);
        assert!(amount <= tma, "insufficient managed assets");

        let usdc = token::Client::new(e, &Vault::query_asset(e));
        usdc.transfer(&e.current_contract_address(), &to, &amount);

        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(amount).expect("subtraction underflow"),
        );
    }

    pub fn process_withdrawal_queue(e: &Env, controller: Address) {
        require_controller(e, &controller);

        let queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        if queue.is_empty() {
            return;
        }

        let mut remaining_free = Self::get_free_capital(e);
        let mut processed: u32 = 0;
        let mut tma = Self::get_total_managed_assets(e);
        let vault_addr = e.current_contract_address();

        for i in 0..queue.len() {
            let request = queue.get(i).unwrap();
            let assets = Vault::preview_redeem(e, request.shares);

            if assets > remaining_free || assets == 0 {
                break;
            }

            // Burn escrowed shares (held by vault)
            Base::update(e, Some(&vault_addr), None, request.shares);

            // Credit claimable balance (pull-based)
            let owner = request.owner.clone();
            let key = VaultKey::ClaimableBalance(owner.clone());
            let claimable: i128 = e.storage().persistent().get(&key).unwrap_or(0);
            let new_balance = claimable.checked_add(assets).expect("addition overflow");
            e.storage().persistent().set(&key, &new_balance);

            // Extend TTL on every credit and emit an event so the off-chain
            // TTL cron can mirror the address into its claimable_balances table.
            e.storage().persistent().extend_ttl(
                &key,
                CLAIMABLE_TTL_LEDGERS,
                CLAIMABLE_TTL_LEDGERS,
            );
            Credited {
                user: owner,
                amount: assets,
                new_balance,
            }
            .publish(e);

            remaining_free = remaining_free
                .checked_sub(assets)
                .expect("subtraction underflow");
            tma = tma.checked_sub(assets).expect("subtraction underflow");
            processed = processed.checked_add(1).expect("addition overflow");
        }

        if processed > 0 {
            let mut new_queue = Vec::new(e);
            for i in processed..queue.len() {
                new_queue.push_back(queue.get(i).unwrap());
            }
            e.storage()
                .instance()
                .set(&VaultKey::WithdrawalQueue, &new_queue);
            e.storage()
                .instance()
                .set(&VaultKey::TotalManagedAssets, &tma);
        }
    }
}
