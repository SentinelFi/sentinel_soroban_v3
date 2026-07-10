//! GovernanceModule compile-time constants.

// 120 days at 5s/ledger = 120 * 24 * 60 * 12 = 2_073_600.
// Applied on every Route(...) write/read to keep routes from archival drift.
// Sized generously (route entries are tiny, so the extra rent is negligible)
// because an archived approved route silently reads as never-whitelisted and
// blocks its sales; the off-chain TTL cron folding Route(...) keys into its
// ExtendFootprintTTLOp footprint remains the layered defense for fully idle
// routes.
pub(crate) const ROUTE_TTL_LEDGERS: u32 = 120 * 24 * 60 * 12;

/// How long a removed route's `flight_id` stays reserved before it may be
/// re-whitelisted with a different origin/destination. Downstream pool and
/// oracle state is keyed by `(flight_id, date)` only, so remapping the id
/// while policies from the old route can still be live would collide their
/// records. 160 days covers the 90-day booking horizon plus the claim-expiry
/// window and settlement slack.
pub(crate) const FLIGHT_ID_RETIREMENT_SECS: u64 = 160 * 86_400;

/// TTL applied to the retirement marker — must outlive the retirement
/// deadline (168 days of ledgers > 160-day reservation, and under the
/// ~180-day network maximum), otherwise an archived marker would silently
/// reopen the flight_id early.
pub(crate) const RETIREMENT_TTL_LEDGERS: u32 = 168 * 24 * 60 * 12;
