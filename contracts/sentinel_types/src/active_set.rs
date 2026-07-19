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
//! fall back to a full-page scan when the index is missing, appends verify
//! absence with the same scan while the set is small enough for that to be
//! affordable (see [`ACTIVE_SET_ADD_SCAN_MAX`]), appends that would land on
//! an archived tail page are rejected rather than overwrite it, and ledger
//! restoration brings everything back.

// Module-level because `#[contracttype]` re-emits the enum without item
// attributes: the shared `Active` prefix is load-bearing — variant names ARE
// the ledger key namespace (XDR symbols), and the prefix keeps them
// collision-free against every other key in the consuming contracts.
#![allow(clippy::enum_variant_names)]

use soroban_sdk::{contractevent, contracttype, Env, Symbol, Vec};

use crate::ttl::{deadline_extension_ledgers, PERSISTENT_TTL_EXTEND, PERSISTENT_TTL_THRESHOLD};

/// Operational sanity cap on the total number of entries in the set, shared
/// by BOTH consumers (OracleAggregator, FlightPoolManager) so the two caps
/// can never drift. It is no longer a storage-entry limit — the paginated
/// layout removed the old 1,000-flight ceiling the single-vector list imposed
/// — but a guard against unbounded growth (runaway registration, stalled
/// pruning), set far above any plausible concurrent flight volume. Lives here,
/// next to the structure it bounds, because both contracts compare it against
/// this module's `count()`: a divergent copy on either side would let one
/// contract reject a registration the other still accepts, silently breaking
/// the pool⇔oracle first-buy registration invariant.
pub const MAX_ACTIVE_FLIGHTS: u32 = 100_000;

/// Entries per page. Sized so a full page (~40 bytes/entry) stays a small
/// ledger entry while a keeper batch (25–60 entries) touches at most two
/// pages per call.
pub const ACTIVE_SET_PAGE_SIZE: u32 = 100;

/// Largest set size for which [`add`] verifies absence with a page scan when
/// the reverse index is missing. The scan must be bounded: a legitimately new
/// entry never has an index entry, so the fallback runs on EVERY append — an
/// unbounded scan would grow with the set and eventually push the first
/// purchase of each new flight past the transaction footprint limits,
/// re-creating the protocol-wide registration freeze the paginated layout
/// exists to prevent. Ten page reads is cheap next to the entries a purchase
/// already touches, and it covers the realistic steady-state set size many
/// times over; beyond it, the caller-side registration gates and the
/// deadline-sized index TTLs (which outlive any still-registrable flight
/// date) remain the protection, exactly as before.
pub const ACTIVE_SET_ADD_SCAN_MAX: u32 = 1_000;

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
//
// Deliberately UNBOUNDED, unlike `add`'s absence check (capped by
// ACTIVE_SET_ADD_SCAN_MAX). `add` can safely give up early — a false "absent"
// only risks a duplicate, which its index `has()` guard still catches — but
// `remove`/`contains` must be EXACT: capping this scan could report a
// genuinely-present entry as absent, stranding it in the set (remove no-ops)
// or misreporting membership. The scan only runs when the reverse index has
// archived, which the deadline-sized index TTLs prevent for any still-live
// flight; if it ever does run on a very large set its cost is bounded by the
// page count, and the caller (settlement / reconciliation) is not on the
// latency-critical purchase path.
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
///
/// Panics if the tail page is archived: appending would have to overwrite
/// the archived key, permanently shadowing its entries. Restore the page
/// first (registration is blocked until then).
pub fn add(e: &Env, flight_id: &Symbol, date: u64) {
    // Backstop for the caller-side guard: a duplicate would occupy two
    // slots under one index entry, silently corrupting the count and the
    // swap-remove bookkeeping. One cheap read on this path.
    if e.storage()
        .persistent()
        .has(&ActiveSetKey::ActiveIdx(flight_id.clone(), date))
    {
        panic!("entry already in active set");
    }

    let n = count(e);
    // The index alone cannot prove absence: it can archive while the page
    // holding the entry stays live (pages are re-extended by every keeper
    // sweep; index lifetimes are sized to the flight date). While the set is
    // small enough that exactness costs only a few page reads, fall back to
    // the same page scan `contains` and `remove` use, so an entry stranded
    // without its index cannot be appended a second time. Failing closed
    // (rather than healing the index and returning) is deliberate: reaching
    // here means the caller believed the flight was NEW while the set says
    // it is present — inconsistent state that operators should restore, not
    // state to silently sell policies against. See
    // ACTIVE_SET_ADD_SCAN_MAX for why the scan must not be unconditional.
    if n <= ACTIVE_SET_ADD_SCAN_MAX && scan_position(e, flight_id, date).is_some() {
        panic!("entry already in active set");
    }

    let page_no = n / ACTIVE_SET_PAGE_SIZE;
    // Fail closed like the readers: when the count says the tail page holds
    // live entries, a `None` read means the page archived past its TTL, and
    // writing a fresh vector over that key would make its entries permanently
    // unenumerable AND unrestorable (restoration needs the key to be dead).
    // A missing page is legitimate only at a page boundary, where the next
    // page genuinely starts empty.
    let mut page = match read_page(e, page_no) {
        Some(p) => p,
        None if n.is_multiple_of(ACTIVE_SET_PAGE_SIZE) => Vec::new(e),
        None => panic!("active-set tail page archived; restore it before adding"),
    };
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
/// `ceil(limit / ACTIVE_SET_PAGE_SIZE) + 1` page entries (the `+ 1` covers a
/// range that starts mid-page). Visited pages get their
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
