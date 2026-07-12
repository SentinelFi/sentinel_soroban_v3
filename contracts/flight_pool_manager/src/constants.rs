//! FlightPoolManager compile-time constants.

// Per-flight persistent TTL sizing (flat threshold/extend, the ~30-day
// post-deadline buffer, ledger-time conversion, and the network-max clamp)
// lives in `sentinel_types::ttl`, shared with the oracle so the two
// per-flight TTL schemes can never drift apart. The buffer past claim_expiry
// (~30 days) combined with the claim window (default 60d) gives ~90 days of
// post-settle TTL on FlightConfig — long enough that a cron lapse cannot
// archive the entry while a buyer can still claim.

// Buyer key TTL: 180 days at add_buyer time.
// Architecture says "claim_expiry + 30d on write" but add_buyer runs before
// settlement, so claim_expiry is unknown at write time. 180 days covers worst
// case 90d flight book-ahead + 60d claim window + 30d safety. No re-extension
// needed because the contract cannot iterate buyers after settlement.
// 180 days at 5s/ledger = 180 * 24 * 60 * 12 = 3,110,400.
pub(crate) const BUYER_TTL_LEDGERS: u32 = 3_110_400;

/// Latest claim deadline a settlement may open, measured from the flight
/// date. Buyer proofs are written at purchase with the fixed 180-day network
/// maximum TTL and cannot be re-extended later (there is no iterable buyer
/// list). The earliest possible purchase is 90 days before departure, so
/// every proof is guaranteed alive until at least `date + 90 days` — and no
/// longer. A claim window reaching past that point would stay open while the
/// earliest buyers' proofs archive, turning their valid claims into NoPolicy.
pub(crate) const MAX_CLAIM_DEADLINE_AFTER_DATE_SECS: u64 = 90 * 86_400;

/// Sanity cap on the paginated active-flight set. The set lives in
/// per-page persistent entries (see `sentinel_types::active_set`), so
/// capacity no longer competes with the 65,536-byte contract-instance entry
/// that bounded the old single-vector list to 1,000 flights — the cap is now
/// purely an operational guard against unbounded growth, set far above any
/// plausible concurrent flight volume. Settled flights are removed on
/// settlement, freeing capacity. Matches the OracleAggregator cap.
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 100_000;
