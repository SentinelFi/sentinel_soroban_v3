// ERC-4626 style deposit/withdraw/mint/redeem operations, wrapping the OZ
// `Vault` trait with `TotalManagedAssets` tracking so the controller can
// reason about free vs. locked capital.

use soroban_sdk::{contractimpl, Address, Env};
use stellar_tokens::vault::Vault;

use crate::storage::VaultKey;
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl RiskVault {
    pub fn deposit(e: &Env, assets: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let shares = Vault::deposit(e, assets, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        shares
    }

    pub fn withdraw(e: &Env, assets: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
        assert!(assets <= Self::get_free_capital(e), "exceeds free capital");
        let shares = Vault::withdraw(e, assets, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(assets).expect("subtraction underflow"),
        );
        shares
    }

    pub fn mint_shares(e: &Env, shares: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let assets = Vault::mint(e, shares, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        assets
    }

    pub fn redeem(e: &Env, shares: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
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
}
