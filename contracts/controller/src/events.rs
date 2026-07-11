use soroban_sdk::{contractevent, Address, Symbol};

use crate::interfaces::FlightStatus;

// Domain events use distinct second topics (`bought` / `classified` /
// `settled`) — matching the distinct-verb scheme every other contract uses —
// so indexers can discriminate at the topic-filter level instead of decoding
// payloads. The emitting contract address on the event envelope already
// scopes them to the controller.
#[contractevent(topics = ["sentinel", "bought"], data_format = "single-value")]
pub struct InsuranceBought {
    #[topic]
    pub(crate) traveler: Address,
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) premium: i128,
}

#[contractevent(topics = ["sentinel", "classified"], data_format = "single-value")]
pub struct FlightClassified {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) status: FlightStatus,
}

#[contractevent(topics = ["sentinel", "settled"], data_format = "single-value")]
pub struct FlightSettledEvent {
    #[topic]
    pub(crate) flight_id: Symbol,
    #[topic]
    pub(crate) date: u64,
    pub(crate) outcome: FlightStatus,
}

// Diagnostic warning emitted by `classify_flights` when oracle returns
// NotInitiated for a flight in the active list — signals that FlightData
// may have archived (or oracle hasn't fetched data yet for an overdue
// flight). Consumed by the off-chain TTL-extender cron.
#[contractevent(topics = ["sentinel", "ttl_miss"], data_format = "map")]
pub struct TtlMiss {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

// Diagnostic emitted by `classify_flights` / `execute_settlements`
// when a flight is present in the oracle active list but its FlightConfig is
// missing from FlightPoolManager (archived past TTL, or never registered).
// The flight is skipped instead of panicking the whole keeper loop; the
// off-chain cron consumes this to investigate / re-extend TTL.
#[contractevent(topics = ["sentinel", "cfg_missing"], data_format = "map")]
pub struct FlightConfigMissing {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

// Emitted when `classify_flights` voids a purchased flight whose oracle row
// never left NotInitiated within the stale timeout after departure — no
// flight data ever arrived, so the date most likely never matched a physical
// flight. The bucket settles like an on-time flight (premiums to the vault,
// collateral released, no payout). Operators consume this to spot bogus-date
// purchases and to distinguish voids from ordinary on-time settlements.
#[contractevent(topics = ["sentinel", "voided"], data_format = "map")]
pub struct FlightVoided {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

// Emitted when `classify_flights` voids an Active flight whose terminal
// oracle outcome (Landed/Cancelled) never arrived within the active timeout
// past its recorded scheduled arrival — the oracle pipeline stopped resolving
// this flight after the estimated-arrival write. The bucket settles like an
// on-time flight (premiums to the vault, collateral released, no payout).
// Distinct from `FlightVoided` (no data ever arrived) and from an ordinary
// on-time settlement so operators can spot oracle-liveness gaps.
#[contractevent(topics = ["sentinel", "timed_out"], data_format = "map")]
pub struct FlightTimedOutActive {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
}

// Emitted when the owner terminally reconciles a flight that was evicted
// from the oracle's active list: the pool bucket is settled like a voided
// flight (held premiums become vault income, no payout) and the vault
// collateral reserved for it is released. `collateral_released` is
// payoff × buyer_count; `premium_income` is the amount the pool forwarded
// to the vault. Indexers pair this with the oracle's eviction event to
// close out the flight's lifecycle.
#[contractevent(topics = ["sentinel", "evict_settled"], data_format = "map")]
pub struct EvictedFlightSettled {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) date: u64,
    pub(crate) premium_income: i128,
    pub(crate) collateral_released: i128,
}

// Phase 11 — buyer whitelist lifecycle events. The whitelist itself is
// stored on Controller (one source of truth on the buy path); add/remove
// callers are validated by cross-calling GovernanceModule.is_admin.
#[contractevent(topics = ["sentinel", "buyer_whitelisted"], data_format = "single-value")]
pub struct BuyerWhitelistedEvent {
    #[topic]
    pub(crate) addr: Address,
}

#[contractevent(topics = ["sentinel", "buyer_removed"], data_format = "single-value")]
pub struct BuyerWhitelistRemovedEvent {
    #[topic]
    pub(crate) addr: Address,
}

#[contractevent(topics = ["sentinel", "whitelist_toggled"], data_format = "single-value")]
pub struct WhitelistToggled {
    pub(crate) enabled: bool,
}

// --- Owner-only configuration audit events ---

#[contractevent(topics = ["sentinel", "keeper_set"], data_format = "single-value")]
pub struct KeeperSet {
    #[topic]
    pub(crate) keeper: Address,
}

#[contractevent(topics = ["sentinel", "solvency_ratio_set"], data_format = "single-value")]
pub struct SolvencyRatioSet {
    pub(crate) ratio: u32,
}

#[contractevent(topics = ["sentinel", "min_lead_time_set"], data_format = "single-value")]
pub struct MinLeadTimeSet {
    pub(crate) seconds: u64,
}

#[contractevent(topics = ["sentinel", "claim_expiry_window_set"], data_format = "single-value")]
pub struct ClaimExpiryWindowSet {
    pub(crate) seconds: u64,
}
