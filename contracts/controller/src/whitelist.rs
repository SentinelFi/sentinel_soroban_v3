use soroban_sdk::{contractimpl, Address, Env};
use stellar_macros::only_owner;

use crate::auth::{extend_instance_ttl, require_owner_or_gov_admin};
use crate::events::{BuyerWhitelistRemovedEvent, BuyerWhitelistedEvent, WhitelistToggled};
use crate::storage::{write_buyer_whitelisted, CtrlKey};
use crate::{Controller, ControllerArgs, ControllerClient};

#[contractimpl]
impl Controller {
    /// Add `addr` to the buyer whitelist. Callable by the owner or any address
    /// flagged as admin on `GovernanceModule`. Idempotent — re-adding an
    /// existing entry refreshes its TTL without panic. Intentionally NOT
    /// gated by Pausable so admins can keep the list current during a pause.
    pub fn add_whitelisted_buyer(e: &Env, caller: Address, addr: Address) {
        require_owner_or_gov_admin(e, &caller);
        write_buyer_whitelisted(e, &addr, true);
        extend_instance_ttl(e);

        BuyerWhitelistedEvent { addr }.publish(e);
    }

    /// Remove `addr` from the whitelist. Same auth as `add_whitelisted_buyer`.
    /// Removing an address that was never whitelisted is a no-op (writes
    /// `false`, emits the event). The entry is overwritten rather than
    /// deleted so a re-add later still refreshes a known key — keeps the
    /// Persistent footprint stable for the off-chain TTL cron.
    pub fn remove_whitelisted_buyer(e: &Env, caller: Address, addr: Address) {
        require_owner_or_gov_admin(e, &caller);
        write_buyer_whitelisted(e, &addr, false);
        extend_instance_ttl(e);

        BuyerWhitelistRemovedEvent { addr }.publish(e);
    }

    /// Owner-only kill-switch. When `false` (default), `buy_insurance` is
    /// open to anyone. When `true`, only addresses with a `true` entry in
    /// `BuyerWhitelisted` can call `buy_insurance`.
    #[only_owner]
    pub fn set_whitelist_enabled(e: &Env, enabled: bool) {
        e.storage()
            .instance()
            .set(&CtrlKey::WhitelistEnabled, &enabled);
        extend_instance_ttl(e);

        WhitelistToggled { enabled }.publish(e);
    }
}
