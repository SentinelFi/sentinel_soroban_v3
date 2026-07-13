// Emitted on every `ClaimableBalance` state change. Powers the off-chain
// indexer which maintains a list of addresses with non-zero balances; that
// list feeds the off-chain TTL cron's `ExtendFootprintTTLOp` extensions.
//
// Topic scheme: `["sentinel", <verb>]`. The `#[contractevent]` macro caps the
// prefix list at 2 entries, so we use the protocol namespace + verb; the
// emitting contract address (passed through the event envelope) tells the
// indexer which contract emitted it, removing the need for a middle
// `"vault"` discriminator.

use soroban_sdk::{contractevent, Address};

use crate::storage::RecoveryMode;

#[contractevent(topics = ["sentinel", "credited"], data_format = "map")]
pub struct Credited {
    #[topic]
    pub(crate) user: Address,
    pub(crate) amount: i128,
    pub(crate) new_balance: i128,
}

#[contractevent(topics = ["sentinel", "collected"], data_format = "single-value")]
pub struct Collected {
    #[topic]
    pub(crate) user: Address,
    pub(crate) amount: i128,
}

#[contractevent(topics = ["sentinel", "recovered"], data_format = "map")]
pub struct Recovered {
    #[topic]
    pub(crate) user: Address,
    pub(crate) amount: i128,
    pub(crate) mode: RecoveryMode,
}

#[contractevent(topics = ["sentinel", "snapshot"], data_format = "map")]
pub struct SharePriceSnapshot {
    #[topic]
    pub(crate) day: u64,
    pub(crate) price: i128,
}

// Emitted on every accepted withdrawal request. `queue_len` is the queue
// occupancy AFTER the push: the queue is a bounded shared resource, so
// operators subscribe to this to alert when occupancy approaches the cap
// (impending rejection of new exit requests / possible slot monopolization).
#[contractevent(topics = ["sentinel", "wd_req"], data_format = "map")]
pub struct WithdrawalRequested {
    #[topic]
    pub(crate) owner: Address,
    pub(crate) request_id: u64,
    pub(crate) shares: i128,
    pub(crate) queue_len: u32,
}

// Emitted when an underwriter cancels a queued request. Mirrors
// `WithdrawalRequested` (including post-removal occupancy) so indexers can
// reconstruct queue state and escrowed-share totals from events alone —
// without this, a cancelled request would look forever-pending off-chain.
#[contractevent(topics = ["sentinel", "wd_cancel"], data_format = "map")]
pub struct WithdrawalCancelled {
    #[topic]
    pub(crate) owner: Address,
    pub(crate) request_id: u64,
    pub(crate) shares: i128,
    pub(crate) queue_len: u32,
}

// Emitted when queue processing funds part of the head request from the free
// capital available in the pass. The request stays at the head with
// `shares_remaining` still escrowed; `Credited` fires separately for the asset
// amount. Without this, an indexer reconciling `WithdrawalRequested` shares
// against `Credited` amounts could not tell a partial fill from a completed
// request followed by an unrelated credit.
#[contractevent(topics = ["sentinel", "wd_partial"], data_format = "map")]
pub struct RequestPartiallyFilled {
    #[topic]
    pub(crate) owner: Address,
    pub(crate) request_id: u64,
    pub(crate) shares_filled: i128,
    pub(crate) shares_remaining: i128,
}

// Emitted when queue processing drops a request whose asset value decayed to
// zero (share price fell after it was queued) and returns the escrowed shares
// to the owner. No `Credited` fires for such a request, so this is the only
// signal that closes it out for queue-tracking indexers — and it tells the
// owner their exit did NOT happen and must be re-requested.
#[contractevent(topics = ["sentinel", "wd_dropped"], data_format = "map")]
pub struct RequestDropped {
    #[topic]
    pub(crate) owner: Address,
    pub(crate) request_id: u64,
    pub(crate) shares: i128,
}

// Owner-only one-time wiring of the authorized controller. Emitted for the
// audit trail.
#[contractevent(topics = ["sentinel", "controller_set"], data_format = "single-value")]
pub struct ControllerSet {
    #[topic]
    pub(crate) controller: Address,
}

// Owner rotated the OracleAggregator address the settlement barrier consults.
// The barrier is the vault's core LP-pricing protection, so a re-wire is a
// security-relevant configuration change — off-chain monitoring subscribes to
// this to detect an unexpected (or missing) barrier target. Mirrors the
// oracle contract's own `oracle_set` audit event. `forced` records which
// path performed the rotation: the checked one (old oracle read clear of
// pending outcomes) or the paused-only escape hatch that skipped the check
// because the old oracle was unreachable — monitoring treats a forced
// rotation as an open incident until the pending PnL is reconciled and the
// vault deliberately unpaused.
#[contractevent(topics = ["sentinel", "oracle_set"], data_format = "single-value")]
pub struct OracleSet {
    #[topic]
    pub(crate) oracle: Address,
    pub(crate) forced: bool,
}

// Controller mirrored the owner-configured solvency ratio into the vault.
// The ratio determines how much of the nominal free margin exit paths must
// hold back, so monitoring subscribes to catch an unexpected loosening of
// the reserve (or a missing propagation after an upgrade).
#[contractevent(topics = ["sentinel", "ratio_set"], data_format = "single-value")]
pub struct SolvencyRatioSet {
    pub(crate) ratio: u32,
}

// Owner tuned the minimum asset value a queued withdrawal request must carry
// (anti dust-squatting floor for the bounded queue; 0 disables it). Emitted
// for the audit trail, matching the controller's owner-setter events.
#[contractevent(topics = ["sentinel", "min_wd_req_set"], data_format = "single-value")]
pub struct MinWithdrawalRequestSet {
    pub(crate) min_assets: i128,
}
