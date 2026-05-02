#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, MuxedAddress, String, Vec};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;
use stellar_tokens::fungible::{Base, FungibleToken};
use stellar_tokens::vault::Vault;

#[contracttype]
#[derive(Clone)]
pub enum VaultKey {
    Controller,
    TotalManagedAssets,
    LockedCapital,
    WithdrawalQueue,
    ClaimableBalance(Address),
    LastSnapshotTime,
    SnapshotPrice(u64),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawalRequest {
    pub owner: Address,
    pub shares: i128,
    pub timestamp: u64,
}

const SECONDS_PER_DAY: u64 = 86400;

#[contract]
pub struct RiskVault;

fn require_controller(e: &Env, controller: &Address) {
    controller.require_auth();
    let stored: Address = e
        .storage()
        .instance()
        .get(&VaultKey::Controller)
        .expect("controller not set");
    assert!(controller == &stored, "not controller");
}

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
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &0i128);
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &0u64);
    }

    // ─── Owner-only ───

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

    // ─── Vault operations (wrapping OZ Vault with TMA tracking) ───

    pub fn deposit(e: &Env, assets: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let shares = Vault::deposit(e, assets, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &(tma + assets));
        shares
    }

    pub fn withdraw(e: &Env, assets: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
        assert!(assets <= Self::get_free_capital(e), "exceeds free capital");
        let shares = Vault::withdraw(e, assets, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &(tma - assets));
        shares
    }

    pub fn mint_shares(e: &Env, shares: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let assets = Vault::mint(e, shares, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &(tma + assets));
        assets
    }

    pub fn redeem(e: &Env, shares: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
        let assets = Vault::preview_redeem(e, shares);
        assert!(assets <= Self::get_free_capital(e), "exceeds free capital");
        let actual_assets = Vault::redeem(e, shares, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &(tma - actual_assets));
        actual_assets
    }

    // ─── Vault query functions (delegate to OZ) ───

    pub fn total_assets(e: &Env) -> i128 {
        Vault::total_assets(e)
    }

    pub fn asset(e: &Env) -> Address {
        Vault::query_asset(e)
    }

    pub fn convert_to_shares(e: &Env, assets: i128) -> i128 {
        Vault::convert_to_shares(e, assets)
    }

    pub fn convert_to_assets(e: &Env, shares: i128) -> i128 {
        Vault::convert_to_assets(e, shares)
    }

    pub fn preview_deposit(e: &Env, assets: i128) -> i128 {
        Vault::preview_deposit(e, assets)
    }

    pub fn preview_mint(e: &Env, shares: i128) -> i128 {
        Vault::preview_mint(e, shares)
    }

    pub fn preview_withdraw(e: &Env, assets: i128) -> i128 {
        Vault::preview_withdraw(e, assets)
    }

    pub fn preview_redeem(e: &Env, shares: i128) -> i128 {
        Vault::preview_redeem(e, shares)
    }

    pub fn max_deposit(e: &Env, address: Address) -> i128 {
        Vault::max_deposit(e, address)
    }

    pub fn max_mint(e: &Env, address: Address) -> i128 {
        Vault::max_mint(e, address)
    }

    pub fn max_withdraw(e: &Env, owner: Address) -> i128 {
        let vault_max = Vault::max_withdraw(e, owner);
        let free = Self::get_free_capital(e);
        if vault_max < free {
            vault_max
        } else {
            free
        }
    }

    pub fn max_redeem(e: &Env, owner: Address) -> i128 {
        let vault_max = Vault::max_redeem(e, owner);
        let free_capital = Self::get_free_capital(e);
        let free_shares = Vault::convert_to_shares(e, free_capital);
        if vault_max < free_shares {
            vault_max
        } else {
            free_shares
        }
    }

    // ─── Controller-only functions ───

    pub fn increase_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let locked = Self::get_locked_capital(e);
        let tma = Self::get_total_managed_assets(e);
        assert!(locked + amount <= tma, "would exceed total managed assets");
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &(locked + amount));
    }

    pub fn decrease_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let locked = Self::get_locked_capital(e);
        assert!(amount <= locked, "would go negative");
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &(locked - amount));
    }

    pub fn record_premium_income(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let tma = Self::get_total_managed_assets(e);
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &(tma + amount));
    }

    pub fn send_payout(e: &Env, controller: Address, to: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let tma = Self::get_total_managed_assets(e);
        assert!(amount <= tma, "insufficient managed assets");

        let usdc = token::Client::new(e, &Vault::query_asset(e));
        usdc.transfer(&e.current_contract_address(), &to, &amount);

        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &(tma - amount));
    }

    pub fn process_withdrawal_queue(e: &Env, controller: Address) {
        require_controller(e, &controller);

        let queue: Vec<WithdrawalRequest> = e
            .storage()
            .persistent()
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
            let claimable: i128 = e
                .storage()
                .persistent()
                .get(&VaultKey::ClaimableBalance(request.owner.clone()))
                .unwrap_or(0);
            e.storage().persistent().set(
                &VaultKey::ClaimableBalance(request.owner),
                &(claimable + assets),
            );

            remaining_free -= assets;
            tma -= assets;
            processed += 1;
        }

        if processed > 0 {
            let mut new_queue = Vec::new(e);
            for i in processed..queue.len() {
                new_queue.push_back(queue.get(i).unwrap());
            }
            e.storage()
                .persistent()
                .set(&VaultKey::WithdrawalQueue, &new_queue);
            e.storage()
                .instance()
                .set(&VaultKey::TotalManagedAssets, &tma);
        }
    }

    // ─── Withdrawal queue (underwriter-facing) ───

    pub fn request_withdrawal(e: &Env, caller: Address, shares: i128) {
        caller.require_auth();
        assert!(shares > 0, "shares must be positive");

        // Escrow shares: transfer from caller to vault
        Base::update(e, Some(&caller), Some(&e.current_contract_address()), shares);

        let mut queue: Vec<WithdrawalRequest> = e
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        queue.push_back(WithdrawalRequest {
            owner: caller,
            shares,
            timestamp: e.ledger().timestamp(),
        });

        e.storage()
            .persistent()
            .set(&VaultKey::WithdrawalQueue, &queue);
    }

    pub fn cancel_withdrawal(e: &Env, caller: Address, queue_index: u32) {
        caller.require_auth();

        let mut queue: Vec<WithdrawalRequest> = e
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        let request = queue.get(queue_index).expect("invalid queue index");
        assert!(request.owner == caller, "not your request");

        // Return escrowed shares to caller
        Base::update(e, Some(&e.current_contract_address()), Some(&caller), request.shares);

        queue.remove(queue_index);
        e.storage()
            .persistent()
            .set(&VaultKey::WithdrawalQueue, &queue);
    }

    pub fn collect(e: &Env, caller: Address) {
        caller.require_auth();

        let key = VaultKey::ClaimableBalance(caller.clone());
        let claimable: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        assert!(claimable > 0, "nothing to collect");

        let usdc = token::Client::new(e, &Vault::query_asset(e));
        usdc.transfer(&e.current_contract_address(), &caller, &claimable);

        e.storage().persistent().remove(&key);
    }

    // ─── Snapshot ───

    pub fn snapshot(e: &Env) {
        let now = e.ledger().timestamp();
        let last: u64 = e
            .storage()
            .instance()
            .get(&VaultKey::LastSnapshotTime)
            .unwrap_or(0);

        // No-op if already snapshotted today (safe to call repeatedly)
        if last != 0 && now < last + SECONDS_PER_DAY {
            return;
        }

        let total_supply = Base::total_supply(e);
        let price = if total_supply > 0 {
            Vault::total_assets(e) * 10_000_000i128 / total_supply
        } else {
            10_000_000i128
        };

        let day = now / SECONDS_PER_DAY;
        e.storage()
            .persistent()
            .set(&VaultKey::SnapshotPrice(day), &price);
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &now);
    }

    // ─── TTL management ───

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(120_960, 535_680);
    }

    // ─── Query functions ───

    pub fn get_total_managed_assets(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&VaultKey::TotalManagedAssets)
            .unwrap_or(0)
    }

    pub fn get_locked_capital(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&VaultKey::LockedCapital)
            .unwrap_or(0)
    }

    pub fn get_free_capital(e: &Env) -> i128 {
        let tma = Self::get_total_managed_assets(e);
        let locked = Self::get_locked_capital(e);
        tma - locked
    }

    pub fn get_controller(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&VaultKey::Controller)
            .unwrap()
    }

    pub fn get_withdrawal_queue(e: &Env) -> Vec<WithdrawalRequest> {
        e.storage()
            .persistent()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e))
    }

    pub fn get_claimable_balance(e: &Env, address: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&VaultKey::ClaimableBalance(address))
            .unwrap_or(0)
    }

    pub fn get_snapshot_price(e: &Env, day: u64) -> i128 {
        e.storage()
            .persistent()
            .get(&VaultKey::SnapshotPrice(day))
            .unwrap_or(0)
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for RiskVault {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl Ownable for RiskVault {}

#[cfg(test)]
mod test;
