#![no_std]

mod admin;
mod auth;
mod events;
mod interfaces;
mod purchase;
mod queries;
mod settle;
mod storage;
mod whitelist;

use soroban_sdk::{contract, contractimpl, Address, Env};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};

#[contract]
pub struct Controller;

#[contractimpl(contracttrait)]
impl Ownable for Controller {}

#[contractimpl(contracttrait)]
impl Pausable for Controller {
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
