# OZ Stellar — Real World Asset (RWA) Tokens

## Overview

RWA tokens extend fungible tokens with compliance, identity verification, and asset management features. The `RWA` type replaces `Base` as the `ContractType`.

## Full example — Real Estate Token

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, String};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_tokens::{
    fungible::{Base, FungibleToken},
    rwa::{RWAToken, RWA},
};

#[contract]
pub struct RealEstateToken;

#[contractimpl]
impl RealEstateToken {
    pub fn __constructor(
        e: &Env,
        admin: Address,
        manager: Address,
        compliance: Address,
        identity_verifier: Address,
        initial_supply: i128,
    ) {
        Base::set_metadata(e, 18, String::from_str(e, "Real Estate Token"), String::from_str(e, "REST"));

        RWA::set_compliance(e, &compliance);
        RWA::set_identity_verifier(e, &identity_verifier);

        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &admin, &manager, &symbol_short!("manager"));

        RWA::mint(e, &admin, initial_supply);
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for RealEstateToken {
    type ContractType = RWA;
}

#[contractimpl(contracttrait)]
impl RWAToken for RealEstateToken {}

#[contractimpl(contracttrait)]
impl AccessControl for RealEstateToken {}
```

## Key RWA functions

```rust
// Setup (in constructor)
RWA::set_compliance(e, &compliance_contract)
RWA::set_identity_verifier(e, &verifier_contract)

// Minting (with identity verification)
RWA::mint(e, &recipient, amount: i128)

// Transfers (with compliance checks)
RWA::transfer(e, &from, &to, amount: i128)

// Address freezing
RWA::set_address_frozen(e, &user_address, frozen: bool, &operator)

// Partial token freezing
RWA::freeze_partial_tokens(e, &user_address, amount: i128, &operator)
RWA::unfreeze_partial_tokens(e, &user_address, amount: i128, &operator)

// Balance recovery (lost wallet scenario)
RWA::recover_balance(e, &old_account, &new_account, &operator)

// Forced transfers (regulatory requirement)
RWA::forced_transfer(e, &from, &to, amount: i128, &operator)
```

## Required external contracts

### Identity Verifier contract must implement:

```rust
fn verify_identity(e: &Env, account: &Address);
```

### Compliance contract must implement:

```rust
fn can_transfer(e: &Env, from: Address, to: Address, amount: i128, token: Address) -> bool;
fn can_create(e: &Env, to: Address, amount: i128, token: Address) -> bool;
fn created(e: &Env, to: Address, amount: i128, token: Address);
fn destroyed(e: &Env, from: Address, amount: i128, token: Address);
fn transferred(e: &Env, from: Address, to: Address, amount: i128, token: Address);
```

## Compliance configuration

```rust
// Add claim topics (KYC, AML, Accredited Investor, etc.)
add_claim_topic(e, 1, operator);  // e.g. KYC
add_claim_topic(e, 2, operator);  // e.g. AML
add_claim_topic(e, 3, operator);  // e.g. Accredited Investor

// Add trusted issuers for claim topics
add_trusted_issuer(e, issuer_a, vec![1, 2], operator);
add_trusted_issuer(e, issuer_b, vec![3], operator);
```
