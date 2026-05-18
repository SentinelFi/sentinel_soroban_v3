use soroban_sdk::{Address, Env};

use crate::storage::VaultKey;

pub(crate) const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
pub(crate) const INSTANCE_TTL_EXTEND: u32 = 535_680;

pub(crate) fn require_controller(e: &Env, controller: &Address) {
    controller.require_auth();
    let stored: Address = e
        .storage()
        .instance()
        .get(&VaultKey::Controller)
        .expect("controller not set");
    assert!(controller == &stored, "not controller");
}
