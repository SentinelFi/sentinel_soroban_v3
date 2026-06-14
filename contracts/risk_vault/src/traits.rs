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

#[contractimpl(contracttrait)]
impl Pausable for RiskVault {
    fn pause(e: &Env, caller: Address) {
        // Owner-gated emergency stop. `caller` is required by the trait
        // signature; auth is enforced against the stored owner.
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
