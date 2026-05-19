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
