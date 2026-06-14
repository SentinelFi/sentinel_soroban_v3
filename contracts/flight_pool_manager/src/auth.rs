use soroban_sdk::{panic_with_error, Address, Env};

use crate::storage::PoolKey;
use crate::Error;

pub(crate) use sentinel_types::ttl::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};

pub(crate) fn require_controller(e: &Env, caller: &Address) {
    caller.require_auth();
    let controller: Address = e
        .storage()
        .instance()
        .get(&PoolKey::Controller)
        .expect("controller not set");
    if caller != &controller {
        panic_with_error!(e, Error::NotController);
    }
}

pub(crate) fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}
