use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env, Symbol};
use stellar_macros::when_not_paused;

use crate::constants::{MAX_BOOK_AHEAD_SECS, SECONDS_PER_DAY};
use crate::events::InsuranceBought;
use crate::interfaces::{
    FlightPoolManagerClient, FlightStatus, GovClient, OracleClient, ResolvedTerms, RouteStatus,
    VaultClient,
};
use crate::storage::{
    append_traveler_flight, read_buyer_whitelisted, read_whitelist_enabled,
    touch_buyer_whitelisted, CtrlKey,
};
use crate::{Controller, ControllerArgs, ControllerClient, Error};

#[contractimpl]
impl Controller {
    /// Buys flight-delay insurance for a traveler: validates the route and timing, checks solvency, collects the premium, locks collateral, and records the policy.
    #[when_not_paused]
    pub fn buy_insurance(
        e: &Env,
        traveler: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
        date: u64,
    ) {
        traveler.require_auth();

        // 0a. Require a day-aligned `date` (midnight UTC). The off-chain
        //     executor resolves flights at calendar-day granularity
        //     (`YYYY-MM-DD`), so the on-chain identity `(flight_id, date)` must
        //     too — otherwise one physical flight maps to many on-chain policies
        //     (one per distinct intraday timestamp), each independently
        //     claimable against the same real outcome, draining the vault.
        //     Combined with the per-traveler single-policy guard
        //     in `add_buyer`, this caps a traveler at one policy per physical
        //     (flight_id, day).
        if !date.is_multiple_of(SECONDS_PER_DAY) {
            panic_with_error!(e, Error::DateNotDayAligned);
        }

        // 0. Phase 11 buyer-whitelist gate. Default-off (open buy_insurance);
        //    when the owner has flipped the toggle, only addresses an admin
        //    has explicitly added via add_whitelisted_buyer pass. One Instance
        //    read on the hot path when off, plus a Persistent read when on.
        if read_whitelist_enabled(e) {
            if !read_buyer_whitelisted(e, &traveler) {
                panic_with_error!(e, Error::BuyerNotWhitelisted);
            }
            // Keep an active buyer's approval from aging out.
            touch_buyer_whitelisted(e, &traveler);
        }

        let gov_addr: Address = e.storage().instance().get(&CtrlKey::Governance).unwrap();
        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let pool_addr: Address = e
            .storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap();
        let asset_addr: Address = e.storage().instance().get(&CtrlKey::AssetToken).unwrap();
        let controller_addr = e.current_contract_address();

        // 1+2. Validate route + read terms in one cross-contract call.
        let gov = GovClient::new(e, &gov_addr);
        let terms = match gov.route_status(&flight_id, &origin, &dest) {
            RouteStatus::Active(t) => t,
            RouteStatus::Disabled => panic_with_error!(e, Error::RouteDisabled),
            RouteStatus::Unknown => panic_with_error!(e, Error::RouteNotWhitelisted),
        };

        // 3. Enforce minimum lead time.
        let now = e.ledger().timestamp();
        let min_lead: u64 = e.storage().instance().get(&CtrlKey::MinLeadTime).unwrap();
        let earliest_allowed = now.checked_add(min_lead).expect("addition overflow");
        if date <= earliest_allowed {
            panic_with_error!(e, Error::DepartureTooSoon);
        }

        // 3b. Enforce a maximum booking horizon so the policy
        //     lifecycle (departure + claim window) provably fits inside the
        //     180-day buyer-key TTL. Without this a far-future purchase could
        //     have its policy key archive before settlement, stranding the
        //     premium and making the claim impossible.
        let latest_allowed = now
            .checked_add(MAX_BOOK_AHEAD_SECS)
            .expect("addition overflow");
        if date > latest_allowed {
            panic_with_error!(e, Error::DepartureTooFarInFuture);
        }

        // 3c. Reject purchases once the oracle has already
        //     observed an outcome for this flight. `oracle.register_flight` is
        //     idempotent and returns silently on an existing row, and
        //     `add_buyer` only checks the pool's own status — so without this
        //     gate a buyer could purchase AFTER the oracle marked the flight
        //     Cancelled/Landed but BEFORE the keeper settled, then claim a
        //     guaranteed payoff and drain the vault. Only NotInitiated (no
        //     data / not yet registered) and Active (in-flight, pre-outcome)
        //     are open for purchase.
        let oracle = OracleClient::new(e, &oracle_addr);
        let oracle_status = oracle.get_flight_data(&flight_id, &date).status;
        if !matches!(
            oracle_status,
            FlightStatus::NotInitiated | FlightStatus::Active
        ) {
            panic_with_error!(e, Error::FlightNotOpenForPurchase);
        }

        // 3d. Require a fresh, affirmative sale authorization from the
        //     oracle. Gate 3c only proves no outcome is recorded ON-CHAIN;
        //     it cannot distinguish a genuinely operating flight from one
        //     whose public cancellation has not yet reached the oracle
        //     contract — a missing row and a stale Active row both pass it,
        //     and during that interval every accepted policy is a
        //     deterministic payoff-minus-premium claim against the vault,
        //     repeatable across buyer addresses. Insurability is therefore
        //     attested, not inferred: the oracle opens a short-lived sale
        //     window after verifying the flight off-chain, refreshes it
        //     while the flight stays valid, and closes it (or lets it lapse)
        //     otherwise. No live authorization — including one that merely
        //     expired — means no sale.
        if !oracle.is_sale_open(&flight_id, &date) {
            panic_with_error!(e, Error::SaleNotOpen);
        }

        // 3e. Bind this purchase to the terms snapshotted by the FIRST buyer of
        //     this (flight_id, date), if it is already registered. The pool
        //     locks terms at registration and rejects a mismatched
        //     re-registration, so pricing later buyers off the CURRENT route
        //     terms would brick further sales for this date the moment
        //     governance updates the route or the global defaults. Term
        //     changes therefore apply only to flight dates not yet registered;
        //     every buyer of one physical flight transacts at identical terms.
        let pool = FlightPoolManagerClient::new(e, &pool_addr);
        let terms = match pool.get_flight_config(&flight_id, &date) {
            Some(cfg) => {
                // A registered bucket must have a live oracle row — the two
                // are created together at first purchase. If the pool config
                // exists but the oracle row is physically absent, the
                // flight's status (possibly an already-public outcome) is
                // unobservable and the NotInitiated fallback in gate 3c is
                // meaningless. Refuse the purchase until the row is restored;
                // selling into a bucket whose outcome may already be known
                // would hand the buyer a guaranteed claim.
                if !oracle.has_flight_data(&flight_id, &date) {
                    panic_with_error!(e, Error::OracleDataUnavailable);
                }
                let snapshot = ResolvedTerms {
                    premium: cfg.premium,
                    payoff: cfg.payoff,
                    delay_hours: cfg.delay_hours,
                };
                // The route check above validated the route's CURRENT terms,
                // but the terms actually charged and locked from here on are
                // this snapshot — taken when the bucket was first registered,
                // possibly under limits governance has since lowered. New
                // exposure must satisfy the limits in force NOW, so the
                // snapshot is re-validated before any value moves; otherwise
                // a pre-existing oversized bucket would keep admitting buyers
                // at terms the owner can no longer whitelist. Buyers already
                // in the bucket are untouched — their settlement still uses
                // the snapshot.
                if !gov.terms_valid(&snapshot) {
                    panic_with_error!(e, Error::SnapshotTermsExceedLimits);
                }
                snapshot
            }
            None => terms,
        };

        // 4. Register flight on the pool + oracle. Both calls are idempotent:
        //    no precheck needed, no revert if a parallel buyer
        //    in the same ledger registered first.
        pool.register_flight(
            &controller_addr,
            &flight_id,
            &date,
            &terms.premium,
            &terms.payoff,
            &terms.delay_hours,
        );
        oracle.register_flight(&controller_addr, &flight_id, &date);

        // 5. Solvency check — enforced on AGGREGATE liabilities, not just the
        //    new payoff. The old check compared the new payoff
        //    alone against free capital, so with a ratio above 100% the margin
        //    eroded toward 100% as policies accumulated (each new buy only had
        //    to clear free capital, which already netted out prior locks). We
        //    now require total managed assets to cover the configured ratio
        //    applied to (existing locked + this payoff), holding the reserve
        //    margin across the whole book.
        let vault = VaultClient::new(e, &vault_addr);
        let tma = vault.get_total_managed_assets();
        let locked = vault.get_locked_capital();
        let solvency_ratio: u32 = e.storage().instance().get(&CtrlKey::SolvencyRatio).unwrap();
        let new_locked = locked.checked_add(terms.payoff).expect("addition overflow");
        // ceil(new_locked * ratio / 100) — the same shared formula the
        // vault's withdrawable-capital bound uses, so the reserve this
        // admission verifies is exactly the reserve exits are held back from.
        let required = sentinel_types::solvency::required_reserve(new_locked, solvency_ratio);
        if tma < required {
            panic_with_error!(e, Error::InsufficientVaultCapital);
        }

        // 6. Transfer premium directly from traveler to FlightPoolManager.
        //    Soroban auth propagates: the traveler signed buy_insurance, so
        //    this sub-invocation transfer is authorized.
        let asset = token::Client::new(e, &asset_addr);
        asset.transfer(&traveler, &pool_addr, &terms.premium);

        // 7. Lock collateral in vault.
        vault.increase_locked(&controller_addr, &terms.payoff);

        // 8. Record buyer in FlightPoolManager. This also enforces
        //    single-purchase-per-policy: add_buyer keys the buyer on
        //    (flight_id, date, traveler) and panics with Error::AlreadyBuyer
        //    if this traveler already holds a policy for the same flight+date.
        //    A duplicate buy_insurance with identical parameters therefore
        //    reverts here, and atomicity rolls back the premium transfer (6)
        //    and the collateral lock (7) — no double charge, no double lock.
        pool.add_buyer(&controller_addr, &flight_id, &date, &traveler);

        // 9. Append to per-traveler index (unblocks MyPolicies frontend).
        append_traveler_flight(e, &traveler, &flight_id, date);

        // 10. Update aggregate counters.
        let sold: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPoliciesSold)
            .unwrap_or(0);
        e.storage().instance().set(
            &CtrlKey::TotalPoliciesSold,
            &sold.checked_add(1).expect("addition overflow"),
        );

        let collected: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPremiumsCollected)
            .unwrap_or(0);
        e.storage().instance().set(
            &CtrlKey::TotalPremiumsCollected,
            &collected
                .checked_add(terms.premium)
                .expect("addition overflow"),
        );

        Controller::extend_ttl(e);

        InsuranceBought {
            traveler,
            flight_id,
            date,
            premium: terms.premium,
        }
        .publish(e);
    }
}
