use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

use crate::constants::{MAX_TRAVELER_FLIGHTS, TRAVELER_FLIGHTS_TTL_LEDGERS};

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
    // i128 — gross claimable value opened by delayed/cancelled settlements:
    // payoff × buyer_count per flight. This includes the premium portion the
    // pool already held, so it is NOT the vault's outflow (that is
    // (payoff − premium) × buyer_count) nor the amount travelers actually
    // collected (unclaimed payoffs expire to RecoveredBalance).
    TotalPayoutsDistributed,
    WhitelistEnabled, // bool — Phase 11 buyer whitelist kill-switch
    ClassifyCursor,   // u32 — rotating index into the oracle active list
    SettleCursor,     // u32 — rotating index into the oracle active list

    // Persistent — keyed multi-row state
    TravelerFlights(Address), // Vec<(Symbol, u64)>
    // Retired — was the whitelist flag as a bare bool whose storage TTL was
    // treated as the approval lifetime. That model cannot work: an archived
    // Persistent entry is restored with its original value on next access,
    // never read as absent, so a dormant `true` could not lapse. Replaced by
    // BuyerApprovalExpiry; legacy entries are deliberately ignored (their
    // holders re-attest once). Do not reuse.
    BuyerWhitelisted(Address), // bool — retired
    // u64 unix seconds — the buyer is approved while `now < expires_at`.
    // The deadline is contract-checked state, so it holds regardless of
    // whether the entry stayed live or was archived and restored.
    BuyerApprovalExpiry(Address),
}

pub(crate) fn append_traveler_flight(e: &Env, traveler: &Address, flight_id: &Symbol, date: u64) {
    let key = CtrlKey::TravelerFlights(traveler.clone());
    let mut list: Vec<(Symbol, u64)> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
    // Bound the append-only index so it can't grow into the persistent
    // entry-size limit and, since the append is on the buy path, permanently
    // block the address from purchasing. When full, evict the oldest entry
    // (keep the most recent MAX_TRAVELER_FLIGHTS) instead of blocking the buy —
    // this is a convenience index, and full history is derivable from events.
    // `remove(0)` (not swap-remove) because chronological order is the point
    // of the index; the shift is one host call whose cost is dwarfed by
    // reading/writing the whole entry, which this function does regardless.
    if list.len() >= MAX_TRAVELER_FLIGHTS {
        list.remove(0);
    }
    list.push_back((flight_id.clone(), date));
    e.storage().persistent().set(&key, &list);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}

// Write an approval (or a revocation: expires_at = 0). The authorization
// lifetime is the stored deadline, checked at read time — the entry's TTL is
// only an availability concern, because an archived Persistent entry comes
// back with its original value on next access instead of reading as absent.
// A revocation overwrites rather than deletes so a re-add later still
// refreshes a known key (keeps the Persistent footprint stable for the
// off-chain TTL cron), and so a restored entry can never resurrect a
// revoked approval.
pub(crate) fn write_buyer_whitelisted(e: &Env, addr: &Address, allowed: bool) {
    use crate::constants::BUYER_APPROVAL_WINDOW_SECS;
    let key = CtrlKey::BuyerApprovalExpiry(addr.clone());
    let expires_at: u64 = if allowed {
        e.ledger()
            .timestamp()
            .checked_add(BUYER_APPROVAL_WINDOW_SECS)
            .expect("addition overflow")
    } else {
        0
    };
    e.storage().persistent().set(&key, &expires_at);
    e.storage().persistent().extend_ttl(
        &key,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
        TRAVELER_FLIGHTS_TTL_LEDGERS,
    );
}

pub(crate) fn read_buyer_whitelisted(e: &Env, addr: &Address) -> bool {
    let expires_at: u64 = e
        .storage()
        .persistent()
        .get(&CtrlKey::BuyerApprovalExpiry(addr.clone()))
        .unwrap_or(0);
    e.ledger().timestamp() < expires_at
}

/// Slide an approved buyer's deadline forward. Called from the buy_insurance
/// gate after the approval check passed, so an actively-buying address keeps
/// its approval alive on its own — only a buyer dormant for the full window
/// lapses and must be re-attested. Rewrites the deadline (not just the TTL:
/// the deadline is what expiry is judged by) and keeps the entry's storage
/// TTL covering it. No-op if the entry is absent.
pub(crate) fn touch_buyer_whitelisted(e: &Env, addr: &Address) {
    use crate::constants::BUYER_APPROVAL_WINDOW_SECS;
    let key = CtrlKey::BuyerApprovalExpiry(addr.clone());
    let now = e.ledger().timestamp();
    let current: u64 = e.storage().persistent().get(&key).unwrap_or(0);
    // Only a still-valid approval may renew itself — sliding an expired or
    // revoked deadline forward would turn this maintenance write into a
    // re-approval no admin signed.
    if now < current {
        let expires_at = now
            .checked_add(BUYER_APPROVAL_WINDOW_SECS)
            .expect("addition overflow");
        e.storage().persistent().set(&key, &expires_at);
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
