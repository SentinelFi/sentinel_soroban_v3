//! Paginated active-flight set, shared by the OracleAggregator and the
//! FlightPoolManager.
//!
//! Both contracts previously kept their active flights in a single
//! instance-storage `Vec<(Symbol, u64)>`. The contract-instance ledger entry
//! is bounded to 65,536 bytes, so the vector had to be capped (1,000
//! entries) — and once either contract hit the cap, `register_flight`
//! rejected every first purchase of a new flight protocol-wide until entries
//! were settled, pruned, or manually evicted.
//!
//! This module replaces the monolithic vector with a scalable structure:
//!
//! - **Pages** (`ActivePage(n)`, persistent): `Vec<(Symbol, u64)>` chunks of
//!   at most [`ACTIVE_SET_PAGE_SIZE`] entries. Each page is its own ledger
//!   entry, so total capacity no longer competes with the rest of the
//!   contract's instance state, and readers only pay for the pages they
//!   touch.
//! - **Reverse index** (`ActiveIdx(flight_id, date)`, persistent): the
//!   entry's global slot, giving constant-time removal (no full scan).
//! - **Count** (`ActiveCount`, instance): total entries, giving an O(1)
//!   saturation gauge and the page arithmetic for appends.
//!
//! The set is unordered: removal swap-moves the globally last entry into the
//! freed slot (the same idiom the old vectors used), so consumers that
//! enumerate with rotating cursors must tolerate reordering — they already
//! do, because pruning is idempotent and re-callable.
//!
//! TTL handling: pages and index entries are persistent and therefore
//! archivable. Every write and every `get_range` read re-extends the touched
//! pages with the flat persistent scheme, so any page the keeper sweeps
//! stays alive; index entries are extended at write time to cover the flight
//! date (+ buffer), matching the per-flight data entries whose lifetime they
//! shadow. An archived page degrades availability, not integrity: reads skip
//! it (emitting [`ActivePageMissing`] so operators restore it), removals
//! fall back to a full-page scan when the index is missing, and ledger
//! restoration brings everything back.

// Module-level because `#[contracttype]` re-emits the enum without item
// attributes: the shared `Active` prefix is load-bearing — variant names ARE
// the ledger key namespace (XDR symbols), and the prefix keeps them
// collision-free against every other key in the consuming contracts.
#![allow(clippy::enum_variant_names)]

use soroban_sdk::{contractevent, contracttype, Env, Symbol, Vec};

use crate::ttl::{deadline_extension_ledgers, PERSISTENT_TTL_EXTEND, PERSISTENT_TTL_THRESHOLD};

/// Entries per page. Sized so a full page (~40 bytes/entry) stays a small
/// ledger entry while a keeper batch (25–60 entries) touches at most two
/// pages per call.
pub const ACTIVE_SET_PAGE_SIZE: u32 = 100;

/// Storage keys of the paginated set. Variant names are chosen to not
/// collide with any existing key in either consuming contract — Soroban
/// storage keys are the XDR of the value, so only the variant name and
/// payload matter, not the Rust enum they came from.
#[contracttype]
#[derive(Clone)]
pub enum ActiveSetKey {
    /// Persistent — one page of entries, at most `ACTIVE_SET_PAGE_SIZE`.
    ActivePage(u32),
    /// Persistent — the entry's global slot (page * PAGE_SIZE + position).
    ActiveIdx(Symbol, u64),
    /// Instance — total number of entries across all pages.
    ActiveCount,
}

/// A page expected to exist (its slots are below the live count) could not
/// be read — it archived past its TTL. Enumeration skipped it; operators
/// must restore the entry to bring its flights back into keeper view.
#[contractevent(topics = ["sentinel", "page_miss"], data_format = "single-value")]
pub struct ActivePageMissing {
    #[topic]
    pub page: u32,
}

/// Total number of entries in the set.
pub fn count(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&ActiveSetKey::ActiveCount)
        .unwrap_or(0)
}

fn set_count(e: &Env, n: u32) {
    e.storage().instance().set(&ActiveSetKey::ActiveCount, &n);
}

fn read_page(e: &Env, page_no: u32) -> Option<Vec<(Symbol, u64)>> {
    e.storage()
        .persistent()
        .get(&ActiveSetKey::ActivePage(page_no))
}

fn write_page(e: &Env, page_no: u32, page: &Vec<(Symbol, u64)>) {
    let key = ActiveSetKey::ActivePage(page_no);
    e.storage().persistent().set(&key, page);
    extend_page_ttl(e, page_no);
}

// Flat persistent extension: touched pages float between ~7 and ~31 days of
// TTL. The keeper's rotating scans call `get_range` every few hours, which
// re-extends every page they visit, so pages archive only if the whole
// protocol sits untouched past the flat window — the same failure envelope
// as every other persistent entry, with the same remedy (restoration).
fn extend_page_ttl(e: &Env, page_no: u32) {
    let key = ActiveSetKey::ActivePage(page_no);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

// Index entries shadow the flight's own persistent data: extend to the
// flight date (+ buffer), flooring at the flat window — the same sizing the
// oracle and pool use for the per-flight entries themselves. Equal
// threshold/target forces the extension whenever the current TTL falls
// short.
fn extend_idx_ttl(e: &Env, flight_id: &Symbol, date: u64) {
    let extend_to = deadline_extension_ledgers(e.ledger().timestamp(), date);
    let key = ActiveSetKey::ActiveIdx(flight_id.clone(), date);
    e.storage()
        .persistent()
        .extend_ttl(&key, extend_to, extend_to);
}

/// Whether `(flight_id, date)` is in the set. Exact even when the reverse
/// index archived: falls back to scanning the pages.
pub fn contains(e: &Env, flight_id: &Symbol, date: u64) -> bool {
    if e.storage()
        .persistent()
        .has(&ActiveSetKey::ActiveIdx(flight_id.clone(), date))
    {
        return true;
    }
    scan_position(e, flight_id, date).is_some()
}

// Locate an entry's global slot by scanning pages (missing pages are
// skipped). Fallback for a lost index entry; normal operation never runs it.
fn scan_position(e: &Env, flight_id: &Symbol, date: u64) -> Option<u32> {
    let n = count(e);
    if n == 0 {
        return None;
    }
    let target = (flight_id.clone(), date);
    let last_page = (n - 1) / ACTIVE_SET_PAGE_SIZE;
    for page_no in 0..=last_page {
        if let Some(page) = read_page(e, page_no) {
            for pos in 0..page.len() {
                if page.get(pos).unwrap() == target {
                    return Some(page_no * ACTIVE_SET_PAGE_SIZE + pos);
                }
            }
        }
    }
    None
}

/// Append `(flight_id, date)`. The caller is responsible for the not-
/// already-present guard (both contracts gate registration on the flight's
/// own persistent entry) and for any capacity policy.
pub fn add(e: &Env, flight_id: &Symbol, date: u64) {
    let n = count(e);
    let page_no = n / ACTIVE_SET_PAGE_SIZE;
    let mut page = read_page(e, page_no).unwrap_or(Vec::new(e));
    // The slot derives from the page's actual length so the index stays
    // correct even if the tail page lost entries to archival.
    let slot = page_no * ACTIVE_SET_PAGE_SIZE + page.len();
    page.push_back((flight_id.clone(), date));
    write_page(e, page_no, &page);

    e.storage()
        .persistent()
        .set(&ActiveSetKey::ActiveIdx(flight_id.clone(), date), &slot);
    extend_idx_ttl(e, flight_id, date);

    set_count(e, n.checked_add(1).expect("active set count overflow"));
}

/// Remove `(flight_id, date)` by swap-moving the globally last entry into
/// its slot. Returns `false` if the entry is not present (or unreachable
/// because its page archived — restore and retry).
pub fn remove(e: &Env, flight_id: &Symbol, date: u64) -> bool {
    let n = count(e);
    if n == 0 {
        return false;
    }
    let target = (flight_id.clone(), date);
    let idx_key = ActiveSetKey::ActiveIdx(flight_id.clone(), date);

    // Resolve the slot: the index is authoritative but re-validated against
    // the page contents; a stale or archived index falls back to a scan.
    let mut slot: Option<u32> = e.storage().persistent().get(&idx_key);
    if let Some(s) = slot {
        let valid = s < n
            && read_page(e, s / ACTIVE_SET_PAGE_SIZE).and_then(|p| p.get(s % ACTIVE_SET_PAGE_SIZE))
                == Some(target.clone());
        if !valid {
            slot = scan_position(e, flight_id, date);
        }
    } else {
        slot = scan_position(e, flight_id, date);
    }
    let slot = match slot {
        Some(s) => s,
        None => return false,
    };

    let page_no = slot / ACTIVE_SET_PAGE_SIZE;
    let pos = slot % ACTIVE_SET_PAGE_SIZE;
    let last = n - 1;
    let last_page_no = last / ACTIVE_SET_PAGE_SIZE;

    let mut page = match read_page(e, page_no) {
        Some(p) => p,
        None => return false,
    };

    if slot == last {
        // Removing the global tail: shrink in place.
        page.pop_back();
    } else if page_no == last_page_no {
        // Tail lives in the same page: move it into the hole locally.
        let moved = page.last().unwrap();
        page.set(pos, moved.clone());
        page.pop_back();
        e.storage()
            .persistent()
            .set(&ActiveSetKey::ActiveIdx(moved.0.clone(), moved.1), &slot);
        extend_idx_ttl(e, &moved.0, moved.1);
    } else {
        // Tail lives in a later page: pop it there, place it here.
        let mut tail_page = match read_page(e, last_page_no) {
            Some(p) => p,
            None => return false,
        };
        let moved = match tail_page.last() {
            Some(m) => m,
            None => return false,
        };
        tail_page.pop_back();
        page.set(pos, moved.clone());
        if tail_page.is_empty() {
            e.storage()
                .persistent()
                .remove(&ActiveSetKey::ActivePage(last_page_no));
        } else {
            write_page(e, last_page_no, &tail_page);
        }
        e.storage()
            .persistent()
            .set(&ActiveSetKey::ActiveIdx(moved.0.clone(), moved.1), &slot);
        extend_idx_ttl(e, &moved.0, moved.1);
    }

    if page.is_empty() {
        e.storage()
            .persistent()
            .remove(&ActiveSetKey::ActivePage(page_no));
    } else {
        write_page(e, page_no, &page);
    }
    e.storage().persistent().remove(&idx_key);
    set_count(e, n - 1);
    true
}

/// Up to `limit` entries starting at global slot `offset`. The bounded,
/// footprint-cheap enumeration the keeper scans use: a batch touches at most
/// `limit / ACTIVE_SET_PAGE_SIZE + 1` page entries. Visited pages get their
/// TTL re-extended; an archived page is skipped after emitting
/// [`ActivePageMissing`] (its flights come back on restoration).
pub fn get_range(e: &Env, offset: u32, limit: u32) -> Vec<(Symbol, u64)> {
    let n = count(e);
    let mut out: Vec<(Symbol, u64)> = Vec::new(e);
    if offset >= n || limit == 0 {
        return out;
    }
    let stop = offset.saturating_add(limit).min(n);
    let mut i = offset;
    while i < stop {
        let page_no = i / ACTIVE_SET_PAGE_SIZE;
        match read_page(e, page_no) {
            None => {
                ActivePageMissing { page: page_no }.publish(e);
                i = (page_no + 1) * ACTIVE_SET_PAGE_SIZE;
            }
            Some(page) => {
                extend_page_ttl(e, page_no);
                let mut pos = i % ACTIVE_SET_PAGE_SIZE;
                while pos < page.len() && i < stop {
                    out.push_back(page.get(pos).unwrap());
                    pos += 1;
                    i += 1;
                }
                if pos >= page.len() {
                    // Short or exhausted page: continue at the next boundary.
                    i = (page_no + 1) * ACTIVE_SET_PAGE_SIZE;
                }
            }
        }
    }
    out
}

/// Every entry in the set. Footprint grows with the page count — off-chain /
/// simulation convenience; bounded on-chain callers use [`get_range`].
pub fn get_all(e: &Env) -> Vec<(Symbol, u64)> {
    get_range(e, 0, count(e))
}
