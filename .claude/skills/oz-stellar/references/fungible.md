# OZ Stellar — Fungible Tokens

## Contract type variants

| Variant | `type ContractType =` | Behavior |
|---|---|---|
| `Base` | `Base` | Standard fungible token (SEP-41 / ERC-20 compatible) |
| `AllowList` | `AllowList` | Only allow-listed addresses can send/receive |
| `BlockList` | `BlockList` | Blocked addresses cannot send/receive |

All variants share the `FungibleToken` trait.

## Full example — GameCurrency with burn

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};
use stellar_tokens::fungible::{burnable::FungibleBurnable, Base, ContractOverrides, FungibleToken};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

#[contract]
pub struct GameCurrency;

#[contractimpl]
impl GameCurrency {
    pub fn __constructor(e: &Env, initial_owner: Address) {
        Base::set_metadata(e, 8, String::from_str(e, "Game Currency"), String::from_str(e, "GCUR"));
        ownable::set_owner(e, &initial_owner);
    }

    #[only_owner]
    pub fn mint_tokens(e: &Env, to: Address, amount: i128) {
        Base::mint(e, &to, amount);
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for GameCurrency {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl FungibleBurnable for GameCurrency {}

#[contractimpl(contracttrait)]
impl Ownable for GameCurrency {}
```

## Base functions

```rust
// Constructor helpers
Base::set_metadata(e, decimals: u32, name: String, symbol: String)

// Supply
Base::mint(e, &to, amount: i128)
Base::burn(e, &from, amount: i128)
Base::total_supply(e) -> i128

// Balances & transfers
Base::balance(e, &id) -> i128
Base::transfer(e, &from, &to, amount: i128)
Base::transfer_from(e, &spender, &from, &to, amount: i128)

// Allowances
Base::approve(e, &from, &spender, amount: i128, expiration_ledger: u32)
Base::allowance(e, &from, &spender) -> i128

// Metadata
Base::decimals(e) -> u32
Base::name(e) -> String
Base::symbol(e) -> String
```

## Extensions

### FungibleBurnable — burn / burn_from

```rust
use stellar_tokens::fungible::burnable::FungibleBurnable;

#[contractimpl(contracttrait)]
impl FungibleBurnable for MyToken {}
```

Adds `burn(from, amount)` and `burn_from(spender, from, amount)` to the contract interface.

### FungibleCapped — supply cap enforcement

Helper functions for enforcing a maximum supply. Call during mint to enforce cap.

### AllowList variant

```rust
use stellar_tokens::fungible::{AllowList, FungibleToken};
use stellar_tokens::fungible::allow_list::FungibleAllowList;

#[contractimpl(contracttrait)]
impl FungibleToken for MyToken {
    type ContractType = AllowList;
}

#[contractimpl(contracttrait)]
impl FungibleAllowList for MyToken {}
```

### BlockList variant

```rust
use stellar_tokens::fungible::{BlockList, FungibleToken};
use stellar_tokens::fungible::block_list::FungibleBlockList;

#[contractimpl(contracttrait)]
impl FungibleToken for MyToken {
    type ContractType = BlockList;
}

#[contractimpl(contracttrait)]
impl FungibleBlockList for MyToken {}
```

## ContractOverrides

Override specific `TokenInterface` methods for custom behavior (e.g. adding pause guards):

```rust
use soroban_sdk::token::Interface as TokenInterface;

#[contractimpl(contracttrait)]
impl TokenInterface for MyToken {
    // Override transfer to add pause check:
    #[when_not_paused]
    fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        Base::transfer(&e, &from, &to, amount);
    }
    // Leave other functions unoverridden to get default OZ behavior
}
```
