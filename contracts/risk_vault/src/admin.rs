use soroban_sdk::{contractimpl, panic_with_error, Address, Env, String};
use stellar_access::ownable::{self as ownable};
use stellar_contract_utils::pausable::paused;
use stellar_macros::only_owner;
use stellar_tokens::fungible::{Base, FungibleToken};
use stellar_tokens::vault::Vault;

use crate::auth::{settlement_pending, INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};
use crate::events::{ControllerSet, MinWithdrawalRequestSet, OracleSet};
use crate::storage::VaultKey;
use crate::{Error, RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl RiskVault {
    /// Initialize the vault.
    ///
    /// # Arguments
    /// * `owner` - Address granted owner rights (set the controller, pause,
    ///   upgrade, recover uncollected balances).
    /// * `asset_token` - SAC address of the underlying asset the vault
    ///   custodies and denominates its shares against.
    /// * `oracle` - Address of the OracleAggregator the settlement barrier
    ///   consults. Required at construction so the barrier is active from
    ///   genesis: a deposit-accepting vault whose barrier is silently unwired
    ///   would let LPs enter/exit at stale share prices during
    ///   outcome-public-but-unsettled windows. (The deploy order places the
    ///   oracle before the vault, so the address is always available here.)
    pub fn __constructor(e: &Env, owner: Address, asset_token: Address, oracle: Address) {
        ownable::set_owner(e, &owner);
        Vault::set_asset(e, asset_token);
        e.storage().instance().set(&VaultKey::Oracle, &oracle);
        Vault::set_decimals_offset(e, 3);
        Base::set_metadata(
            e,
            Self::decimals(e),
            String::from_str(e, "RiskVault Share"),
            String::from_str(e, "RVS"),
        );
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &0i128);
        e.storage().instance().set(&VaultKey::LockedCapital, &0i128);
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &0u64);
        sentinel_types::upgrade::set_initial_version(e);
    }

    /// Set the vault controller address (one-time, owner-only).
    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        if e.storage().instance().has(&VaultKey::Controller) {
            panic_with_error!(e, Error::ControllerAlreadySet);
        }
        e.storage()
            .instance()
            .set(&VaultKey::Controller, &controller);
        Self::extend_ttl(e);
        ControllerSet { controller }.publish(e);
    }

    /// Rotate the OracleAggregator address the vault consults to block
    /// entry/exit while a flight outcome is public but not yet settled.
    /// Owner-only. The initial oracle is wired at construction, so this
    /// exists only for the (redeploy-the-oracle) contingency; note the
    /// asymmetry with `set_controller`, which is deliberately one-time —
    /// the barrier target must stay rotatable because the vault cannot
    /// function safely against a dead oracle, while a controller swap has
    /// no such recovery need. Emits `oracle_set` so monitoring catches any
    /// re-wire of the barrier target.
    ///
    /// Refuses while the CURRENT oracle reports pending public outcomes:
    /// a fresh oracle starts with a zero pending count, so swapping the
    /// barrier target mid-incident would open the barrier at the stale
    /// pre-settlement share price — exactly the LP-vs-LP value transfer the
    /// barrier exists to prevent. When the old oracle is unreachable and
    /// this check cannot even execute, use `force_set_oracle`.
    #[only_owner]
    pub fn set_oracle(e: &Env, oracle: Address) {
        if settlement_pending(e) {
            panic_with_error!(e, Error::OraclePendingOutcomesUnreconciled);
        }
        e.storage().instance().set(&VaultKey::Oracle, &oracle);
        Self::extend_ttl(e);
        OracleSet {
            oracle,
            forced: false,
        }
        .publish(e);
    }

    /// Rotate the oracle WITHOUT consulting the current one — the escape
    /// hatch for the very contingency rotation exists for: the old oracle is
    /// dead, archived, or itself the incident, so `set_oracle`'s
    /// pending-outcomes check cannot even execute. Requires the vault to be
    /// paused first: the new oracle knows nothing of outcomes still pending
    /// against the old one, so every LP entry/exit must stay blocked until
    /// the owner reconciles that PnL and deliberately unpauses. The emitted
    /// event carries `forced = true` so monitoring treats the rotation as an
    /// open incident rather than routine configuration.
    #[only_owner]
    pub fn force_set_oracle(e: &Env, oracle: Address) {
        if !paused(e) {
            panic_with_error!(e, Error::ForcedRotationRequiresPause);
        }
        e.storage().instance().set(&VaultKey::Oracle, &oracle);
        Self::extend_ttl(e);
        OracleSet {
            oracle,
            forced: true,
        }
        .publish(e);
    }

    /// Set the minimum asset value a queued withdrawal request must carry at
    /// submission time (owner-only). The withdrawal queue is a bounded shared
    /// resource: without a value floor, one participant can split shares
    /// across many addresses and occupy every slot with near-dust requests,
    /// locking later underwriters out of the FIFO exit path. A meaningful
    /// minimum makes each slot cost real escrowed capital. Zero disables the
    /// floor. Choose the value in underlying-asset units, well below typical
    /// LP position sizes so small underwriters can still queue their exits.
    ///
    /// The enforcement is clamped at request time to a small fraction of
    /// managed assets (see `MIN_REQUEST_FLOOR_DIVISOR`), so no configured
    /// value — however large — can lock ordinary positions out of the queue.
    #[only_owner]
    pub fn set_min_withdrawal_request(e: &Env, min_assets: i128) {
        // Zero is a valid value (disables the floor); only negatives are
        // rejected, with a dedicated error so clients aren't misled into
        // thinking zero is also invalid.
        if min_assets < 0 {
            panic_with_error!(e, Error::AmountMustBeNonNegative);
        }
        e.storage()
            .instance()
            .set(&VaultKey::MinWithdrawalRequest, &min_assets);
        Self::extend_ttl(e);
        MinWithdrawalRequestSet { min_assets }.publish(e);
    }

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
}
