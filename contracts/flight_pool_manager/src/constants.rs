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

/// Hard cap on `ActiveFlightList` length. The list is a single `Vec` in the
/// contract-instance entry, which Soroban bounds to 65,536 bytes (~1,600
/// entries in the current layout). An unbounded list could grow until that
/// entry becomes unwritable, freezing new flight registration (and settlement,
/// which rewrites the list on eviction). Capping length well below the limit
/// turns that ungraceful failure into a clean, early rejection with headroom
/// for symbol-length variance and other instance state. Settled flights are
/// removed on settlement, freeing capacity. Matches the OracleAggregator cap for
/// a uniform interim bound; full resolution (individually-keyed active entries)
/// is a larger storage migration tracked separately.
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 1_000;
