use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub enum VaultKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Controller,
    TotalManagedAssets,
    LockedCapital,
    WithdrawalQueue,
    NextRequestId,
    LastSnapshotTime,

    // Persistent — TTL extended on every write to prevent silent archival
    ClaimableBalance(Address),

    // Temporary — auto-deletes on TTL expiry, no archival rent
    SnapshotPrice(u64),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawalRequest {
    pub request_id: u64,
    pub owner: Address,
    pub shares: i128,
    pub timestamp: u64,
}

/// Mode for `recover_uncollected` — owner-driven manual recovery of an
/// archived `ClaimableBalance` entry. Carried on the wire via the
/// `vault.recovered` event so the off-chain indexer can update its
/// `claimable_balances` table accordingly.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RecoveryMode {
    /// Re-credit `ClaimableBalance(user) = amount`. Sets (not adds) so the
    /// owner provides the full owed amount reconstructed from event logs.
    /// Future `process_withdrawal_queue` credits ADD on top normally.
    Recredit,
    /// Transfer USDC directly from vault to user. No `ClaimableBalance`
    /// storage write. Indexer DELETEs the address from its tracker.
    Transfer,
}

pub(crate) const SECONDS_PER_DAY: u64 = 86400;

/// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800.
/// Applied on every `ClaimableBalance(addr)` write to prevent silent archival
/// of per-user pending USDC. Layered defense:
/// 1. On-write extension (this constant).
/// 2. Off-chain TTL cron footprint extension via the indexer.
/// 3. `recover_uncollected` owner manual fallback.
pub(crate) const CLAIMABLE_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;

/// 30 days at 5s/ledger = 30 * 24 * 60 * 12 = 518_400.
/// Applied on every `SnapshotPrice(day)` Temporary write. Snapshots are
/// short-lived — recent ones queryable on-chain; older entries auto-delete
/// with no archival rent. Historical analytics happen off-chain via events.
pub(crate) const SNAPSHOT_TTL_LEDGERS: u32 = 30 * 24 * 60 * 12;
