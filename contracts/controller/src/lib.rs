#![no_std]

mod admin;
mod auth;
mod events;
mod interfaces;
mod purchase;
mod queries;
mod settle;
mod storage;

use soroban_sdk::{contract, contractimpl, Address};
use stellar_access::ownable::Ownable;

#[contract]
pub struct Controller;

#[contractimpl(contracttrait)]
impl Ownable for Controller {}

#[cfg(test)]
mod test;
