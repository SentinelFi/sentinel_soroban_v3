// SPDX-License-Identifier: Apache-2.0
// Copyright @SentinelFi

// Shared cross-contract types. Lives in its own crate so the canonical
// definitions and the controller-side mirrors are guaranteed to share a
// single XDR layout — eliminates the byte-level drift hazard.
//
// Every type here is part of the public ABI of at least one contract.
// Field/variant order is load-bearing for #[contracttype] codec — do NOT
// reorder without bumping all dependent contract versions in lockstep.

#![no_std]

use soroban_sdk::contracttype;

pub mod active_set;
pub mod interfaces;
pub mod upgrade;

#[cfg(feature = "testutils")]
pub mod test_support;

/// Instance-storage TTL constants. Every contract extends its instance entry
/// (the root single-row state the SDK auto-attaches to) on each
/// `extend_ttl` / `extend_instance_ttl` call. Values are the same across
/// contracts so they live here to avoid drift.
pub mod ttl {
    /// ~7 days at 5s/ledger (60 * 24 * 60 * 12 / 5).
    pub const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
    /// ~31 days at 5s/ledger (31 * 24 * 60 * 12).
    pub const INSTANCE_TTL_EXTEND: u32 = 535_680;

    /// ~7 days at 5s/ledger — threshold for flat Persistent extensions.
    pub const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
    /// ~31 days at 5s/ledger — flat floor for per-flight Persistent entries.
    pub const PERSISTENT_TTL_EXTEND: u32 = 535_680;
    /// ~30 days at 5s/ledger — safety buffer added past a business deadline
    /// when sizing a deadline-derived TTL extension.
    pub const TTL_BUFFER_LEDGERS: u32 = 518_400;
    /// ~180 days — Stellar's maximum persistent-entry TTL. `extend_ttl`
    /// panics if the target exceeds the network max, so every computed
    /// extension must be clamped to this.
    pub const MAX_PERSISTENT_TTL_LEDGERS: u32 = 3_110_400;
    /// Ledger-time conversion: ~5 s per ledger on mainnet, expressed as a
    /// ratio so the arithmetic stays integral.
    pub const LEDGERS_PER_SECOND_NUM: u64 = 1;
    pub const LEDGERS_PER_SECOND_DEN: u64 = 5;

    /// Ledger count that keeps a Persistent entry alive until `deadline_secs`
    /// plus the safety buffer. Never shortens: floors at
    /// [`PERSISTENT_TTL_EXTEND`] (a deadline already in the past yields the
    /// flat ~31-day extension) and clamps to the network maximum. Shared by
    /// the pool's and the oracle's per-flight TTL sizing so the two can never
    /// drift apart.
    pub fn deadline_extension_ledgers(now: u64, deadline_secs: u64) -> u32 {
        let secs_remaining = deadline_secs.saturating_sub(now);
        let ledgers_remaining =
            secs_remaining.saturating_mul(LEDGERS_PER_SECOND_NUM) / LEDGERS_PER_SECOND_DEN;
        let ledgers_remaining_u32 = u32::try_from(ledgers_remaining).unwrap_or(u32::MAX);
        ledgers_remaining_u32
            .saturating_add(TTL_BUFFER_LEDGERS)
            .clamp(PERSISTENT_TTL_EXTEND, MAX_PERSISTENT_TTL_LEDGERS)
    }
}

/// Cross-contract lifecycle timeouts. Shared between the Controller (which
/// decides when to act) and the OracleAggregator (which validates the acting
/// transition), so the two can never drift apart.
pub mod timeouts {
    /// How long after its scheduled departure a purchased flight may remain
    /// `NotInitiated` — i.e. no oracle data was EVER recorded for it — before
    /// the protocol may void it, settling it like an on-time flight
    /// (premiums to the vault, collateral released, no payout). A real flight
    /// gets its estimated arrival within one executor cycle of purchase, so a
    /// row still bare two weeks past departure means the date never matched a
    /// physical flight; without this timeout such a row would hold vault
    /// collateral and a policy-bucket slot forever.
    pub const STALE_FLIGHT_TIMEOUT_SECS: u64 = 14 * 86_400;

    /// How long past its SCHEDULED arrival an `Active` flight may wait for a
    /// terminal oracle outcome (`Landed` / `Cancelled`) before the protocol
    /// may void it, settling it like an on-time flight (premiums to the
    /// vault, collateral released, no payout). `Active` is the only
    /// collateral-locking state that previously had no bounded exit: if the
    /// oracle pipeline stopped after writing the estimated arrival, the row
    /// stayed `Active` forever, pinning the full payoff in the vault and an
    /// active-list slot in both the oracle and the pool. Two weeks past the
    /// scheduled arrival every real outcome is long since public, so a row
    /// still bare of one means the oracle cannot resolve this flight; voiding
    /// (never paying) is the safe default — paying without an attested
    /// outcome would let a data outage mint claims. The oracle can still
    /// write a real outcome any time before the void is classified.
    pub const ACTIVE_FLIGHT_TIMEOUT_SECS: u64 = 14 * 86_400;
}

// =========================================================================
// governance_module
// =========================================================================

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedTerms {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RouteStatus {
    Active(ResolvedTerms),
    Disabled,
    Unknown,
}

// =========================================================================
// oracle_aggregator
// =========================================================================

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum FlightStatus {
    NotInitiated,
    Active,
    Landed,
    Cancelled,
    ToBeSettledOnTime,
    ToBeSettledDelayed,
    ToBeSettledCancelled,
    Settled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlightData {
    pub status: FlightStatus,
    /// The flight's SCHEDULED arrival time (unix seconds) — the timetable
    /// value, written once at `NotInitiated → Active`. Delay classification
    /// computes `actual_arrival_time − estimated_arrival_time` against the
    /// per-route `delay_hours` threshold, so this field is the baseline every
    /// payout decision is measured from. Oracle executors MUST write the
    /// published schedule (AeroAPI `scheduled_in`), NEVER a delay-adjusted
    /// live estimate (`estimated_in`) — a live ETA absorbs announced delays
    /// and would classify genuinely delayed flights as on-time, silently
    /// denying valid claims.
    pub estimated_arrival_time: u64,
    pub actual_arrival_time: u64,
    pub settled_at: u64,
}

// =========================================================================
// flight_pool_manager
// =========================================================================

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlightConfig {
    pub premium: i128,
    pub payoff: i128,
    pub delay_hours: u32,
    pub buyer_count: u32,
    pub claimed_count: u32,
    pub status: SettlementStatus,
    pub claim_expiry: u64,
}
