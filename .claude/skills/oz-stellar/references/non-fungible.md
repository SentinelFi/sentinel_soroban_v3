# OZ Stellar — Non-Fungible Tokens

## Contract type variants

| Variant | `type ContractType =` | Behavior |
|---|---|---|
| `Base` | `Base` | Standard NFT with sequential minting |
| `Consecutive` | `Consecutive` | Optimized batch minting with reduced storage |
| `Enumerable` | `Enumerable` | On-chain token enumeration per address |

## Full example — GameItem NFT

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};
use stellar_tokens::non_fungible::{
    burnable::NonFungibleBurnable,
    Base, ContractOverrides, NonFungibleToken,
};

#[contract]
pub struct GameItem;

#[contractimpl]
impl GameItem {
    pub fn __constructor(e: &Env) {
        Base::set_metadata(
            e,
            String::from_str(e, "www.mygame.com"),      // base_uri
            String::from_str(e, "My Game Items"),         // name
            String::from_str(e, "MGMC"),                  // symbol
        );
    }

    pub fn award_item(e: &Env, to: Address) -> u32 {
        Base::sequential_mint(e, &to)
    }
}

#[contractimpl(contracttrait)]
impl NonFungibleToken for GameItem {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl NonFungibleBurnable for GameItem {}
```

## Key functions

```rust
// Constructor
Base::set_metadata(e, base_uri: String, name: String, symbol: String)

// Minting
Base::sequential_mint(e, &to) -> u32  // returns token_id

// Transfers
Base::transfer(e, &from, &to, token_id: u32)
Base::transfer_from(e, &operator, &from, &to, token_id: u32)

// Approvals
Base::approve(e, &owner, &operator, token_id: u32, live_until_ledger: u32)
Base::set_approval_for_all(e, &owner, &operator, approved: bool)

// Queries
Base::balance(e, &owner) -> u32
Base::owner_of(e, token_id: u32) -> Address
```

## Extensions

### NonFungibleBurnable

```rust
use stellar_tokens::non_fungible::burnable::NonFungibleBurnable;

#[contractimpl(contracttrait)]
impl NonFungibleBurnable for MyNFT {}
```

### NonFungibleRoyalties (ERC-2981)

```rust
use stellar_tokens::non_fungible::royalties::NonFungibleRoyalties;

#[contractimpl(contracttrait)]
impl NonFungibleRoyalties for MyNFT {}
```

### Consecutive — batch minting

Use `Consecutive` as `ContractType` for optimized batch minting with reduced storage costs.

### Enumerable — on-chain enumeration

Use `Enumerable` as `ContractType` to enable per-address token enumeration.
