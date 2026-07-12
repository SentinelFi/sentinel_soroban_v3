use soroban_sdk::{contractimpl, Address, Env};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};

use crate::auth::extend_instance_ttl;
use crate::{OracleAggregator, OracleAggregatorArgs, OracleAggregatorClient};

#[contractimpl(contracttrait)]
impl Ownable for OracleAggregator {}

// Pause/unpause renew the instance TTL: they are incident actions, likely to
// run exactly when the external TTL cron is degraded, and they mutate
// instance state — leaving the instance unrenewed there could archive the
// contract right after an emergency intervention.
#[contractimpl(contracttrait)]
impl Pausable for OracleAggregator {
    fn pause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        extend_instance_ttl(e);
        pausable::pause(e);
    }
    fn unpause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        extend_instance_ttl(e);
        pausable::unpause(e);
    }
}
