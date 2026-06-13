// Controller-only capital management: lock/unlock collateral, record premium
// income, send payouts, drain the withdrawal queue into ClaimableBalance.

use soroban_sdk::{contractimpl, token, Address, Env, Vec};
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::auth::require_controller;
use crate::events::Credited;
use crate::storage::{VaultKey, CLAIMABLE_TTL_LEDGERS, MAX_QUEUE_BATCH};
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    #[when_not_paused]
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

    #[when_not_paused]
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

    #[when_not_paused]
    pub fn record_premium_income(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let old_tma = Self::get_total_managed_assets(e);
        let new_tma = old_tma.checked_add(amount).expect("addition overflow");

        // Defensive: the pool transfers USDC to the vault BEFORE calling this.
        // Reject the credit if the vault's USDC balance can't cover the new
        // TMA — catches the "controller called us but no USDC arrived" path
        // (compromised or buggy caller). Note: outstanding ClaimableBalance
        // entries are not part of TMA (they were decremented at credit
        // time), so the check is a strict floor on managed assets.
        let usdc = token::Client::new(e, &Vault::query_asset(e));
        let balance = usdc.balance(&e.current_contract_address());
        assert!(balance >= new_tma, "premium not received");

        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &new_tma);
    }

    #[when_not_paused]
    pub fn send_payout(e: &Env, controller: Address, to: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let tma = Self::get_total_managed_assets(e);
        assert!(amount <= tma, "insufficient managed assets");

        // CEI: decrement TMA before the external transfer.
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(amount).expect("subtraction underflow"),
        );

        let usdc = token::Client::new(e, &Vault::query_asset(e));
        usdc.transfer(&e.current_contract_address(), &to, &amount);
    }

    #[when_not_paused]
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

        // Audit VF-02: examine at most MAX_QUEUE_BATCH entries per call.
        // Entries beyond the window are carried over untouched and drained on a
        // later call. `kept` accumulates everything that survives this pass
        // (skipped, deferred, or out-of-window) so removals don't have to be a
        // contiguous head prefix.
        let limit = queue.len().min(MAX_QUEUE_BATCH);
        let mut kept: Vec<WithdrawalRequest> = Vec::new(e);
        let mut hit_capacity = false;

        for i in 0..queue.len() {
            let request = queue.get(i).unwrap();

            // Out-of-batch-window, or we already hit a request we can't fund:
            // preserve FIFO liquidity ordering by keeping this and all later
            // requests for a future call.
            if i >= limit || hit_capacity {
                kept.push_back(request);
                continue;
            }

            let assets = Vault::preview_redeem(e, request.shares);

            if assets > remaining_free {
                // Not enough free capital for the head-most request: stop
                // servicing and defer the rest (strict FIFO).
                hit_capacity = true;
                kept.push_back(request);
                continue;
            }

            // Audit VF-04: a request that previews to zero assets must not stop
            // the drain. Skip it (keep it queued so the owner can still
            // cancel_withdrawal to recover the escrowed shares) and continue.
            if assets == 0 {
                kept.push_back(request);
                continue;
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
            e.storage()
                .persistent()
                .extend_ttl(&key, CLAIMABLE_TTL_LEDGERS, CLAIMABLE_TTL_LEDGERS);
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
            // Persist TMA each iteration so OZ Vault::preview_redeem in the
            // NEXT iteration sees a consistent (total_assets, total_supply)
            // pair — both decremented in lockstep. Otherwise share price
            // drifts upward across the loop and later-in-queue requests
            // get more assets per share than earlier ones.
            e.storage()
                .instance()
                .set(&VaultKey::TotalManagedAssets, &tma);
            processed = processed.checked_add(1).expect("addition overflow");
        }

        if processed > 0 {
            e.storage()
                .instance()
                .set(&VaultKey::WithdrawalQueue, &kept);
        }
    }
}
