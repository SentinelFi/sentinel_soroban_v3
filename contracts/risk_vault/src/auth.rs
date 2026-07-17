use soroban_sdk::{panic_with_error, Address, Env};

use sentinel_types::interfaces::OracleClient;

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

/// Whether any flight outcome is public but not yet financially settled, per
/// the configured oracle. The oracle is wired at construction, so a missing
/// entry is unreachable state — panic loudly rather than silently disabling
/// the barrier (the old `None => false` fallback was fail-open: an unwired
/// vault accepted deposits with no stale-price protection at all).
pub(crate) fn settlement_pending(e: &Env) -> bool {
    let oracle: Address = e
        .storage()
        .instance()
        .get(&VaultKey::Oracle)
        .expect("oracle not set");
    OracleClient::new(e, &oracle).has_pending_outcomes()
}
