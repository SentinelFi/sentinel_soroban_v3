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
    ///
    ///   INVARIANT: this MUST be the exact same OracleAggregator the controller
    ///   is constructed with. The controller registers flights and drives
    ///   settlement against ITS oracle (an immutable, construction-time
    ///   pointer with no setter), while the barrier reads pending outcomes from
    ///   the vault's oracle. If the two ever diverge, the pending-outcome
    ///   counter the barrier watches is maintained on a different contract than
    ///   the one recording outcomes, so the barrier reads zero and LP
    ///   entry/exit prices at a stale share price. Nothing on-chain can
    ///   cross-check this (the vault is deployed before the controller exists),
    ///   so it is a deployment-verification obligation — see `set_oracle`.
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
    ///
    /// Also refuses while any capital is locked: locked collateral means
    /// policies are outstanding whose outcomes will become public on the OLD
    /// oracle's settlement pipeline (the controller's oracle pointer is fixed
    /// at construction). A replacement oracle starts blind to those flights,
    /// so rotating before they settle would leave the barrier open through
    /// their future public-but-unsettled windows. The pending check alone
    /// only covers outcomes already public at the instant of rotation;
    /// together the two checks span the whole policy lifetime from purchase
    /// to settlement.
    ///
    /// CRITICAL — these guards only prove the state is clean AT rotation time;
    /// they do NOT bind the new oracle to the controller. The controller's
    /// oracle pointer is immutable, so the ONLY correct target here is the
    /// controller's own oracle (see the constructor's INVARIANT note).
    /// Pointing the vault at any other live oracle silently defeats the
    /// barrier for every FUTURE policy: new flights still register on the
    /// controller's oracle, whose outcome disclosures never touch this new
    /// oracle's pending counter. Because the controller cannot follow a
    /// rotation, a genuine oracle redeploy requires redeploying the controller
    /// (and re-wiring the vault) too — this setter is not an escape from that.
    /// Verify `new == controller.oracle` off-chain before calling.
    #[only_owner]
    pub fn set_oracle(e: &Env, oracle: Address) {
        if settlement_pending(e) {
            panic_with_error!(e, Error::OraclePendingOutcomesUnreconciled);
        }
        if Self::get_locked_capital(e) > 0 {
            panic_with_error!(e, Error::OracleActiveExposureUnreconciled);
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
    /// pending-outcomes check cannot even execute (and its locked-capital
    /// check may never clear if the dead pipeline can no longer settle the
    /// outstanding policies). Requires the vault to be paused first: the new
    /// oracle knows nothing of policies still outstanding or outcomes still
    /// pending against the old one, so every LP entry/exit must stay blocked
    /// until the owner reconciles that PnL and deliberately unpauses. The emitted
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

    /// Set the minimum asset value a queued request — withdrawal or deposit —
    /// must carry at submission time (owner-only). Both queues are bounded
    /// shared resources: without a value floor, one participant can split
    /// capital across many addresses and occupy every slot with near-dust
    /// requests, locking later underwriters out of the FIFO paths. A meaningful
    /// minimum makes each slot cost real escrowed capital. Zero disables the
    /// configured floor (an occupancy-scaled protocol floor still applies at
    /// request time, so unset does not mean slots are free to squat). Choose
    /// the value in underlying-asset units, well below typical LP position
    /// sizes so small underwriters can still queue their exits.
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
