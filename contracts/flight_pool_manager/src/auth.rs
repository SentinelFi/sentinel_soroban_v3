use soroban_sdk::{Address, Env};

use crate::storage::PoolKey;

pub(crate) const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
pub(crate) const INSTANCE_TTL_EXTEND: u32 = 535_680;

pub(crate) fn require_controller(e: &Env, caller: &Address) {
    caller.require_auth();
    let controller: Address = e
        .storage()
        .instance()
        .get(&PoolKey::Controller)
        .expect("controller not set");
    assert!(caller == &controller, "not controller");
}

pub(crate) fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}
