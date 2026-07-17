use soroban_sdk::{contractimpl, Address, Env};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};

use crate::{Controller, ControllerArgs, ControllerClient};

#[contractimpl(contracttrait)]
impl Ownable for Controller {}

// Pause/unpause renew the instance TTL: they are incident actions, likely to
// run exactly when the external TTL cron is degraded, and they mutate
// instance state — leaving the instance unrenewed there could archive the
// contract right after an emergency intervention.
#[contractimpl(contracttrait)]
impl Pausable for Controller {
    fn pause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        Controller::extend_ttl(e);
        pausable::pause(e);
    }
    fn unpause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        Controller::extend_ttl(e);
        pausable::unpause(e);
    }
}
