#![no_std]

mod admin;
mod auth;
mod capital;
mod claims;
mod error;
mod events;
mod queries;
mod snapshot;
mod storage;
mod vault_ops;

use soroban_sdk::{contract, contractimpl, Address, Env, MuxedAddress, String};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_tokens::{fungible::FungibleToken, vault::Vault};

#[cfg(test)]
use soroban_sdk::token;

#[cfg(test)]
use storage::SECONDS_PER_DAY;

pub use error::Error;
pub use storage::{RecoveryMode, WithdrawalRequest};

#[contract]
pub struct RiskVault;

#[contractimpl(contracttrait)]
impl FungibleToken for RiskVault {
    type ContractType = Vault;
}

#[contractimpl(contracttrait)]
impl Ownable for RiskVault {}

#[contractimpl(contracttrait)]
impl Pausable for RiskVault {
    fn pause(e: &Env, caller: Address) {
        // Owner-gated emergency stop. `caller` is required by the trait
        // signature; auth is enforced against the stored owner.
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        pausable::pause(e);
    }

    fn unpause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        pausable::unpause(e);
    }
}

#[cfg(test)]
mod test;
