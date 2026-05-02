---
description: OpenZeppelin Stellar Contracts v0.6.0 reference. Trigger on ANY work involving OZ crates on Soroban — writing, modifying, debugging, or reviewing contracts that import stellar-tokens, stellar-access, stellar-macros, stellar-pausable, or stellar-contract-utils. Covers fungible/non-fungible tokens, vaults, access control (ownable/RBAC), pausable, upgradeable, governance (timelock), RWA tokens, fee abstraction, and smart accounts.
---

# Skill: OpenZeppelin Stellar Contracts (v0.6.0)

## Layer 1 — Setup, Imports & Macros (always read this)

### Dependencies

The old monolithic `openzeppelin-stellar-contracts` crate no longer exists. Use individual crates:

```toml
# Workspace Cargo.toml — [workspace.dependencies]
stellar-tokens = "0.6.0"
stellar-access = "0.6.0"
stellar-macros = "0.6.0"
# Add these only if needed:
stellar-contract-utils = "0.6.0"   # pausable, upgradeable, crypto
stellar-pausable = "0.6.0"         # pausable trait + macros
stellar-governance = "0.6.0"       # timelock controller

# Contract Cargo.toml — [dependencies]
soroban-sdk = { workspace = true }
stellar-tokens = { workspace = true }
stellar-access = { workspace = true }
stellar-macros = { workspace = true }
```

### Import map

All OZ types are re-exported under `stellar_*` prefixes:

| Crate prefix | Contains |
|---|---|
| `stellar_tokens::fungible::` | `Base`, `AllowList`, `BlockList`, `FungibleToken`, `ContractOverrides`, burnable, capped |
| `stellar_tokens::non_fungible::` | `Base`, `Consecutive`, `Enumerable`, `NonFungibleToken`, burnable, royalties |
| `stellar_tokens::rwa::` | `RWA`, `RWAToken` |
| `stellar_tokens::fungible::vault::` | `Vault`, `FungibleVault` |
| `stellar_access::ownable::` | `Ownable`, `set_owner`, `renounce_ownership` |
| `stellar_access::access_control::` | `AccessControl`, `set_admin`, `grant_role_no_auth`, `revoke_role_no_auth`, `set_role_admin_no_auth` |
| `stellar_pausable::pausable::` | `Pausable`, `pause`, `unpause`, `paused` |
| `stellar_contract_utils::upgradeable::` | `UpgradeableInternal`, `UpgradeableMigratableInternal`, `UpgradeableClient` |
| `stellar_contract_utils::crypto::` | `Sha256`, `Keccak256`, `Hasher`, merkle `Verifier` |
| `stellar_macros::` | See macro table below |

### Macro cheat sheet

| Macro | Purpose | Applies to |
|---|---|---|
| `#[only_owner]` | Require caller is owner | `pub fn` |
| `#[only_admin]` | Require caller is admin | `pub fn` |
| `#[only_role(caller, "role")]` | Require caller has specific role (enforces auth) | `pub fn` with `caller: Address` param |
| `#[only_any_role(caller, ["r1","r2"])]` | Require caller has any of the listed roles (enforces auth) | `pub fn` with `caller: Address` param |
| `#[has_role(caller, "role")]` | Check role without enforcing auth | `pub fn` with `caller: Address` param |
| `#[has_any_role(caller, ["r1","r2"])]` | Check any role without enforcing auth | `pub fn` with `caller: Address` param |
| `#[when_not_paused]` | Reject if contract is paused | `pub fn` |
| `#[when_paused]` | Reject if contract is NOT paused | `pub fn` |
| `#[derive(Upgradeable)]` | Derive basic upgrade support | `#[contract]` struct |
| `#[derive(UpgradeableMigratable)]` | Derive upgrade + migration support | `#[contract]` struct |

### Trait implementation pattern (v0.6.0)

OZ v0.6.0 uses `#[contractimpl(contracttrait)]` — NOT `#[default_impl]`:

```rust
#[contractimpl(contracttrait)]
impl FungibleToken for MyToken {
    type ContractType = Base;
}
```

### Minimal OZ fungible token (quick reference)

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};
use stellar_tokens::fungible::{Base, FungibleToken};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

#[contract]
pub struct MyToken;

#[contractimpl]
impl MyToken {
    pub fn __constructor(e: &Env, owner: Address) {
        Base::set_metadata(e, 7, String::from_str(e, "My Token"), String::from_str(e, "MTK"));
        ownable::set_owner(e, &owner);
    }

    #[only_owner]
    pub fn mint(e: &Env, to: Address, amount: i128) {
        Base::mint(e, &to, amount);
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for MyToken {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl Ownable for MyToken {}
```

---

## Progressive disclosure — reference files

Read these only when the task requires that specific module:

| When you need… | Read |
|---|---|
| Fungible tokens (Base, AllowList, BlockList, burnable, capped) | `references/fungible.md` |
| Non-fungible tokens (NFTs, enumerable, consecutive, royalties) | `references/non-fungible.md` |
| Real World Asset tokens (compliance, identity, freezing) | `references/rwa.md` |
| Tokenized vault (ERC-4626 style deposit/withdraw/shares) | `references/vault.md` |
| Access control — Ownable or Role-Based | `references/access.md` |
| Pausable, Upgradeable, Cryptography utilities | `references/utilities.md` |
| Governance — Timelock Controller | `references/governance.md` |
| Fee abstraction — gasless transactions | `references/fee-abstraction.md` |
