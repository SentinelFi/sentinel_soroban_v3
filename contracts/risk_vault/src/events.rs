// Emitted on every `ClaimableBalance` state change. Powers the off-chain
// indexer which maintains a list of addresses with non-zero balances; that
// list feeds the off-chain TTL cron's `ExtendFootprintTTLOp` extensions.

use soroban_sdk::{contractevent, Address};

use crate::storage::RecoveryMode;

#[contractevent(topics = ["vault", "credited"], data_format = "map")]
pub struct Credited {
    #[topic]
    pub(crate) user: Address,
    pub(crate) amount: i128,
    pub(crate) new_balance: i128,
}

#[contractevent(topics = ["vault", "collected"], data_format = "single-value")]
pub struct Collected {
    #[topic]
    pub(crate) user: Address,
    pub(crate) amount: i128,
}

#[contractevent(topics = ["vault", "recovered"], data_format = "map")]
pub struct Recovered {
    #[topic]
    pub(crate) user: Address,
    pub(crate) amount: i128,
    pub(crate) mode: RecoveryMode,
}
