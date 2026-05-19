#![no_std]

mod admin;
mod auth;
mod claim;
mod events;
mod lifecycle;
mod queries;
mod settle;
mod storage;

use soroban_sdk::{contract, contractimpl, Address, Env};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};

pub use storage::{FlightConfig, SettlementStatus};

#[contract]
pub struct FlightPoolManager;

#[contractimpl(contracttrait)]
impl Ownable for FlightPoolManager {}

#[contractimpl(contracttrait)]
impl Pausable for FlightPoolManager {
    fn pause(e: &Env, caller: Address) {
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
