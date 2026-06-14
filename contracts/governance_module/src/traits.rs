use soroban_sdk::{contractimpl, Address, Env};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};

use crate::{GovernanceModule, GovernanceModuleArgs, GovernanceModuleClient};

#[contractimpl(contracttrait)]
impl Ownable for GovernanceModule {}

#[contractimpl(contracttrait)]
impl Pausable for GovernanceModule {
    fn pause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        pausable::pause(e);
    }
    fn unpause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        pausable::unpause(e);
    }
}
