use soroban_sdk::{panic_with_error, Address, Env};
use stellar_access::ownable::{self as ownable};

use crate::interfaces::GovClient;
use crate::storage::CtrlKey;
use crate::Error;

pub(crate) fn require_keeper(e: &Env, caller: &Address) {
    caller.require_auth();
    let keeper: Address = e
        .storage()
        .instance()
        .get(&CtrlKey::AuthorizedKeeper)
        .expect("keeper not set");
    if caller != &keeper {
        panic_with_error!(e, Error::NotAuthorizedKeeper);
    }
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
    if !gov.is_admin(caller) {
        panic_with_error!(e, Error::NotOwnerOrGovernanceAdmin);
    }
}
