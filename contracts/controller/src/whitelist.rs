use soroban_sdk::{contractimpl, Address, Env};
use stellar_macros::only_owner;

use crate::auth::require_owner_or_gov_admin;
use crate::events::{BuyerWhitelistRemovedEvent, BuyerWhitelistedEvent, WhitelistToggled};
use crate::storage::{write_buyer_whitelisted, CtrlKey};
use crate::{Controller, ControllerArgs, ControllerClient};

#[contractimpl]
impl Controller {
    /// Add `addr` to the buyer whitelist. Callable by the owner or any address
    /// flagged as admin on `GovernanceModule`. Idempotent — re-adding an
    /// existing entry restarts its approval window without panic.
    /// Intentionally NOT gated by Pausable so admins can keep the list
    /// current during a pause.
    ///
    /// Approval lifetime model (deliberate): an approval carries an explicit
    /// on-chain deadline (`now + 180 days`), and every purchase the buyer
    /// makes slides it forward. A buyer DORMANT for the full window lapses —
    /// the purchase gate compares the ledger clock against the stored
    /// deadline and rejects — and must be re-approved. This is periodic
    /// re-attestation of inactive accounts: it fails closed, and recovery is
    /// one admin call. The deadline is contract state, NOT the entry's
    /// storage TTL: an archived Persistent entry is restored with its
    /// original value on next access rather than read as absent, so a TTL
    /// alone could never expire an authorization. Off-chain tooling can
    /// watch `buyer_whitelisted` events to alert before dormant approvals
    /// age out.
    pub fn add_whitelisted_buyer(e: &Env, caller: Address, addr: Address) {
        require_owner_or_gov_admin(e, &caller);
        write_buyer_whitelisted(e, &addr, true);
        Controller::extend_ttl(e);

        BuyerWhitelistedEvent { addr }.publish(e);
    }

    /// Remove `addr` from the whitelist. Same auth as `add_whitelisted_buyer`.
    /// Removing an address that was never whitelisted is a no-op (writes a
    /// zero deadline, emits the event). The entry is overwritten rather than
    /// deleted so a re-add later still refreshes a known key — keeps the
    /// Persistent footprint stable for the off-chain TTL cron — and so a
    /// later archival restore brings back the revocation, never an approval.
    pub fn remove_whitelisted_buyer(e: &Env, caller: Address, addr: Address) {
        require_owner_or_gov_admin(e, &caller);
        write_buyer_whitelisted(e, &addr, false);
        Controller::extend_ttl(e);

        BuyerWhitelistRemovedEvent { addr }.publish(e);
    }

    /// Owner-only kill-switch. When `false` (default), `buy_insurance` is
    /// open to anyone. When `true`, only addresses holding an unexpired
    /// `BuyerApprovalExpiry` deadline (added via `add_whitelisted_buyer`,
    /// not lapsed) can call `buy_insurance`.
    #[only_owner]
    pub fn set_whitelist_enabled(e: &Env, enabled: bool) {
        e.storage()
            .instance()
            .set(&CtrlKey::WhitelistEnabled, &enabled);
        Controller::extend_ttl(e);

        WhitelistToggled { enabled }.publish(e);
    }
}
