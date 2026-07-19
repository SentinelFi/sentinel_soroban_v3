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
    /// ~7 days at 5s/ledger (7 * 24 * 60 * 12).
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

    /// Buyer policy proofs (the pool's `Buyer(flight_id, date, traveler)`
    /// entries) are written once at purchase with the network-maximum
    /// persistent TTL and are never re-extended on-chain — the pool cannot
    /// iterate buyers after settlement. 3,110,400 ledgers is 180 days of
    /// wall time only at the assumed ~5 s/ledger cadence.
    pub const BUYER_PROOF_TTL_LEDGERS: u32 = 3_110_400;

    /// The proof lifetime above expressed in seconds at the assumed
    /// cadence — the wall-clock budget that the booking horizon plus the
    /// claim-deadline cap must fit inside (compile-time asserted in the
    /// controller, whose booking horizon supplies the other term).
    pub const BUYER_PROOF_TTL_SECS: u64 = 15_552_000;

    /// Latest claim deadline a settlement may open, measured from the
    /// flight date. The earliest possible purchase writes its buyer proof
    /// up to the full booking horizon before departure, so a claim window
    /// reaching past `date + (proof lifetime − booking horizon)` would
    /// outlive the earliest buyers' proofs. At the current values (90-day
    /// horizon, 180-day proof) this cap sits exactly at that boundary —
    /// zero slack — and, like every wall-time figure in this crate, it
    /// assumes the ~5 s/ledger cadence. A proof that does archive is not a
    /// lost claim (an archived Persistent entry is restored with its
    /// original value when next accessed, at a restoration cost); the cap
    /// and the controller's compile-time assert exist so this boundary is
    /// only ever moved by a conscious edit, never by drift between crates.
    pub const MAX_CLAIM_DEADLINE_AFTER_DATE_SECS: u64 = 90 * 86_400;

    // The two proof-lifetime representations must agree at the assumed
    // cadence, or every bound derived from one of them silently diverges
    // from entries actually extended with the other.
    const _: () = assert!(
        BUYER_PROOF_TTL_SECS * crate::ttl::LEDGERS_PER_SECOND_NUM
            / crate::ttl::LEDGERS_PER_SECOND_DEN
            == BUYER_PROOF_TTL_LEDGERS as u64,
        "buyer proof TTL seconds/ledgers mismatch at the assumed cadence",
    );
}

/// Solvency-reserve parameters shared by the Controller (owner setter and
/// purchase admission) and the RiskVault (controller-pushed mirror and exit
/// bound). The vault rejects pushed ratios outside these bounds and the
/// controller rejects owner updates outside them, so a drifted copy on either
/// side would brick `set_solvency_ratio` — one definition removes the hazard.
pub mod solvency {
    /// Lower bound on the solvency ratio (percent): payouts must be at least
    /// nominally backed.
    pub const MIN_SOLVENCY_RATIO: u32 = 100;
    /// Upper bound on the solvency ratio (percent): 100× practical sanity cap.
    pub const MAX_SOLVENCY_RATIO: u32 = 10_000;

    /// Reserve required to back `locked` payoff liabilities at `ratio`
    /// percent: `ceil(locked × ratio / 100)`, rounded up so integer
    /// truncation can never under-provision the reserve. The purchase
    /// admission check and the vault's withdrawable-capital bound both use
    /// this — sharing the computation keeps the reserve a purchase just
    /// verified identical to the reserve exits are held back from.
    ///
    /// PRECONDITION: `locked >= 0`. The `+99` ceil trick rounds toward +∞ only
    /// for a non-negative product; a negative `locked` would truncate toward
    /// zero and mis-round by one. Both callers pass a non-negative locked-capital
    /// sum (locked collateral is only ever increased from zero and decreased no
    /// further), so this never fires in correct operation. It is enforced in
    /// PRODUCTION (not merely `debug_assert`) as a fail-closed backstop: this
    /// figure gates solvency admission and LP-exit sizing, so reverting the
    /// transaction on an upstream accounting bug is far safer than silently
    /// returning a wrong reserve. Consistent with the panic-on-invariant idiom
    /// the `.expect(...)` overflow checks below already use.
    pub fn required_reserve(locked: i128, ratio: u32) -> i128 {
        assert!(locked >= 0, "required_reserve requires locked >= 0");
        locked
            .checked_mul(ratio as i128)
            .expect("multiplication overflow")
            .checked_add(99)
            .expect("addition overflow")
            .checked_div(100)
            .expect("division by zero")
    }
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

/// Per-flight oracle record, stored under a `(flight_id, date)` key.
///
/// The `date` key component is the flight's **UTC departure day** — midnight
/// UTC of the departure date, in unix seconds (a multiple of 86,400; the
/// purchase path enforces the alignment). Executors and frontends MUST
/// derive it from the departure timestamp **in UTC**, never in the airport's
/// local timezone: `set_estimated_arrival` / `set_landed` reject any arrival
/// timestamp below `date`, and a short flight departing early-morning local
/// time east of UTC (e.g. 01:00 JST = 16:00 UTC the previous day) can arrive
/// before midnight UTC of its *local* departure date. A component keying
/// instances by local date would therefore have legitimate outcome writes
/// rejected (`InvalidTimestamp`); the flight would strand in `Active` and be
/// voided as on-time by the active timeout, irreversibly denying genuinely
/// delayed or cancelled travelers. This invariant carries the same weight as
/// the `scheduled_in` rule below and must survive every executor backend
/// migration.
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
