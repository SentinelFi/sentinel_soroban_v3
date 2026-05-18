#![no_std]

mod admin;
mod auth;
mod capital;
mod claims;
mod events;
mod queries;
mod snapshot;
mod storage;
mod vault_ops;

use soroban_sdk::{contract, contractimpl, Address, MuxedAddress, String};
use stellar_access::ownable::Ownable;
use stellar_tokens::fungible::{Base, FungibleToken};

#[cfg(test)]
#[allow(unused_imports)]
use soroban_sdk::token;

#[cfg(test)]
use storage::SECONDS_PER_DAY;

pub use storage::{RecoveryMode, WithdrawalRequest};

#[contract]
pub struct RiskVault;

#[contractimpl(contracttrait)]
impl FungibleToken for RiskVault {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl Ownable for RiskVault {}

#[cfg(test)]
mod test;
