# OZ Stellar — Tokenized Vault (ERC-4626 Style)

## Overview

The vault manages share-to-asset conversions with configurable precision offset and rounding protections. Depositors receive shares proportional to their deposit relative to total assets.

## Setup

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};
use stellar_tokens::fungible::{Base, FungibleToken};
use stellar_tokens::fungible::vault::{Vault, FungibleVault};

#[contract]
pub struct MyVault;

#[contractimpl]
impl MyVault {
    pub fn __constructor(e: &Env, asset: Address) {
        // Set underlying asset (immutable after this call)
        Vault::set_asset(e, &asset);
        // Set decimals offset for inflation attack protection (immutable, max 10)
        Vault::set_decimals_offset(e, 0);
        // Set vault share token metadata
        Base::set_metadata(e, 7, String::from_str(e, "Vault Shares"), String::from_str(e, "vSHR"));
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for MyVault {
    type ContractType = Vault;
}

#[contractimpl(contracttrait)]
impl FungibleVault for MyVault {}
```

## Vault trait — key functions

### Deposit / withdraw

```rust
// Deposit assets, receive shares
Vault::deposit(e, assets: i128, receiver: Address, from: Address, operator: Address) -> i128

// Withdraw assets by specifying asset amount, burns shares
Vault::withdraw(e, assets: i128, receiver: Address, owner: Address, operator: Address) -> i128

// Mint specific number of shares, pulls required assets
Vault::mint(shares: i128, receiver: Address, from: Address, operator: Address) -> i128

// Redeem shares for assets
Vault::redeem(shares: i128, receiver: Address, owner: Address, operator: Address) -> i128
```

### Preview / query functions

```rust
// Preview conversions (view-only)
Vault::preview_deposit(assets: i128) -> i128    // assets → shares
Vault::preview_mint(shares: i128) -> i128       // shares → assets needed
Vault::preview_withdraw(assets: i128) -> i128   // assets → shares needed
Vault::preview_redeem(shares: i128) -> i128     // shares → assets returned

// Direct conversion helpers
Vault::convert_to_shares(assets: i128) -> i128
Vault::convert_to_assets(shares: i128) -> i128

// Query
Vault::query_asset() -> Address     // underlying asset (panics if unset)
Vault::total_assets() -> i128       // total managed assets

// Max limits
Vault::max_deposit(address) -> i128
Vault::max_mint(address) -> i128
Vault::max_withdraw(address) -> i128
Vault::max_redeem(address) -> i128
```

## Share conversion formulas

**Standard:**
```
shares = (assets × totalSupply) / totalAssets
assets = (shares × totalAssets) / totalSupply
```

**With virtual decimals offset:**
```
shares = (assets × (totalSupply + 10^offset)) / (totalAssets + 1)
```

## Rounding behavior

| Operation | Input | Output | Rounding |
|-----------|-------|--------|----------|
| deposit | assets | shares | Down (fewer shares) |
| mint | shares | assets | Up (more assets needed) |
| withdraw | assets | shares | Up (more shares burned) |
| redeem | shares | assets | Down (fewer assets returned) |

This protects against rounding exploits in all directions.

## Initialization constraints

- `Vault::set_asset()` — **immutable** after first call
- `Vault::set_decimals_offset()` — **immutable** after first call, max value 10
- The offset adds virtual shares to protect against inflation attacks (rounding to zero on first deposit)
