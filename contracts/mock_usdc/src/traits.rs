use soroban_sdk::{contractimpl, Address, MuxedAddress, String};
use stellar_access::ownable::Ownable;
use stellar_tokens::fungible::{burnable::FungibleBurnable, Base, FungibleToken};

use crate::{MockUSDC, MockUSDCArgs, MockUSDCClient};

#[contractimpl(contracttrait)]
impl FungibleToken for MockUSDC {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl FungibleBurnable for MockUSDC {}

#[contractimpl(contracttrait)]
impl Ownable for MockUSDC {}
