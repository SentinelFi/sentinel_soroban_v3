//! OracleAggregator compile-time constants.

/// Maximum active-list entries inspected per `prune_settled` call.
/// Bounds the expensive per-entry persistent lookups so pruning cannot become
/// uncallable as the list grows. Each call advances a rotating cursor, so
/// repeated calls eventually sweep the whole list.
///
/// A 100-entry inspection window required ~103
/// footprint ledger entries once the fixed contract-instance/invocation entries
/// were added, exceeding Soroban's 100-entry transaction footprint limit and
/// reverting before any state change. 60 leaves comfortable headroom (the
/// rotating cursor still sweeps the full list across repeated calls).
pub(crate) const MAX_PRUNE_BATCH: u32 = 60;

/// Hard cap on `ActiveFlightList` length. The list is a single `Vec` in the
/// contract-instance entry, which Soroban bounds to 65,536 bytes (~1,600
/// entries in the current layout). An unbounded list could grow until that
/// entry becomes unwritable, freezing registration and the instance-state
/// writes that piggyback on it. Capping length well below the limit turns that
/// ungraceful failure into a clean, early rejection with headroom for symbol-
/// length variance and other instance state, and keeps `prune_settled`'s
/// full-list scan bounded. Full resolution (individually-keyed active entries
/// + a compact index) is a larger storage migration tracked separately.
pub(crate) const MAX_ACTIVE_FLIGHTS: u32 = 1_000;

pub(crate) const PERSISTENT_TTL_EXTEND: u32 = 535_680; // ~31 days

// Deadline-derived TTL inputs. A flight may be insured up to
// 90 days before departure, but `extend_flight_ttl` only bumps FlightData by a
// flat ~31 days — so a long-dated record could archive before the oracle ever
// reports on it, after which every lifecycle write panics ("flight not
// registered"). `extend_flight_ttl_to` instead sizes the extension to cover the
// flight date plus a settlement buffer.
pub(crate) const TTL_BUFFER_LEDGERS: u32 = 518_400; // ~30 days at 5s/ledger
pub(crate) const LEDGERS_PER_SECOND_NUM: u64 = 1;
pub(crate) const LEDGERS_PER_SECOND_DEN: u64 = 5; // ~5 s per ledger on mainnet
                                                  // ~180 days = Stellar's maximum persistent-entry TTL. extend_ttl panics if the
                                                  // target exceeds the network max, so any computed extension is clamped here.
pub(crate) const MAX_PERSISTENT_TTL_LEDGERS: u32 = 3_110_400;

// Settled flights stay in `ActiveFlightList` for SETTLED_RETENTION_DAYS after
// `set_settled` records their `settled_at` timestamp. Pruning is delegated to
// the permissionless `prune_settled` entry — keeps freshly-settled flights
// visible to off-chain monitoring / indexers / observability tooling for the
// retention window before they disappear from the list.
pub(crate) const SETTLED_RETENTION_DAYS: u64 = 30;
pub(crate) const SECONDS_PER_DAY: u64 = 86_400;
