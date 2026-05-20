use soroban_sdk::{Address, Env};
use stellar_access::ownable::{self as ownable};

use crate::storage::DataKey;

pub(crate) use sentinel_types::ttl::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};

pub(crate) fn require_owner_or_admin(e: &Env, caller: &Address) {
    caller.require_auth();
    if let Some(owner) = ownable::get_owner(e) {
        if caller == &owner {
            return;
        }
    }
    let is_admin: bool = e
        .storage()
        .instance()
        .get(&DataKey::Admin(caller.clone()))
        .unwrap_or(false);
    assert!(is_admin, "not owner or admin");
}
