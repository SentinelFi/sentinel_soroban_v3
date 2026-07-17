// ERC-4626-shaped share/asset conversion surface, with ALL state-changing
// entry and exit routed through the delayed two-phase queues instead.
//
// The `FungibleVault` trait remains implemented even though four of its
// operations are disabled and the `max_*` views return zero. The trait must
// be implemented in full or not at all, and its view half is load-bearing:
// `total_assets`, `query_asset`, `convert_*`, and the `preview_*` quotes are
// the views integrators use to size and value queue requests, while the
// conversion helpers below are the pricing engine for both queue processors.
// Retaining the disabled operations as typed reverts — rather than removing
// them from the ABI — gives a stale caller a contract error identifying the
// replacement path instead of an opaque missing-function failure, and a
// vault-standard-aware integration that honors `max_* == 0` concludes the
// immediate leg is unavailable without submitting a transaction guaranteed
// to fail. This follows the established asynchronous-vault convention
// (ERC-7540 on EVM): retain the standard surface, report zero from the
// `max_*` views for disabled legs, and revert on the operations themselves.
//
// The four immediate operations (deposit/mint/withdraw/redeem) are disabled:
// they priced shares at call time, and any call-time price is stale with
// respect to a flight outcome that is publicly knowable but not yet written
// on-chain — the settlement barrier can only engage once the oracle
// transaction lands. LPs commit via `request_deposit` / `request_withdrawal`
// and are priced by queue processing only after the request outlives
// `LP_PRICING_DELAY_SECS` (see constants.rs), by which time every outcome
// knowable at commitment is on-chain and reflected (or barrier-blocked).
//
// Share pricing is computed against the vault's internal `TotalManagedAssets`
// (TMA) — the true backing figure — NOT the raw token balance. The two differ
// whenever the withdrawal queue has credited a `ClaimableBalance` that the
// owner has not yet `collect`ed (those assets no longer back shares) and
// whenever the deposit queue holds escrowed assets that do not back shares
// YET. The identity is exact:
// raw_balance == TMA + uncollected_claimable + escrowed_deposits,
// so TMA is the net-asset basis.
//
// We reuse the OpenZeppelin `Vault` plumbing only for its metadata surface;
// conversions are supplied from the TMA basis instead of delegating to
// `Vault::deposit`/`redeem`/etc. (which convert against the raw balance).

use soroban_sdk::{contractimpl, panic_with_error, Address, Env};
use stellar_contract_utils::math::{i128_fixed_point::mul_div_with_rounding, Rounding};
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::{FungibleVault, Vault};

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
    /// Disabled. LP entry is two-phase: `request_deposit` escrows the assets
    /// and queue processing mints shares at the delayed, post-outcome price.
    /// An immediate deposit would price at call time — stale with respect to
    /// any outcome that is public but not yet written on-chain.
    fn deposit(
        e: &Env,
        _assets: i128,
        _receiver: Address,
        _from: Address,
        _operator: Address,
    ) -> i128 {
        panic_with_error!(e, Error::DirectEntryDisabled);
    }

    /// Disabled. LP exit is two-phase: `request_withdrawal` escrows the
    /// shares and queue processing pays out at the delayed, post-outcome
    /// price. See `deposit`.
    fn withdraw(
        e: &Env,
        _assets: i128,
        _receiver: Address,
        _owner: Address,
        _operator: Address,
    ) -> i128 {
        panic_with_error!(e, Error::DirectExitDisabled);
    }

    /// Disabled — see `deposit`. There is no share-denominated request path;
    /// use `request_deposit` with an asset amount.
    fn mint(
        e: &Env,
        _shares: i128,
        _receiver: Address,
        _from: Address,
        _operator: Address,
    ) -> i128 {
        panic_with_error!(e, Error::DirectEntryDisabled);
    }

    /// Disabled — see `withdraw`. Use `request_withdrawal` with a share
    /// amount.
    fn redeem(
        e: &Env,
        _shares: i128,
        _receiver: Address,
        _owner: Address,
        _operator: Address,
    ) -> i128 {
        panic_with_error!(e, Error::DirectExitDisabled);
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

    // The `preview_*` views remain as CURRENT-price quotes for sizing
    // queue requests. They are estimates only: actual pricing happens at
    // queue-processing time, after the request matures past the LP pricing
    // delay, and may differ once pending outcomes settle.

    /// Previews the shares a deposit of `assets` would mint at the CURRENT
    /// share price. Informational — a queued deposit is priced at
    /// processing time, not request time.
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

    // The `max_*` views report zero unconditionally: the immediate
    // operations they bound are permanently disabled in favor of the
    // two-phase request queues, and integrations reading a positive limit
    // would submit transactions guaranteed to revert.
    fn max_deposit(_e: &Env, _address: Address) -> i128 {
        0
    }

    /// Returns zero — immediate mints are disabled (see `mint`).
    fn max_mint(_e: &Env, _address: Address) -> i128 {
        0
    }

    /// Returns zero — immediate withdrawals are disabled (see `withdraw`).
    fn max_withdraw(_e: &Env, _owner: Address) -> i128 {
        0
    }

    /// Returns zero — immediate redemptions are disabled (see `redeem`).
    fn max_redeem(_e: &Env, _owner: Address) -> i128 {
        0
    }
}
