use soroban_sdk::{Address, Env};

use crate::storage::CtrlKey;

pub(crate) use sentinel_types::ttl::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};

pub(crate) fn require_keeper(e: &Env, caller: &Address) {
    caller.require_auth();
    let keeper: Address = e
        .storage()
        .instance()
        .get(&CtrlKey::AuthorizedKeeper)
        .expect("keeper not set");
    assert!(caller == &keeper, "not authorized keeper");
}

pub(crate) fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}
