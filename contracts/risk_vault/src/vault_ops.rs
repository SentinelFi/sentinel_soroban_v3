// ERC-4626 style deposit/withdraw/mint/redeem operations, wrapping the OZ
// `Vault` trait with `TotalManagedAssets` tracking so the controller can
// reason about free vs. locked capital.

use soroban_sdk::{contractimpl, panic_with_error, Address, Env};
use stellar_contract_utils::pausable::paused;
use stellar_macros::when_not_paused;
use stellar_tokens::vault::{FungibleVault, Vault};

use crate::storage::VaultKey;
use crate::{Error, RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl FungibleVault for RiskVault {
    /// Deposits `assets` for `receiver`, minting shares and tracking total managed assets.
    #[when_not_paused]
    fn deposit(e: &Env, assets: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        Self::extend_ttl(e);
        let shares = Vault::deposit(e, assets, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        shares
    }

    /// Withdraws `assets` to `receiver`, blocked while the withdrawal queue is active or if it exceeds free capital.
    #[when_not_paused]
    fn withdraw(
        e: &Env,
        assets: i128,
        receiver: Address,
        owner: Address,
        operator: Address,
    ) -> i128 {
        Self::extend_ttl(e);
        // Once any underwriter is queued, the queue is the canonical
        // exit path — block direct exits so a latecomer can't consume free capital
        // ahead of LPs already waiting in FIFO order. When the queue is empty this
        // fast path stays open.
        if !Self::get_withdrawal_queue(e).is_empty() {
            panic_with_error!(e, Error::WithdrawalQueueActive);
        }
        if assets > Self::get_free_capital(e) {
            panic_with_error!(e, Error::ExceedsFreeCapital);
        }
        let shares = Vault::withdraw(e, assets, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(assets).expect("subtraction underflow"),
        );
        shares
    }

    /// Mints `shares` to `receiver`, pulling the required assets and tracking total managed assets.
    #[when_not_paused]
    fn mint(e: &Env, shares: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        Self::extend_ttl(e);
        let assets = Vault::mint(e, shares, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        assets
    }

    /// Redeems `shares` for assets to `receiver`, blocked while the withdrawal queue is active or if it exceeds free capital.
    #[when_not_paused]
    fn redeem(e: &Env, shares: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
        Self::extend_ttl(e);
        // See `withdraw` — direct redeem defers to the queue while
        // any request is pending so it can't jump the FIFO line.
        if !Self::get_withdrawal_queue(e).is_empty() {
            panic_with_error!(e, Error::WithdrawalQueueActive);
        }
        let assets = Vault::preview_redeem(e, shares);
        if assets > Self::get_free_capital(e) {
            panic_with_error!(e, Error::ExceedsFreeCapital);
        }
        let actual_assets = Vault::redeem(e, shares, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(actual_assets)
                .expect("subtraction underflow"),
        );
        actual_assets
    }

    /// Returns the total assets held by the vault.
    fn total_assets(e: &Env) -> i128 {
        Vault::total_assets(e)
    }

    /// Returns the address of the underlying asset token.
    fn query_asset(e: &Env) -> Address {
        Vault::query_asset(e)
    }

    /// Converts an amount of assets to the equivalent number of shares.
    fn convert_to_shares(e: &Env, assets: i128) -> i128 {
        Vault::convert_to_shares(e, assets)
    }

    /// Converts a number of shares to the equivalent amount of assets.
    fn convert_to_assets(e: &Env, shares: i128) -> i128 {
        Vault::convert_to_assets(e, shares)
    }

    /// Previews the shares that would be minted for a given deposit of assets.
    fn preview_deposit(e: &Env, assets: i128) -> i128 {
        Vault::preview_deposit(e, assets)
    }

    /// Previews the assets required to mint a given number of shares.
    fn preview_mint(e: &Env, shares: i128) -> i128 {
        Vault::preview_mint(e, shares)
    }

    /// Previews the shares that would be burned to withdraw a given amount of assets.
    fn preview_withdraw(e: &Env, assets: i128) -> i128 {
        Vault::preview_withdraw(e, assets)
    }

    /// Previews the assets that would be returned for redeeming a given number of shares.
    fn preview_redeem(e: &Env, shares: i128) -> i128 {
        Vault::preview_redeem(e, shares)
    }

    // The executable deposit/mint/withdraw/redeem paths are all
    // `#[when_not_paused]`, so the `max_*` views must report zero while paused.
    // Otherwise integrations read a positive limit and submit transactions that
    // revert during a pause.
    fn max_deposit(e: &Env, address: Address) -> i128 {
        if paused(e) {
            return 0;
        }
        Vault::max_deposit(e, address)
    }

    /// Returns the maximum shares mintable for `address`, or zero while paused.
    fn max_mint(e: &Env, address: Address) -> i128 {
        if paused(e) {
            return 0;
        }
        Vault::max_mint(e, address)
    }

    /// Returns the maximum assets `owner` can withdraw (capped by free capital), or zero while paused.
    fn max_withdraw(e: &Env, owner: Address) -> i128 {
        if paused(e) {
            return 0;
        }
        let vault_max = Vault::max_withdraw(e, owner);
        let free = Self::get_free_capital(e);
        if vault_max < free {
            vault_max
        } else {
            free
        }
    }

    /// Returns the maximum shares `owner` can redeem (capped by free capital), or zero while paused.
    fn max_redeem(e: &Env, owner: Address) -> i128 {
        if paused(e) {
            return 0;
        }
        let vault_max = Vault::max_redeem(e, owner);
        let free_capital = Self::get_free_capital(e);
        let free_shares = Vault::convert_to_shares(e, free_capital);
        if vault_max < free_shares {
            vault_max
        } else {
            free_shares
        }
    }
}
