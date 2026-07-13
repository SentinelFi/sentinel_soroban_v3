//! Controller compile-time constants.

/// Maximum flights inspected per `classify_flights` call. Each call scans a
/// bounded window of the oracle active list starting at a persisted rotating
/// cursor, so per-call resource cost stays bounded no matter how large the
/// list grows; the pass is idempotent on already-classified flights, so
/// rotating across calls guarantees full coverage. Classification is light
/// per flight — at most one oracle status rewrite plus reads and events — so
/// a 25-window stays well inside the per-transaction entry limits.
pub(crate) const MAX_CLASSIFY_BATCH: u32 = 25;

/// Maximum flights settled per `execute_settlements` call. Sized separately
/// from classification because settlement is far heavier per flight: each
/// settled flight rewrites the oracle FlightData and the pool FlightConfig,
/// and the pool-side active-set swap-removal can additionally write the
/// removed entry's index, its page, the moved tail entry's index, and the
/// tail page — on top of the shared vault/pool balance and counter entries
/// and several events per flight. A 25-flight all-cancelled window measures
/// ~83 written ledger entries and ~18 KB of contract events, past the
/// network's per-transaction budgets (~50 writes, 16 KB of events); because
/// the invocation is atomic, such a window reverts without advancing the
/// cursor and identical retries fail forever. 10 keeps the worst case near
/// ~40 writes and ~7 KB of events with margin for accounting drift, the
/// rotating cursor still covers the full list across repeated keeper calls,
/// and `execute_settlements_bounded` lets an operator shrink a stuck window
/// further, down to a single flight.
pub(crate) const MAX_SETTLE_BATCH: u32 = 10;

/// Seconds per UTC day. `buy_insurance` requires the caller-supplied `date` to
/// be day-aligned (a multiple of this) so the on-chain policy identity
/// `(flight_id, date)` matches the off-chain executor's day-level flight
/// resolution (`YYYY-MM-DD`). Without it a caller could mint many distinct
/// policies for one physical flight by varying the timestamp within a day, then
/// claim each one against the same real outcome.
pub(crate) const SECONDS_PER_DAY: u64 = 86_400;

/// Seconds per hour — converts the oracle's second-denominated arrival delta
/// into the whole hours the per-route `delay_hours` threshold is compared
/// against.
pub(crate) const SECONDS_PER_HOUR: u64 = 3_600;

// 180 days at 5s/ledger = 180 * 24 * 60 * 12 = 3_110_400.
// Sized to cover the maximum policy lifecycle (up to a 180-day claim-expiry
// window) rather than a flat 60 days, so the per-traveler "My Policies" index
// cannot archive while a referenced policy is still active or claimable. The
// off-chain TTL cron still refreshes idle entries; this is the on-write floor.
// Also governs `BuyerWhitelisted(addr)` entries — keeping
// approved buyers from silently aging out of the whitelist.
pub(crate) const TRAVELER_FLIGHTS_TTL_LEDGERS: u32 = 180 * 24 * 60 * 12;

/// Bound on the per-traveler `TravelerFlights(addr)` index. The index is a single
/// `Vec` in one persistent entry, which Soroban limits to 65,536 bytes (~1,600
/// entries). It is append-only and never pruned, so without a bound a heavy
/// trader's entry would eventually grow unwritable — and because the append is
/// on the `buy_insurance` path, that would permanently block the address from
/// buying. This index is a frontend "My Policies" convenience, NOT canonical
/// state (policy ownership lives in FlightPoolManager and every purchase emits an
/// event), so once it reaches this cap the OLDEST entry is evicted to make room
/// rather than blocking the purchase. It keeps the most recent policies on-chain;
/// older history is reconstructable from events. Well below the entry-size limit.
pub(crate) const MAX_TRAVELER_FLIGHTS: u32 = 1_000;

// Bounds on owner-tunable parameters. Owner is single-key by default
// (single-key owner), so a compromised key cannot brick the protocol by
// pushing these values to extremes.
pub(crate) const MIN_SOLVENCY_RATIO: u32 = 100; // 100% — must at least back payouts
pub(crate) const MAX_SOLVENCY_RATIO: u32 = 10_000; // 100x — practical sanity cap
pub(crate) const MIN_CLAIM_EXPIRY_WINDOW_SECS: u64 = 86_400; // 1 day — travelers need time
                                                             // Reduced from 180d → 60d. The buyer policy key
                                                             // (`PoolKey::Buyer`) is written at purchase with a fixed 180-day TTL and is
                                                             // never re-extended (the contract can't iterate buyers post-settlement, and
                                                             // 180d is Stellar's max persistent TTL — it cannot be raised). For a claim to
                                                             // always be possible the key must still exist at the claim deadline
                                                             // (flight_date + claim_window). Bounding book-ahead + claim-window below the
                                                             // buyer TTL makes that an on-chain guarantee instead of a cron dependency.
pub(crate) const MAX_CLAIM_EXPIRY_WINDOW_SECS: u64 = 5_184_000; // 60 days

// Maximum future booking horizon. `buy_insurance` previously
// enforced only a minimum lead time, so a buyer could insure a flight further
// out than the 180-day buyer-key TTL — paying premium and locking collateral
// only to find the policy key archived before settlement, making the claim
// impossible and the payoff sweepable. 90 days mirrors the documented design.
pub(crate) const MAX_BOOK_AHEAD_SECS: u64 = 7_776_000; // 90 days

/// 180 days — how long a buyer-whitelist approval stays valid without
/// activity. Enforced as an explicit on-chain deadline (`now < expires_at`)
/// checked on every gated purchase, NOT as the storage entry's TTL: an
/// archived Persistent entry is restored with its original value when next
/// accessed, so a TTL lapse cannot express "authorization expired" — only a
/// timestamp the contract compares against can. Each successful purchase
/// slides the deadline forward, so an actively-buying approved address never
/// needs re-approval; a dormant one lapses and must be re-attested.
pub(crate) const BUYER_APPROVAL_WINDOW_SECS: u64 = 15_552_000;

// Invariant: a buyer's policy proof must outlive the latest claim deadline
// its flight can ever open. Proofs are written once at purchase with the
// network-maximum TTL and never re-extended on-chain, and the binding worst
// case is NOT `settle_time + claim window` (settlement can run up to the
// pool's grace period after the flight date): it is a purchase at the
// furthest booking horizon whose flight settles late enough for the pool's
// date-anchored claim-deadline cap to bind. Both terms of that bound live in
// `sentinel_types::timeouts` — shared with the pool, so tuning the cap in
// either crate trips this assert instead of silently voiding the invariant.
//
// The bound is currently exactly tight (90d horizon + 90d cap = 180d proof)
// and, like every wall-time constant, assumes the ~5 s/ledger cadence; there
// is no slack to absorb faster ledgers, because the proof already sits at
// the network-maximum TTL. A proof that does archive is an operational cost
// (restoration before the claim executes), not a lost claim — an archived
// Persistent entry is restored with its original value, never read as
// absent.
const _: () = assert!(
    MAX_BOOK_AHEAD_SECS + sentinel_types::timeouts::MAX_CLAIM_DEADLINE_AFTER_DATE_SECS
        <= sentinel_types::timeouts::BUYER_PROOF_TTL_SECS,
    "book-ahead + claim-deadline cap must not exceed the buyer proof lifetime",
);
