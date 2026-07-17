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
    // OracleAggregator address, wired at construction (owner-rotatable via
    // set_oracle). Entry/exit are blocked while the oracle reports an
    // unsettled public flight outcome, so no LP can transact at a stale
    // share price during the outcome-public-but-not-yet-settled window.
    Oracle,
    // Minimum asset value (at request time) a queued withdrawal must carry.
    // Owner-tuned per deployment; 0 (the default) disables the floor. Raises
    // the capital cost of occupying the bounded queue's slots with many small
    // requests spread across addresses.
    MinWithdrawalRequest, // i128
    // Percentage of locked capital that managed assets must keep covering
    // (100 = nominal backing only). Mirrored from the controller — the single
    // owner-facing configuration point — via the controller-only
    // `set_solvency_ratio`, because the vault cannot read it back on demand:
    // the controller invokes `process_withdrawal_queue`, and a call from the
    // vault into the controller during that invocation would be reentrant.
    // Every exit path derives its withdrawable amount from this, so LP exits
    // preserve the same reserve margin purchases are admitted against.
    SolvencyRatio, // u32 — Instance; absent = 100

    // Persistent — TTL extended on every write to prevent silent archival
    ClaimableBalance(Address),

    // Temporary — auto-deletes on TTL expiry, no archival rent
    SnapshotPrice(u64),
}

// No timestamp field: request time is never read on-chain (the queue is
// strict-FIFO by position, not by age) and the `wd_req` event already
// timestamps each request via its ledger. Omitting it keeps the size-capped
// single-entry queue as small as possible.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawalRequest {
    pub request_id: u64,
    pub owner: Address,
    pub shares: i128,
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
    /// Transfer asset directly from vault to user. No `ClaimableBalance`
    /// storage write. Indexer DELETEs the address from its tracker.
    Transfer,
}
