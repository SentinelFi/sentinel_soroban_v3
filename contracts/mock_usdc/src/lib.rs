#![no_std]
//! # MockUSDC — ⚠️ TESTNET ONLY
//!
//! Audit ASF-03 (Deployment Critical). This token exposes **permissionless**
//! mint/faucet: anyone can mint arbitrary balances. It exists only to fund
//! integration tests and testnet demos.
//!
//! NEVER deploy MockUSDC as the `usdc_token` backing `RiskVault`, `Controller`,
//! or `FlightPoolManager` on mainnet — any user could mint unlimited "USDC",
//! buy arbitrary policies, fake vault capital, and destroy all share/insurance
//! accounting. Production must use the real USDC Stellar Asset Contract (SAC).
//!
//! Guardrail: the permissionless `mint`/`faucet` entrypoints are compiled only
//! under the default-on `testnet` feature. A production build
//! (`--no-default-features`) omits them entirely.
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, MuxedAddress, String};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;
use stellar_tokens::fungible::{burnable::FungibleBurnable, Base, FungibleToken};

#[contract]
pub struct MockUSDC;

#[contractimpl]
impl MockUSDC {
    pub fn __constructor(e: &Env, admin: Address) {
        Base::set_metadata(
            e,
            7,
            String::from_str(e, "Mock USDC"),
            String::from_str(e, "USDC"),
        );
        ownable::set_owner(e, &admin);
    }

    #[only_owner]
    pub fn upgrade(e: &Env, wasm_hash: BytesN<32>) {
        e.deployer().update_current_contract_wasm(wasm_hash);
    }

    /// Permissionless mint — anyone can mint any amount to any address.
    /// Audit ASF-03: testnet-only, gated behind the default-on `testnet` feature.
    #[cfg(feature = "testnet")]
    pub fn mint(e: &Env, to: Address, amount: i128) {
        Base::mint(e, &to, amount);
    }

    /// Permissionless faucet — mints 10,000 USDC to any address.
    /// Audit ASF-03: testnet-only, gated behind the default-on `testnet` feature.
    #[cfg(feature = "testnet")]
    pub fn faucet(e: &Env, to: Address) {
        Base::mint(e, &to, 10_000_0000000); // 10,000 USDC (7 decimals)
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for MockUSDC {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl FungibleBurnable for MockUSDC {}

#[contractimpl(contracttrait)]
impl Ownable for MockUSDC {}

#[cfg(test)]
mod test;
