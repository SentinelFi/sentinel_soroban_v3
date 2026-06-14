//! Contract upgrade + on-chain version tracking — a thin owner-gated wrapper
//! over the shared logic in [`sentinel_types::upgrade`].

use soroban_sdk::{contractimpl, BytesN, Env};
use stellar_macros::only_owner;

use crate::{MockUSDC, MockUSDCArgs, MockUSDCClient};

#[contractimpl]
impl MockUSDC {
    /// Owner-gated Wasm upgrade. Delegates to the shared implementation, which
    /// also bumps the stored on-chain version.
    #[only_owner]
    pub fn upgrade(e: &Env, wasm_hash: BytesN<32>) {
        sentinel_types::upgrade::upgrade(e, wasm_hash);
    }

    /// Current on-chain contract version.
    pub fn version(e: &Env) -> u32 {
        sentinel_types::upgrade::version(e)
    }
}
