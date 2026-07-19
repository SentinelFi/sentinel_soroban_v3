use soroban_sdk::{contractevent, Address, Symbol};

use crate::storage::SettlementStatus;

// Topics prefix scheme: every Sentinel-protocol event leads
// with `"sentinel"` so off-chain indexers can subscribe once; the second
// prefix discriminates the event type (`register`, `settle`, etc.). The
// emitting contract is identified by the event envelope's contract address —
// some second prefixes (e.g. `controller_set`, `upgrade`) are shared across
// contracts.
#[contractevent(topics = ["sentinel", "register"], data_format = "map")]
pub struct FlightRegistered {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) premium: i128,
    pub(crate) payoff: i128,
    pub(crate) delay_hours: u32,
}

#[contractevent(topics = ["sentinel", "buyer"], data_format = "single-value")]
pub struct BuyerAdded {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) buyer: Address,
}

#[contractevent(topics = ["sentinel", "settle"], data_format = "map")]
pub struct FlightSettled {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) status: SettlementStatus,
    pub(crate) claim_expiry: u64,
}

#[contractevent(topics = ["sentinel", "claim"], data_format = "map")]
pub struct PayoutClaimed {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) traveler: Address,
    pub(crate) amount: i128,
}

#[contractevent(topics = ["sentinel", "sweep"], data_format = "single-value")]
pub struct ExpiredSwept {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) unclaimed: i128,
}

#[contractevent(topics = ["sentinel", "withdraw"], data_format = "single-value")]
pub struct RecoveredWithdrawn {
    #[topic]
    pub(crate) owner: Address,
    pub(crate) amount: i128,
}

// Owner-only one-time wiring of the authorized controller. Emitted for the
// audit trail.
#[contractevent(topics = ["sentinel", "controller_set"], data_format = "single-value")]
pub struct ControllerSet {
    #[topic]
    pub(crate) controller: Address,
}

// Diagnostic: settlement tried to drop this flight from the active set but the
// swap-remove no-op'd (its page/index archived at that moment). The bucket
// stays counted and enumerable, so nothing is lost — but the pool trims the
// set only at settlement and never retries, so operators should reconcile
// (restore the page, or accept the residual count drift) rather than let it
// silently accumulate toward the registration cap. Mirrors the observability
// of the oracle's page-miss / controller's ttl-miss diagnostics.
#[contractevent(topics = ["sentinel", "prune_missed"], data_format = "single-value")]
pub struct ActiveSetPruneMissed {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
}
