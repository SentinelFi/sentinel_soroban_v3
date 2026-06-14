use soroban_sdk::{contractimpl, Address, Env, String};
use stellar_access::ownable;
use stellar_tokens::fungible::Base;

use crate::{MockUSDC, MockUSDCArgs, MockUSDCClient};

#[contractimpl]
impl MockUSDC {
    /// Initialize the mock token.
    ///
    /// # Arguments
    /// * `admin` - Address set as token owner (holds the upgrade authority).
    pub fn __constructor(e: &Env, admin: Address) {
        Base::set_metadata(
            e,
            7,
            String::from_str(e, "Mock USDC"),
            String::from_str(e, "USDC"),
        );
        ownable::set_owner(e, &admin);
        sentinel_types::upgrade::set_initial_version(e);
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
