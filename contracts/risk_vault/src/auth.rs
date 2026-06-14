use soroban_sdk::{panic_with_error, Address, Env};

use crate::storage::VaultKey;
use crate::Error;

pub(crate) use sentinel_types::ttl::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};

pub(crate) fn require_controller(e: &Env, controller: &Address) {
    controller.require_auth();
    let stored: Address = e
        .storage()
        .instance()
        .get(&VaultKey::Controller)
        .expect("controller not set");
    if controller != &stored {
        panic_with_error!(e, Error::NotController);
    }
}
