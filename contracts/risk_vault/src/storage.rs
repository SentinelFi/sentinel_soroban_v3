use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub enum VaultKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Controller,
    TotalManagedAssets,
    LockedCapital,
    WithdrawalQueue,
    // FIFO queue of pending LP entries (escrowed assets awaiting delayed
    // pricing) — the entry-side mirror of WithdrawalQueue. Shares the same
    // NextRequestId counter, so request ids are unique across both queues.
    DepositQueue,
    NextRequestId,
    LastSnapshotTime,
    // OracleAggregator address, wired at construction (owner-rotatable via
    // set_oracle). Entry/exit are blocked while the oracle reports an
    // unsettled public flight outcome, so no LP can transact at a stale
    // share price during the outcome-public-but-not-yet-settled window.
    Oracle,
    // Owner-configured minimum asset value (at request time) a queued
    // request — withdrawal or deposit — must carry. 0 (the default) disables
    // only this configured component; the occupancy-scaled protocol floor
    // still applies at request time (see MIN_REQUEST_FLOOR_DIVISOR). Raises
    // the capital cost of occupying the bounded queues' slots with many small
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

// `requested_at` is load-bearing: a request may only be priced once it is
// older than the LP pricing delay, so the share price it receives already
// reflects every flight outcome that was publicly knowable when the request
// was committed. Without the age gate, an LP who learns an outcome before
// the oracle transaction lands could exit (or enter) at the stale
// pre-outcome price and shift the known loss (or gain) to the other LPs —
// the on-chain settlement barrier only activates once the outcome is
// written, which is strictly after it becomes publicly knowable.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawalRequest {
    pub request_id: u64,
    pub owner: Address,
    pub shares: i128,
    pub requested_at: u64,
}

/// A pending LP entry: `assets` sit escrowed in the vault (excluded from
/// managed assets) until the request matures past the LP pricing delay and
/// queue processing mints shares at the then-current — post-outcome — share
/// price. See `WithdrawalRequest` on why pricing is delayed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DepositRequest {
    pub request_id: u64,
    pub owner: Address,
    pub assets: i128,
    pub requested_at: u64,
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
