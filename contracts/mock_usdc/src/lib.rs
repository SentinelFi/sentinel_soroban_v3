#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, MuxedAddress, String};
use stellar_access::ownable::{self as ownable, Ownable};
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

    /// Permissionless mint — anyone can mint any amount to any address.
    pub fn mint(e: &Env, to: Address, amount: i128) {
        Base::mint(e, &to, amount);
    }

    /// Permissionless faucet — mints 10,000 USDC to any address.
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
