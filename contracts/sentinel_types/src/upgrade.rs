//! Shared contract-upgrade + on-chain version-tracking helpers.
//!
//! The logic lives here once so every contract behaves identically. Each
//! contract exposes a thin owner-gated wrapper that delegates to these
//! functions — this keeps `sentinel_types` free of any access-control
//! dependency, with owner authorization enforced at the call site (via
//! `#[only_owner]`) rather than here.

use soroban_sdk::{contracttype, BytesN, Env};

/// Instance-storage key holding the `u32` on-chain contract version. Stored
/// under one shared key so every contract reads/writes it consistently.
#[contracttype]
pub enum UpgradeKey {
    Version,
}

/// Version recorded at construction, before any upgrade has occurred.
pub const INITIAL_VERSION: u32 = 1;

/// Record the initial on-chain version. Call once from a contract's
/// `__constructor` so the deployed revision is queryable from genesis.
pub fn set_initial_version(e: &Env) {
    e.storage()
        .instance()
        .set(&UpgradeKey::Version, &INITIAL_VERSION);
}

/// Current on-chain contract version, defaulting to [`INITIAL_VERSION`] if no
/// value has been written yet.
pub fn version(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&UpgradeKey::Version)
        .unwrap_or(INITIAL_VERSION)
}

/// Replace the contract Wasm with the code identified by `wasm_hash` and bump
/// the stored on-chain version.
///
/// **Not** access-gated: the caller is responsible for enforcing owner
/// authorization (the contract wrappers do this with `#[only_owner]`).
pub fn upgrade(e: &Env, wasm_hash: BytesN<32>) {
    e.deployer().update_current_contract_wasm(wasm_hash);
    let next = version(e).saturating_add(1);
    e.storage().instance().set(&UpgradeKey::Version, &next);
}
