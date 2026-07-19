use soroban_sdk::{contractimpl, Address, Env};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};

use crate::{GovernanceModule, GovernanceModuleArgs, GovernanceModuleClient};

#[contractimpl(contracttrait)]
impl Ownable for GovernanceModule {}

// Pause/unpause renew the instance TTL: they are incident actions, likely to
// run exactly when the external TTL cron is degraded, and they mutate
// instance state — leaving the instance unrenewed there could archive the
// contract right after an emergency intervention.
//
// OPERATOR WARNING — pausing this module does NOT stop sales, and DOES
// block `disable_route`. The pause halts only the administrative write
// entry points; `route_status` deliberately keeps serving `Active` (with
// its protective TTL side effects), so the controller keeps admitting
// purchases on every listed route while this module is paused — and route
// lifecycle writes, including `disable_route`, are pause-gated. The
// intuitive incident response "pause governance, then disable the bad
// route" therefore does the opposite of its intent: the disable reverts
// and sales continue. To stop sales mid-incident, pause the CONTROLLER
// (halts every purchase) or use the oracle's pause-exempt `close_sale`
// (kills insurability per flight); unpause this module first if a route
// must be disabled or removed.
#[contractimpl(contracttrait)]
impl Pausable for GovernanceModule {
    fn pause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        GovernanceModule::extend_ttl(e);
        pausable::pause(e);
    }
    fn unpause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        GovernanceModule::extend_ttl(e);
        pausable::unpause(e);
    }
}
