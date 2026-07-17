//! FlightPoolManager compile-time constants.

// Per-flight persistent TTL sizing (flat threshold/extend, the ~30-day
// post-deadline buffer, ledger-time conversion, and the network-max clamp)
// lives in `sentinel_types::ttl`, shared with the oracle so the two
// per-flight TTL schemes can never drift apart. The buffer past claim_expiry
// (~30 days) combined with the claim window (default 60d) gives ~90 days of
// post-settle TTL on FlightConfig — long enough that a cron lapse cannot
// archive the entry while a buyer can still claim.

// Buyer key TTL: written once at add_buyer time (settlement-time deadlines
// are unknown then, and the contract cannot iterate buyers afterwards to
// re-extend on-chain; key-level extension by the off-chain TTL cron —
// reconstructing buyer keys from `BuyerAdded` events — is a planned executor
// improvement, not implemented today). The constant is shared with the
// controller through `sentinel_types::timeouts`, together with the
// claim-deadline cap below, because the two jointly carry a cross-crate
// invariant: booking horizon + claim-deadline cap must fit inside the proof
// lifetime. The controller compile-time-asserts that bound against these
// same definitions, so a change to either side trips it.
pub(crate) use sentinel_types::timeouts::{
    BUYER_PROOF_TTL_LEDGERS as BUYER_TTL_LEDGERS, MAX_CLAIM_DEADLINE_AFTER_DATE_SECS,
};

/// Sanity cap on the paginated active-flight set. The set lives in
/// per-page persistent entries (see `sentinel_types::active_set`), so
/// capacity no longer competes with the 65,536-byte contract-instance entry
/// that bounded the old single-vector list to 1,000 flights — the cap is now
/// purely an operational guard against unbounded growth, set far above any
/// plausible concurrent flight volume. Settled flights are removed on
/// settlement, freeing capacity. Matches the OracleAggregator cap.
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 100_000;
