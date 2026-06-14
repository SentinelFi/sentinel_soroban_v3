use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

#[contracttype]
pub enum CtrlKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Governance,
    RiskVault,
    Oracle,
    FlightPoolManager,
    AssetToken,
    AuthorizedKeeper,
    SolvencyRatio,
    MinLeadTime,
    ClaimExpiryWindow,
    TotalPoliciesSold,
    TotalPremiumsCollected,
    TotalPayoutsDistributed,
    WhitelistEnabled, // bool — Phase 11 buyer whitelist kill-switch
    ClassifyCursor,   // u32 — rotating index into the oracle active list
    SettleCursor,     // u32 — rotating index into the oracle active list

    // Persistent — keyed multi-row state
    TravelerFlights(Address),  // Vec<(Symbol, u64)>
    BuyerWhitelisted(Address), // bool — Phase 11 buyer whitelist entry
}

/// Maximum flights processed per `classify_flights` /
/// `execute_settlements` call. Each call scans a bounded window of the oracle
/// active list starting at a persisted rotating cursor, so per-call resource
/// cost stays bounded no matter how large the list grows. Both passes are
/// idempotent on already-handled flights (a settled/classified entry is a
/// no-op on re-scan), so rotating across calls guarantees full coverage. Set
/// high enough that normal volumes are fully processed in a single call.
pub(crate) const MAX_SETTLE_BATCH: u32 = 100;

// 180 days at 5s/ledger = 180 * 24 * 60 * 12 = 3_110_400.
// Sized to cover the maximum policy lifecycle (up to a 180-day claim-expiry
// window) rather than a flat 60 days, so the per-traveler "My Policies" index
// cannot archive while a referenced policy is still active or claimable. The
// off-chain TTL cron still refreshes idle entries; this is the on-write floor.
// Also governs `BuyerWhitelisted(addr)` entries — keeping
// approved buyers from silently aging out of the whitelist.
pub(crate) const TRAVELER_FLIGHTS_TTL_LEDGERS: u32 = 180 * 24 * 60 * 12;

// Bounds on owner-tunable parameters. Owner is single-key by default
// (single-key owner), so a compromised key cannot brick the protocol by
// pushing these values to extremes.
pub(crate) const MIN_SOLVENCY_RATIO: u32 = 100; // 100% — must at least back payouts
pub(crate) const MAX_SOLVENCY_RATIO: u32 = 10_000; // 100x — practical sanity cap
pub(crate) const MAX_MIN_LEAD_TIME_SECS: u64 = 7_776_000; // 90 days
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

// Buyer policy key TTL expressed in seconds: BUYER_TTL_LEDGERS (3_110_400) at
// ~5 s/ledger = 15_552_000 s = 180 days (also Stellar's max persistent TTL).
// Mirrored here (the constant lives in flight_pool_manager) to assert the
// lifecycle invariant below at compile time.
const BUYER_KEY_TTL_SECS: u64 = 15_552_000;

// Invariant: a policy bought at the furthest allowed horizon whose
// flight then settles into the longest allowed claim window must still have a
// live buyer key at the claim deadline. Guaranteed iff
// MAX_BOOK_AHEAD + MAX_CLAIM_EXPIRY <= buyer key TTL. Enforced at compile time
// so future tuning of any bound can't silently reintroduce the hazard.
const _: () = assert!(
    MAX_BOOK_AHEAD_SECS + MAX_CLAIM_EXPIRY_WINDOW_SECS <= BUYER_KEY_TTL_SECS,
    "book-ahead + claim window must not exceed the buyer key TTL",
);

pub(crate) fn append_traveler_flight(e: &Env, traveler: &Address, flight_id: &Symbol, date: u64) {
    let key = CtrlKey::TravelerFlights(traveler.clone());
    let mut list: Vec<(Symbol, u64)> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
    list.push_back((flight_id.clone(), date));
    e.storage().persistent().set(&key, &list);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}

pub(crate) fn write_buyer_whitelisted(e: &Env, addr: &Address, allowed: bool) {
    let key = CtrlKey::BuyerWhitelisted(addr.clone());
    e.storage().persistent().set(&key, &allowed);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}

pub(crate) fn read_buyer_whitelisted(e: &Env, addr: &Address) -> bool {
    e.storage()
        .persistent()
        .get(&CtrlKey::BuyerWhitelisted(addr.clone()))
        .unwrap_or(false)
}

/// Refresh an existing whitelist entry's TTL. Called from the
/// buy_insurance gate so an actively-buying approved address keeps its approval
/// alive on its own (the bare read in `read_buyer_whitelisted` cannot, and a
/// frequent buyer should never have to be re-approved). No-op if the entry is
/// absent.
pub(crate) fn touch_buyer_whitelisted(e: &Env, addr: &Address) {
    let key = CtrlKey::BuyerWhitelisted(addr.clone());
    if e.storage().persistent().has(&key) {
        e.storage().persistent().extend_ttl(
            &key,
            TRAVELER_FLIGHTS_TTL_LEDGERS,
            TRAVELER_FLIGHTS_TTL_LEDGERS,
        );
    }
}

pub(crate) fn read_whitelist_enabled(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&CtrlKey::WhitelistEnabled)
        .unwrap_or(false)
}
