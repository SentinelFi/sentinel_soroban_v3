use soroban_sdk::{Address, Env};
use stellar_access::ownable::{self as ownable};

use crate::interfaces::GovClient;
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

/// Admin gate for whitelist add/remove. Owner short-circuits to a local check
/// to avoid a cross-contract call on the common path; non-owner callers fall
/// through to `GovernanceModule.is_admin(caller)` so admin identity stays a
/// single source of truth on `governance_module` (no duplicated admin list).
pub(crate) fn require_owner_or_gov_admin(e: &Env, caller: &Address) {
    caller.require_auth();
    if let Some(owner) = ownable::get_owner(e) {
        if caller == &owner {
            return;
        }
    }
    let gov_addr: Address = e
        .storage()
        .instance()
        .get(&CtrlKey::Governance)
        .expect("governance not set");
    let gov = GovClient::new(e, &gov_addr);
    assert!(gov.is_admin(caller), "not owner or governance admin");
}

pub(crate) fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}
