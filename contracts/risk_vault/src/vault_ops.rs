// ERC-4626 style deposit/withdraw/mint/redeem operations, wrapping the OZ
// `Vault` trait with `TotalManagedAssets` tracking so the controller can
// reason about free vs. locked capital.

use soroban_sdk::{contractimpl, Address, Env};
use stellar_contract_utils::pausable::paused;
use stellar_macros::when_not_paused;
use stellar_tokens::vault::{FungibleVault, Vault};

use crate::storage::VaultKey;
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl FungibleVault for RiskVault {
    #[when_not_paused]
    fn deposit(e: &Env, assets: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let shares = Vault::deposit(e, assets, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        shares
    }

    #[when_not_paused]
    fn withdraw(
        e: &Env,
        assets: i128,
        receiver: Address,
        owner: Address,
        operator: Address,
    ) -> i128 {
        // Audit ASF-02: once any underwriter is queued, the queue is the canonical
        // exit path — block direct exits so a latecomer can't consume free capital
        // ahead of LPs already waiting in FIFO order. When the queue is empty this
        // fast path stays open.
        assert!(
            Self::get_withdrawal_queue(e).is_empty(),
            "withdrawal queue active; use request_withdrawal",
        );
        assert!(assets <= Self::get_free_capital(e), "exceeds free capital");
        let shares = Vault::withdraw(e, assets, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(assets).expect("subtraction underflow"),
        );
        shares
    }

    #[when_not_paused]
    fn mint(e: &Env, shares: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let assets = Vault::mint(e, shares, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        assets
    }

    #[when_not_paused]
    fn redeem(e: &Env, shares: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
        // Audit ASF-02: see `withdraw` — direct redeem defers to the queue while
        // any request is pending so it can't jump the FIFO line.
        assert!(
            Self::get_withdrawal_queue(e).is_empty(),
            "withdrawal queue active; use request_withdrawal",
        );
        let assets = Vault::preview_redeem(e, shares);
        assert!(assets <= Self::get_free_capital(e), "exceeds free capital");
        let actual_assets = Vault::redeem(e, shares, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(actual_assets)
                .expect("subtraction underflow"),
        );
        actual_assets
    }

    fn total_assets(e: &Env) -> i128 {
        Vault::total_assets(e)
    }

    fn query_asset(e: &Env) -> Address {
        Vault::query_asset(e)
    }

    fn convert_to_shares(e: &Env, assets: i128) -> i128 {
        Vault::convert_to_shares(e, assets)
    }

    fn convert_to_assets(e: &Env, shares: i128) -> i128 {
        Vault::convert_to_assets(e, shares)
    }

    fn preview_deposit(e: &Env, assets: i128) -> i128 {
        Vault::preview_deposit(e, assets)
    }

    fn preview_mint(e: &Env, shares: i128) -> i128 {
        Vault::preview_mint(e, shares)
    }

    fn preview_withdraw(e: &Env, assets: i128) -> i128 {
        Vault::preview_withdraw(e, assets)
    }

    fn preview_redeem(e: &Env, shares: i128) -> i128 {
        Vault::preview_redeem(e, shares)
    }

    // Audit VF-17: the executable deposit/mint/withdraw/redeem paths are all
    // `#[when_not_paused]`, so the `max_*` views must report zero while paused.
    // Otherwise integrations read a positive limit and submit transactions that
    // revert during a pause.
    fn max_deposit(e: &Env, address: Address) -> i128 {
        if paused(e) {
            return 0;
        }
        Vault::max_deposit(e, address)
    }

    fn max_mint(e: &Env, address: Address) -> i128 {
        if paused(e) {
            return 0;
        }
        Vault::max_mint(e, address)
    }

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
