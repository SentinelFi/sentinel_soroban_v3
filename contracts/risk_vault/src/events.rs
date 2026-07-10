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

// Owner-only one-time wiring of the authorized controller. Emitted for the
// audit trail.
#[contractevent(topics = ["sentinel", "controller_set"], data_format = "single-value")]
pub struct ControllerSet {
    #[topic]
    pub(crate) controller: Address,
}
