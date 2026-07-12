// ERC-4626 style deposit/withdraw/mint/redeem operations.
//
// Share pricing is computed against the vault's internal `TotalManagedAssets`
// (TMA) — the true backing figure — NOT the raw token balance. The two differ
// whenever the withdrawal queue has credited a `ClaimableBalance` that the
// owner has not yet `collect`ed: those assets physically sit in the vault but no
// longer back outstanding shares (TMA was already reduced when they were
// credited). Pricing on the raw balance would count that owed-but-uncollected
// value as backing and let existing holders extract it from later depositors.
// The identity is exact: raw_balance == TMA + uncollected_claimable, so TMA is
// the net-asset basis.
//
// We reuse the OpenZeppelin `Vault` share-mint/burn + transfer plumbing
// (`deposit_internal` / `withdraw_internal`) and its event emitters, but supply
// the share/asset amounts ourselves from the TMA basis instead of delegating to
// `Vault::deposit`/`redeem`/etc. (which convert against the raw balance).

use soroban_sdk::{contractimpl, panic_with_error, Address, Env};
use stellar_contract_utils::math::{i128_fixed_point::mul_div_with_rounding, Rounding};
use stellar_contract_utils::pausable::paused;
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::{emit_deposit, emit_withdraw, FungibleVault, Vault};

use crate::auth::{assert_no_settlement_pending, settlement_pending};
use crate::storage::VaultKey;
use crate::{Error, RiskVault, RiskVaultArgs, RiskVaultClient};

// Convert assets → shares against the TMA basis, mirroring the OZ formula
// `shares = assets * (total_supply + 10^offset) / (TMA + 1)` (with the virtual
// offset preserving the inflation-attack defense) but reading TMA rather than
// the raw token balance.
pub(crate) fn managed_convert_to_shares(e: &Env, assets: i128, rounding: Rounding) -> i128 {
    if assets <= 0 {
        return 0;
    }
    let pow = 10_i128
        .checked_pow(Vault::get_decimals_offset(e))
        .expect("decimals offset overflow");
    let supply_plus = Base::total_supply(e)
        .checked_add(pow)
        .expect("supply overflow");
    let managed_plus = RiskVault::get_total_managed_assets(e)
        .checked_add(1)
        .expect("managed assets overflow");
    mul_div_with_rounding(e, assets, supply_plus, managed_plus, rounding)
}

// Convert shares → assets against the TMA basis: mirror of
// `assets = shares * (TMA + 1) / (total_supply + 10^offset)`.
pub(crate) fn managed_convert_to_assets(e: &Env, shares: i128, rounding: Rounding) -> i128 {
    convert_to_assets_with_tma(e, shares, RiskVault::get_total_managed_assets(e), rounding)
}

// Convert assets → shares against an explicitly supplied managed-asset
// figure — the inverse of `convert_to_assets_with_tma`, used by the queue
// processor to size a partial fill of the head request from the free capital
// still available in the pass. Floor rounding guarantees the floor-floor
// round trip (assets → shares → assets) never exceeds the input amount.
pub(crate) fn convert_to_shares_with_tma(
    e: &Env,
    assets: i128,
    tma: i128,
    rounding: Rounding,
) -> i128 {
    if assets <= 0 {
        return 0;
    }
    let pow = 10_i128
        .checked_pow(Vault::get_decimals_offset(e))
        .expect("decimals offset overflow");
    let supply_plus = Base::total_supply(e)
        .checked_add(pow)
        .expect("supply overflow");
    let managed_plus = tma.checked_add(1).expect("managed assets overflow");
    mul_div_with_rounding(e, assets, supply_plus, managed_plus, rounding)
}

// Same conversion against an explicitly supplied managed-asset figure. The
// queue processor prices many requests in one pass while tracking the running
// total locally (share supply is read live — burns update it in place), so it
// can defer the storage write of TMA to the end of the loop without the
// per-request share price drifting.
pub(crate) fn convert_to_assets_with_tma(
    e: &Env,
    shares: i128,
    tma: i128,
    rounding: Rounding,
) -> i128 {
    if shares <= 0 {
        return 0;
    }
    let pow = 10_i128
        .checked_pow(Vault::get_decimals_offset(e))
        .expect("decimals offset overflow");
    let managed_plus = tma.checked_add(1).expect("managed assets overflow");
    let supply_plus = Base::total_supply(e)
        .checked_add(pow)
        .expect("supply overflow");
    mul_div_with_rounding(e, shares, managed_plus, supply_plus, rounding)
}

#[contractimpl]
impl FungibleVault for RiskVault {
    /// Deposits `assets` for `receiver`, minting shares priced on managed assets.
    #[when_not_paused]
    fn deposit(e: &Env, assets: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        Self::extend_ttl(e);
        operator.require_auth();
        assert_no_settlement_pending(e);
        if assets <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let shares = managed_convert_to_shares(e, assets, Rounding::Floor);
        // A deposit small enough to floor to zero shares would transfer the
        // assets in and mint nothing — silently donating the caller's value to
        // existing holders. Reject it; the caller can deposit a larger amount.
        if shares == 0 {
            panic_with_error!(e, Error::AssetsConvertToZeroShares);
        }
        // Transfer assets in + mint shares (OZ plumbing; assumes prior auth).
        Vault::deposit_internal(e, &receiver, assets, shares, &from, &operator);
        emit_deposit(e, &operator, &from, &receiver, assets, shares);
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
        operator.require_auth();
        // Block direct exit while a public flight outcome is unsettled — the LP
        // must use the withdrawal queue, which prices only after settlement.
        assert_no_settlement_pending(e);
        // Once any underwriter is queued, the queue is the canonical
        // exit path — block direct exits so a latecomer can't consume free capital
        // ahead of LPs already waiting in FIFO order. When the queue is empty this
        // fast path stays open.
        if !Self::get_withdrawal_queue(e).is_empty() {
            panic_with_error!(e, Error::WithdrawalQueueActive);
        }
        if assets <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        if assets > Self::get_free_capital(e) {
            panic_with_error!(e, Error::ExceedsFreeCapital);
        }
        let shares = managed_convert_to_shares(e, assets, Rounding::Ceil);
        Vault::withdraw_internal(e, &receiver, &owner, assets, shares, &operator);
        emit_withdraw(e, &operator, &receiver, &owner, assets, shares);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(assets).expect("subtraction underflow"),
        );
        shares
    }

    /// Mints `shares` to `receiver`, pulling the required assets priced on managed assets.
    #[when_not_paused]
    fn mint(e: &Env, shares: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        Self::extend_ttl(e);
        operator.require_auth();
        assert_no_settlement_pending(e);
        if shares <= 0 {
            panic_with_error!(e, Error::SharesMustBePositive);
        }
        // Ceil rounding on a positive share count always yields >= 1 asset, so
        // the mint path cannot pull zero assets for a positive mint.
        let assets = managed_convert_to_assets(e, shares, Rounding::Ceil);
        Vault::deposit_internal(e, &receiver, assets, shares, &from, &operator);
        emit_deposit(e, &operator, &from, &receiver, assets, shares);
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
        operator.require_auth();
        // Block direct exit while a public flight outcome is unsettled — the LP
        // must use the withdrawal queue, which prices only after settlement.
        assert_no_settlement_pending(e);
        // See `withdraw` — direct redeem defers to the queue while
        // any request is pending so it can't jump the FIFO line.
        if !Self::get_withdrawal_queue(e).is_empty() {
            panic_with_error!(e, Error::WithdrawalQueueActive);
        }
        if shares <= 0 {
            panic_with_error!(e, Error::SharesMustBePositive);
        }
        let assets = managed_convert_to_assets(e, shares, Rounding::Floor);
        // A dust redemption that floors to zero assets would burn the caller's
        // shares and return nothing — donating their value to the remaining
        // holders. Reject it instead.
        if assets == 0 {
            panic_with_error!(e, Error::SharesRedeemToZeroAssets);
        }
        if assets > Self::get_free_capital(e) {
            panic_with_error!(e, Error::ExceedsFreeCapital);
        }
        Vault::withdraw_internal(e, &receiver, &owner, assets, shares, &operator);
        emit_withdraw(e, &operator, &receiver, &owner, assets, shares);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(assets).expect("subtraction underflow"),
        );
        assets
    }

    /// Returns the vault's net backing assets — the internally tracked managed
    /// assets, NOT the raw token balance (which includes owed-but-uncollected
    /// withdrawal liabilities).
    fn total_assets(e: &Env) -> i128 {
        Self::get_total_managed_assets(e)
    }

    /// Returns the address of the underlying asset token.
    fn query_asset(e: &Env) -> Address {
        Vault::query_asset(e)
    }

    /// Converts an amount of assets to the equivalent number of shares.
    fn convert_to_shares(e: &Env, assets: i128) -> i128 {
        managed_convert_to_shares(e, assets, Rounding::Floor)
    }

    /// Converts a number of shares to the equivalent amount of assets.
    fn convert_to_assets(e: &Env, shares: i128) -> i128 {
        managed_convert_to_assets(e, shares, Rounding::Floor)
    }

    /// Previews the shares that would be minted for a given deposit of assets.
    fn preview_deposit(e: &Env, assets: i128) -> i128 {
        managed_convert_to_shares(e, assets, Rounding::Floor)
    }

    /// Previews the assets required to mint a given number of shares.
    fn preview_mint(e: &Env, shares: i128) -> i128 {
        managed_convert_to_assets(e, shares, Rounding::Ceil)
    }

    /// Previews the shares that would be burned to withdraw a given amount of assets.
    fn preview_withdraw(e: &Env, assets: i128) -> i128 {
        managed_convert_to_shares(e, assets, Rounding::Ceil)
    }

    /// Previews the assets that would be returned for redeeming a given number of shares.
    fn preview_redeem(e: &Env, shares: i128) -> i128 {
        managed_convert_to_assets(e, shares, Rounding::Floor)
    }

    // The `max_*` views must report zero whenever the corresponding executable
    // path is globally disabled, or integrations read a positive limit and
    // submit transactions guaranteed to revert. Each view therefore mirrors
    // every global gate of its operation: the pause switch and the settlement
    // barrier for all four, plus the active-queue guard for the direct exits
    // (`withdraw`/`redeem` defer to the queue while any request is pending).
    fn max_deposit(e: &Env, address: Address) -> i128 {
        if paused(e) || settlement_pending(e) {
            return 0;
        }
        Vault::max_deposit(e, address)
    }

    /// Returns the maximum shares mintable for `address`, or zero while
    /// deposits are globally disabled (paused or settlement pending).
    fn max_mint(e: &Env, address: Address) -> i128 {
        if paused(e) || settlement_pending(e) {
            return 0;
        }
        Vault::max_mint(e, address)
    }

    /// Returns the maximum assets `owner` can withdraw (their share balance
    /// priced on managed assets, capped by free capital), or zero while direct
    /// exits are globally disabled (paused, settlement pending, or queue active).
    fn max_withdraw(e: &Env, owner: Address) -> i128 {
        if paused(e) || settlement_pending(e) || !Self::get_withdrawal_queue(e).is_empty() {
            return 0;
        }
        let owner_assets = managed_convert_to_assets(e, Base::balance(e, &owner), Rounding::Floor);
        let free = Self::get_free_capital(e);
        owner_assets.min(free)
    }

    /// Returns the maximum shares `owner` can redeem (their balance capped by
    /// the shares equivalent of free capital), or zero while direct exits are
    /// globally disabled (paused, settlement pending, or queue active).
    fn max_redeem(e: &Env, owner: Address) -> i128 {
        if paused(e) || settlement_pending(e) || !Self::get_withdrawal_queue(e).is_empty() {
            return 0;
        }
        let owner_shares = Base::balance(e, &owner);
        let free_shares = managed_convert_to_shares(e, Self::get_free_capital(e), Rounding::Floor);
        owner_shares.min(free_shares)
    }
}
