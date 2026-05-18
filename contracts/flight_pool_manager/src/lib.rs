#![no_std]

mod admin;
mod auth;
mod claim;
mod events;
mod lifecycle;
mod queries;
mod settle;
mod storage;

use soroban_sdk::{contract, contractimpl, Address};
use stellar_access::ownable::Ownable;

pub use storage::{FlightConfig, SettlementStatus};

#[contract]
pub struct FlightPoolManager;

#[contractimpl(contracttrait)]
impl Ownable for FlightPoolManager {}

#[cfg(test)]
mod test;
