#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;

#[contracttype]
enum DataKey {
    UsdcToken,
    Balance(Address),
    TotalBalance,
}

#[contract]
pub struct RecoveryPool;

#[contractimpl]
impl RecoveryPool {
    pub fn __constructor(e: &Env, owner: Address, usdc_token: Address) {
        ownable::set_owner(e, &owner);
        e.storage().instance().set(&DataKey::UsdcToken, &usdc_token);
        e.storage().instance().set(&DataKey::TotalBalance, &0i128);
    }

    /// Called by a FlightPool during sweep_expired. Transfers USDC from the
    /// source pool to this contract and records the per-source balance.
    pub fn receive(e: &Env, source_pool: Address, amount: i128) {
        source_pool.require_auth();
        assert!(amount > 0, "amount must be positive");

        let usdc = token::Client::new(e, &Self::get_usdc_token(e));
        usdc.transfer(&source_pool, &e.current_contract_address(), &amount);

        let key = DataKey::Balance(source_pool);
        let existing: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        e.storage().persistent().set(&key, &(existing + amount));

        let total: i128 = e.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        e.storage().instance().set(&DataKey::TotalBalance, &(total + amount));
    }

    /// Owner withdraws USDC for manual resolution of legitimate late claims.
    #[only_owner]
    pub fn withdraw(e: &Env, destination: Address, amount: i128) {
        assert!(amount > 0, "amount must be positive");

        let total: i128 = e.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        assert!(amount <= total, "insufficient balance");

        let usdc = token::Client::new(e, &Self::get_usdc_token(e));
        usdc.transfer(&e.current_contract_address(), &destination, &amount);

        e.storage().instance().set(&DataKey::TotalBalance, &(total - amount));
    }

    // --- TTL management ---

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(120_960, 535_680);
    }

    pub fn get_balance(e: &Env, source_pool: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::Balance(source_pool))
            .unwrap_or(0)
    }

    pub fn get_total_balance(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&DataKey::TotalBalance)
            .unwrap_or(0)
    }

    pub fn get_usdc_token(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::UsdcToken).unwrap()
    }
}

#[contractimpl(contracttrait)]
impl Ownable for RecoveryPool {}

#[cfg(test)]
mod test;
