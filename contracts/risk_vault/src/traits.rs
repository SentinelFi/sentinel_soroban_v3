use soroban_sdk::{contractimpl, Address, Env, MuxedAddress, String};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_tokens::{fungible::FungibleToken, vault::Vault};

use crate::{RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl(contracttrait)]
impl FungibleToken for RiskVault {
    type ContractType = Vault;
}

#[contractimpl(contracttrait)]
impl Ownable for RiskVault {}

// Pause/unpause renew the instance TTL: they are incident actions, likely to
// run exactly when the external TTL cron is degraded, and they mutate
// instance state — leaving the instance unrenewed there could archive the
// contract right after an emergency intervention.
#[contractimpl(contracttrait)]
impl Pausable for RiskVault {
    fn pause(e: &Env, caller: Address) {
        // Owner-gated emergency stop. `caller` is required by the trait
        // signature; auth is enforced against the stored owner.
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        RiskVault::extend_ttl(e);
        pausable::pause(e);
    }

    fn unpause(e: &Env, caller: Address) {
        let _ = caller;
        let owner = ownable::get_owner(e).expect("owner not set");
        owner.require_auth();
        RiskVault::extend_ttl(e);
        pausable::unpause(e);
    }
}
