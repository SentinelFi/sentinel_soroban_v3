// Controller-only capital management: lock/unlock collateral, record premium
// income, send payouts, drain the withdrawal queue into ClaimableBalance.

use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env, Vec};
use stellar_contract_utils::math::Rounding;
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::auth::{require_controller, settlement_pending};
use crate::constants::{CLAIMABLE_TTL_LEDGERS, MAX_QUEUE_BATCH};
use crate::events::Credited;
use crate::storage::VaultKey;
use crate::vault_ops::managed_convert_to_assets;
use crate::{Error, RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    /// Controller-only: lock additional capital as collateral.
    #[when_not_paused]
    pub fn increase_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let locked = Self::get_locked_capital(e);
        let tma = Self::get_total_managed_assets(e);
        let new_locked = locked.checked_add(amount).expect("addition overflow");
        if new_locked > tma {
            panic_with_error!(e, Error::WouldExceedTotalManagedAssets);
        }
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &new_locked);
    }

    /// Controller-only: release previously locked collateral capital.
    #[when_not_paused]
    pub fn decrease_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let locked = Self::get_locked_capital(e);
        if amount > locked {
            panic_with_error!(e, Error::WouldGoNegative);
        }
        e.storage().instance().set(
            &VaultKey::LockedCapital,
            &locked.checked_sub(amount).expect("subtraction underflow"),
        );
    }

    /// Controller-only: credit received premium income to managed assets.
    #[when_not_paused]
    pub fn record_premium_income(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let old_tma = Self::get_total_managed_assets(e);
        let new_tma = old_tma.checked_add(amount).expect("addition overflow");

        // Defensive: the pool transfers asset to the vault BEFORE calling this.
        // Reject the credit if the vault's asset balance can't cover the new
        // TMA — catches the "controller called us but no asset arrived" path
        // (compromised or buggy caller). Note: outstanding ClaimableBalance
        // entries are not part of TMA (they were decremented at credit
        // time), so the check is a strict floor on managed assets.
        let asset = token::Client::new(e, &Vault::query_asset(e));
        let balance = asset.balance(&e.current_contract_address());
        if balance < new_tma {
            panic_with_error!(e, Error::PremiumNotReceived);
        }

        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &new_tma);
    }

    /// Controller-only: transfer a claim payout from managed assets to a recipient.
    #[when_not_paused]
    pub fn send_payout(e: &Env, controller: Address, to: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let tma = Self::get_total_managed_assets(e);
        if amount > tma {
            panic_with_error!(e, Error::InsufficientManagedAssets);
        }

        // Decrement TMA before the external transfer.
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(amount).expect("subtraction underflow"),
        );

        let asset = token::Client::new(e, &Vault::query_asset(e));
        asset.transfer(&e.current_contract_address(), &to, &amount);
    }

    /// Controller-only: drain queued withdrawals into claimable balances (batched, FIFO).
    #[when_not_paused]
    pub fn process_withdrawal_queue(e: &Env, controller: Address) {
        require_controller(e, &controller);
        Self::extend_ttl(e);

        // Do not price queued exits while a public flight outcome is unsettled —
        // that would hand the exiting LP the pre-settlement (stale) share price
        // and shift the pending loss to the remaining LPs. The keeper drains the
        // queue after settlement, when the vault's PnL is recognized; until then
        // this is a no-op and the requests stay queued.
        if settlement_pending(e) {
            return;
        }

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

        // Examine at most MAX_QUEUE_BATCH entries per call.
        // Entries beyond the window are carried over untouched and drained on a
        // later call. `kept` accumulates everything that survives this pass
        // (skipped, deferred, or out-of-window) so removals don't have to be a
        // contiguous head prefix.
        let limit = queue.len().min(MAX_QUEUE_BATCH);
        let mut kept: Vec<WithdrawalRequest> = Vec::new(e);
        let mut hit_capacity = false;
        let mut returned_any = false;

        for i in 0..queue.len() {
            let request = queue.get(i).unwrap();

            // Out-of-batch-window, or we already hit a request we can't fund:
            // preserve FIFO liquidity ordering by keeping this and all later
            // requests for a future call.
            if i >= limit || hit_capacity {
                kept.push_back(request);
                continue;
            }

            let assets = managed_convert_to_assets(e, request.shares, Rounding::Floor);

            if assets > remaining_free {
                // Not enough free capital for the head-most request: stop
                // servicing and defer the rest (strict FIFO).
                hit_capacity = true;
                kept.push_back(request);
                continue;
            }

            // A request that has decayed to zero asset value (e.g. a payout
            // reduced the share price after it was queued) must not sit at the
            // head and starve later requests. Return the escrowed shares to the
            // owner and drop it — the owner keeps their shares and may
            // re-request. Dropping it advances the queue instead of pinning it.
            if assets == 0 {
                Base::update(e, Some(&vault_addr), Some(&request.owner), request.shares);
                returned_any = true;
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

        if processed > 0 || returned_any {
            e.storage()
                .instance()
                .set(&VaultKey::WithdrawalQueue, &kept);
        }
    }
}
