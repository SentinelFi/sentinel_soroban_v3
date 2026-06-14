//! FlightPoolManager compile-time constants.

pub(crate) const PERSISTENT_TTL_THRESHOLD: u32 = 120_960; // ~7 days
pub(crate) const PERSISTENT_TTL_EXTEND: u32 = 535_680; // ~31 days

// Buffer past claim_expiry: 30 days. Combined with claim_expiry_window (default
// 60d), gives ~90 days of post-settle TTL on FlightConfig — long enough that a
// cron lapse cannot archive the entry while a buyer can still claim.
pub(crate) const TTL_BUFFER_LEDGERS: u32 = 518_400; // ~30 days at 5s/ledger
pub(crate) const LEDGERS_PER_SECOND_NUM: u64 = 1;
pub(crate) const LEDGERS_PER_SECOND_DEN: u64 = 5; // ~5 s per ledger on mainnet

// Buyer key TTL: 180 days at add_buyer time.
// Architecture says "claim_expiry + 30d on write" but add_buyer runs before
// settlement, so claim_expiry is unknown at write time. 180 days covers worst
// case 90d flight book-ahead + 60d claim window + 30d safety. No re-extension
// needed because the contract cannot iterate buyers after settlement.
// 180 days at 5s/ledger = 180 * 24 * 60 * 12 = 3,110,400.
pub(crate) const BUYER_TTL_LEDGERS: u32 = 3_110_400;

// ~180 days = Stellar's maximum persistent-entry TTL. extend_ttl panics if the
// target exceeds the network max, so any computed extension is clamped to this.
pub(crate) const MAX_PERSISTENT_TTL_LEDGERS: u32 = 3_110_400;
