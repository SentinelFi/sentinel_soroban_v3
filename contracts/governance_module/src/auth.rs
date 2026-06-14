use soroban_sdk::{panic_with_error, Address, Env};
use stellar_access::ownable::{self as ownable};

use crate::storage::DataKey;
use crate::Error;

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
    if !is_admin {
        panic_with_error!(e, Error::NotOwnerOrAdmin);
    }
}
