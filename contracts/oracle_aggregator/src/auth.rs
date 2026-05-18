use soroban_sdk::{Address, Env};

use crate::storage::OracleKey;

pub(crate) const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
pub(crate) const INSTANCE_TTL_EXTEND: u32 = 535_680;

pub(crate) fn require_oracle(e: &Env, caller: &Address) {
    caller.require_auth();
    let oracle: Address = e
        .storage()
        .instance()
        .get(&OracleKey::AuthorizedOracle)
        .expect("oracle not set");
    assert!(caller == &oracle, "not authorized oracle");
}

pub(crate) fn require_controller(e: &Env, caller: &Address) {
    caller.require_auth();
    let controller: Address = e
        .storage()
        .instance()
        .get(&OracleKey::AuthorizedController)
        .expect("controller not set");
    assert!(caller == &controller, "not authorized controller");
}

pub(crate) fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}
