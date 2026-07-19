// Controller-only capital management: lock/unlock collateral, record premium
// income, send payouts, drain the withdrawal queue into ClaimableBalance.

use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env, Vec};
use stellar_contract_utils::math::Rounding;
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::auth::{require_controller, settlement_pending};
use crate::constants::{
    CLAIMABLE_TTL_LEDGERS, LP_PRICING_DELAY_SECS, MAX_QUEUE_BATCH, MAX_SOLVENCY_RATIO,
    MIN_SOLVENCY_RATIO,
};
use crate::events::{
    Credited, DepositDropped, DepositProcessed, RequestDropped, RequestPartiallyFilled,
    SolvencyRatioSet,
};
use crate::storage::{sum_escrowed_deposits, DepositRequest, VaultKey};
use crate::vault_ops::{convert_to_assets_with_tma, convert_to_shares_with_tma};
use crate::{Error, RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    /// Controller-only: lock additional capital as collateral.
    #[when_not_paused]
    pub fn increase_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let locked = Self::get_locked_capital(e);
        let tma = Self::get_total_managed_assets(e);
        let new_locked = locked.checked_add(amount).expect("addition overflow");
        if new_locked > tma {
            panic_with_error!(e, Error::WouldExceedTotalManagedAssets);
        }
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &new_locked);
    }

    /// Controller-only: release previously locked collateral capital.
    #[when_not_paused]
    pub fn decrease_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let locked = Self::get_locked_capital(e);
        if amount > locked {
            panic_with_error!(e, Error::WouldGoNegative);
        }
        e.storage().instance().set(
            &VaultKey::LockedCapital,
            &locked.checked_sub(amount).expect("subtraction underflow"),
        );
    }

    /// Controller-only: mirror the owner-configured solvency ratio into the
    /// vault so exit paths can hold back the same reserve the controller
    /// admits new policies against. The controller pushes on every owner
    /// update; the vault cannot pull the value itself because the controller
    /// invokes `process_withdrawal_queue` and a read-back during that call
    /// would be reentrant. Deliberately NOT pause-gated: propagating a risk
    /// parameter is exactly the kind of action an incident response performs
    /// while the vault is paused.
    pub fn set_solvency_ratio(e: &Env, controller: Address, ratio: u32) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        // Same bounds the controller enforces on its owner setter, so a
        // compromised or buggy caller cannot park an unpayable reserve here.
        if !(MIN_SOLVENCY_RATIO..=MAX_SOLVENCY_RATIO).contains(&ratio) {
            panic_with_error!(e, Error::SolvencyRatioOutOfBounds);
        }
        e.storage().instance().set(&VaultKey::SolvencyRatio, &ratio);
        SolvencyRatioSet { ratio }.publish(e);
    }

    /// Controller-only: credit received premium income to managed assets.
    #[when_not_paused]
    pub fn record_premium_income(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let old_tma = Self::get_total_managed_assets(e);
        let new_tma = old_tma.checked_add(amount).expect("addition overflow");

        // Defensive: the pool transfers asset to the vault BEFORE calling this.
        // Reject the credit if the vault's BACKING balance can't cover the new
        // TMA — catches the "controller called us but no asset arrived" path
        // (compromised or buggy caller). Escrowed deposit-queue assets sit in
        // the raw balance without backing any shares yet, so they are
        // subtracted first: otherwise a full deposit queue would mask a missing
        // premium transfer and let TMA outrun real backing while the check
        // still passed. Outstanding ClaimableBalance entries are decremented
        // from TMA at credit time and are not enumerable on-chain, so they
        // remain an owed-to-users residual this floor cannot exclude — the
        // guard is a floor on managed assets, tightest against the enumerable
        // (deposit-escrow) liability.
        let asset = token::Client::new(e, &Vault::query_asset(e));
        let balance = asset.balance(&e.current_contract_address());
        let backing = balance
            .checked_sub(sum_escrowed_deposits(e))
            .expect("subtraction overflow");
        if backing < new_tma {
            panic_with_error!(e, Error::PremiumNotReceived);
        }

        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &new_tma);
    }

    /// Controller-only: transfer a claim payout from managed assets to a recipient.
    #[when_not_paused]
    pub fn send_payout(e: &Env, controller: Address, to: Address, amount: i128) {
        require_controller(e, &controller);
        Self::extend_ttl(e);
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        let tma = Self::get_total_managed_assets(e);
        if amount > tma {
            panic_with_error!(e, Error::InsufficientManagedAssets);
        }

        // Decrement TMA before the external transfer.
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(amount).expect("subtraction underflow"),
        );

        let asset = token::Client::new(e, &Vault::query_asset(e));
        asset.transfer(&e.current_contract_address(), &to, &amount);
    }

    /// Controller-only: drain queued withdrawals into claimable balances (batched, FIFO).
    #[when_not_paused]
    pub fn process_withdrawal_queue(e: &Env, controller: Address) {
        require_controller(e, &controller);
        Self::extend_ttl(e);

        // Do not price queued exits while a public flight outcome is unsettled —
        // that would hand the exiting LP the pre-settlement (stale) share price
        // and shift the pending loss to the remaining LPs. The keeper drains the
        // queue after settlement, when the vault's PnL is recognized; until then
        // this is a no-op and the requests stay queued.
        if settlement_pending(e) {
            return;
        }

        let queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        if queue.is_empty() {
            return;
        }

        // Fund queued exits only from capital above the configured solvency
        // reserve — the same required-backing bound the controller admits
        // policies against. Paying out to the nominal margin instead would
        // let the queue drain the reserve that the purchase path just
        // verified.
        let mut remaining_free = Self::get_withdrawable_capital(e);
        let mut processed: u32 = 0;
        let mut tma = Self::get_total_managed_assets(e);
        let vault_addr = e.current_contract_address();

        // Examine at most MAX_QUEUE_BATCH entries per call.
        // Entries beyond the window are carried over untouched and drained on a
        // later call. `kept` accumulates everything that survives this pass
        // (skipped or deferred) so removals don't have to be a contiguous head
        // prefix; the out-of-window tail is appended in one bulk copy after
        // the loop.
        let limit = queue.len().min(MAX_QUEUE_BATCH);
        let mut kept: Vec<WithdrawalRequest> = Vec::new(e);
        let now = e.ledger().timestamp();
        let mut hit_capacity = false;
        let mut returned_any = false;
        let mut partially_filled = false;

        for i in 0..limit {
            let request = queue.get(i).unwrap();

            // We already hit a request we can't fund: preserve FIFO liquidity
            // ordering by keeping this and all later requests for a future
            // call.
            if hit_capacity {
                kept.push_back(request);
                continue;
            }

            // Pricing-delay gate: a request may only be priced once it has
            // outlived the LP pricing delay, so the price it receives already
            // reflects every outcome publicly knowable when it was committed
            // (see LP_PRICING_DELAY_SECS). The queue is chronological — later
            // requests are younger — so an immature head defers everything
            // behind it, exactly like the capacity stop. A partial-fill
            // remainder keeps its original requested_at: maturity, once
            // reached, is permanent.
            let mature_at = request
                .requested_at
                .checked_add(LP_PRICING_DELAY_SECS)
                .expect("addition overflow");
            if now < mature_at {
                kept.push_back(request);
                hit_capacity = true;
                continue;
            }

            // Price against the running TMA so every request in this pass
            // sees a (total_assets, total_supply) pair decremented in
            // lockstep — burns update the live share supply, and the local
            // `tma` mirrors the assets credited so far. Otherwise share
            // price would drift upward across the loop and later-in-queue
            // requests would get more assets per share than earlier ones.
            let assets = convert_to_assets_with_tma(e, request.shares, tma, Rounding::Floor);

            if assets > remaining_free {
                // The head-most request exceeds free capital. Fund the part
                // free capital covers NOW (burn that share slice, credit its
                // asset value) and keep the remainder at the head. Without the
                // partial fill, one oversized request would pin the queue —
                // and, since the queue is the only exit path, freeze every
                // underwriter exit — until enough
                // collateral unlocked to cover it in full, even while free
                // capital sat idle. With it, the queue makes progress whenever
                // any free capital exists, and strict FIFO fairness holds:
                // free capital always goes to the oldest request first, so no
                // later request ever executes ahead of an earlier one.
                let fillable_shares =
                    convert_to_shares_with_tma(e, remaining_free, tma, Rounding::Floor);
                // Floor-floor round trip: assets_part <= remaining_free, and
                // fillable_shares < request.shares whenever the full request
                // exceeds free capital, so the remainder is always >= 1 share.
                let assets_part =
                    convert_to_assets_with_tma(e, fillable_shares, tma, Rounding::Floor);
                if fillable_shares > 0 && assets_part > 0 {
                    Base::update(e, Some(&vault_addr), None, fillable_shares);

                    let owner = request.owner.clone();
                    let key = VaultKey::ClaimableBalance(owner.clone());
                    let claimable: i128 = e.storage().persistent().get(&key).unwrap_or(0);
                    let new_balance = claimable
                        .checked_add(assets_part)
                        .expect("addition overflow");
                    e.storage().persistent().set(&key, &new_balance);
                    e.storage().persistent().extend_ttl(
                        &key,
                        CLAIMABLE_TTL_LEDGERS,
                        CLAIMABLE_TTL_LEDGERS,
                    );

                    let shares_remaining = request
                        .shares
                        .checked_sub(fillable_shares)
                        .expect("subtraction underflow");
                    Credited {
                        user: owner.clone(),
                        amount: assets_part,
                        new_balance,
                    }
                    .publish(e);
                    RequestPartiallyFilled {
                        owner,
                        request_id: request.request_id,
                        shares_filled: fillable_shares,
                        shares_remaining,
                    }
                    .publish(e);

                    remaining_free = remaining_free
                        .checked_sub(assets_part)
                        .expect("subtraction underflow");
                    tma = tma.checked_sub(assets_part).expect("subtraction underflow");
                    partially_filled = true;

                    kept.push_back(WithdrawalRequest {
                        request_id: request.request_id,
                        owner: request.owner,
                        shares: shares_remaining,
                        requested_at: request.requested_at,
                    });
                } else {
                    // Free capital too small to fund even one share of the
                    // head request — keep it untouched.
                    kept.push_back(request);
                }
                // Whatever free capital remains cannot fund another share of
                // the (older) head remainder, so servicing anything behind it
                // would break FIFO. Defer the rest.
                hit_capacity = true;
                continue;
            }

            // A request that has decayed to zero asset value (e.g. a payout
            // reduced the share price after it was queued) must not sit at the
            // head and starve later requests. Return the escrowed shares to the
            // owner and drop it — the owner keeps their shares and may
            // re-request. Dropping it advances the queue instead of pinning it.
            if assets == 0 {
                Base::update(e, Some(&vault_addr), Some(&request.owner), request.shares);
                // No Credited fires for a dropped request — emit the drop so
                // indexers can close it out and the owner learns their exit
                // did not happen and must be re-requested.
                RequestDropped {
                    owner: request.owner.clone(),
                    request_id: request.request_id,
                    shares: request.shares,
                }
                .publish(e);
                returned_any = true;
                continue;
            }

            // Burn escrowed shares (held by vault)
            Base::update(e, Some(&vault_addr), None, request.shares);

            // Credit claimable balance (pull-based)
            let owner = request.owner.clone();
            let key = VaultKey::ClaimableBalance(owner.clone());
            let claimable: i128 = e.storage().persistent().get(&key).unwrap_or(0);
            let new_balance = claimable.checked_add(assets).expect("addition overflow");
            e.storage().persistent().set(&key, &new_balance);

            // Extend TTL on every credit and emit an event so the off-chain
            // TTL cron can mirror the address into its claimable_balances table.
            e.storage()
                .persistent()
                .extend_ttl(&key, CLAIMABLE_TTL_LEDGERS, CLAIMABLE_TTL_LEDGERS);
            Credited {
                user: owner,
                amount: assets,
                new_balance,
            }
            .publish(e);

            remaining_free = remaining_free
                .checked_sub(assets)
                .expect("subtraction underflow");
            tma = tma.checked_sub(assets).expect("subtraction underflow");
            processed = processed.checked_add(1).expect("addition overflow");
        }

        // Requests beyond the batch window were never examined — carry them
        // over in one bulk copy instead of per-entry host calls.
        if limit < queue.len() {
            kept.append(&queue.slice(limit..));
        }

        // Single storage write for the running total — the loop priced every
        // request against the local `tma`, so persisting once at the end is
        // equivalent to the per-iteration write it replaces.
        if processed > 0 || partially_filled {
            e.storage()
                .instance()
                .set(&VaultKey::TotalManagedAssets, &tma);
        }
        if processed > 0 || returned_any || partially_filled {
            e.storage()
                .instance()
                .set(&VaultKey::WithdrawalQueue, &kept);
        }
    }

    /// Controller-only: mint shares for matured deposit requests (batched,
    /// FIFO) — the entry-side mirror of `process_withdrawal_queue`. Each
    /// matured request's escrowed assets convert to shares at the CURRENT
    /// share price and join managed assets; requests younger than the LP
    /// pricing delay stay queued, and the whole pass is a no-op while a
    /// public outcome is unsettled, so nobody is ever minted at a price that
    /// omits recognized or imminent PnL.
    #[when_not_paused]
    pub fn process_deposit_queue(e: &Env, controller: Address) {
        require_controller(e, &controller);
        Self::extend_ttl(e);

        // Same barrier as withdrawal processing: pricing while a public
        // flight outcome is unsettled would hand the entrant the stale
        // pre-settlement share price.
        if settlement_pending(e) {
            return;
        }

        let queue: Vec<DepositRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::DepositQueue)
            .unwrap_or(Vec::new(e));
        if queue.is_empty() {
            return;
        }

        let now = e.ledger().timestamp();
        let limit = queue.len().min(MAX_QUEUE_BATCH);
        let mut kept: Vec<DepositRequest> = Vec::new(e);
        let mut tma = Self::get_total_managed_assets(e);
        let mut changed = false;
        let mut deferred = false;
        let vault_addr = e.current_contract_address();

        for i in 0..limit {
            let request = queue.get(i).unwrap();

            // The queue is chronological, so the first immature request
            // defers everything behind it (mirrors the withdrawal pass).
            if deferred {
                kept.push_back(request);
                continue;
            }
            let mature_at = request
                .requested_at
                .checked_add(LP_PRICING_DELAY_SECS)
                .expect("addition overflow");
            if now < mature_at {
                kept.push_back(request);
                deferred = true;
                continue;
            }

            // Price against the running TMA: each mint grows supply and
            // managed assets in lockstep, so later requests in the pass see
            // a consistent share price.
            let shares = convert_to_shares_with_tma(e, request.assets, tma, Rounding::Floor);
            if shares == 0 {
                // Share price rose so far since the request that its assets
                // no longer buy a single share. Minting zero would donate the
                // escrow to existing holders — return it instead and close
                // the request out.
                let asset = token::Client::new(e, &Vault::query_asset(e));
                asset.transfer(&vault_addr, &request.owner, &request.assets);
                DepositDropped {
                    owner: request.owner.clone(),
                    request_id: request.request_id,
                    assets: request.assets,
                }
                .publish(e);
                changed = true;
                continue;
            }

            // Mint to the owner and recognize the escrowed assets as managed.
            Base::update(e, None, Some(&request.owner), shares);
            tma = tma.checked_add(request.assets).expect("addition overflow");
            DepositProcessed {
                owner: request.owner.clone(),
                request_id: request.request_id,
                assets: request.assets,
                shares,
            }
            .publish(e);
            changed = true;
        }

        // Requests beyond the batch window carry over untouched.
        if limit < queue.len() {
            kept.append(&queue.slice(limit..));
        }

        // Nothing minted or dropped means `kept` equals the stored queue —
        // skip both writes. (Deferral alone changes nothing.)
        if changed {
            e.storage()
                .instance()
                .set(&VaultKey::TotalManagedAssets, &tma);
            e.storage().instance().set(&VaultKey::DepositQueue, &kept);
        }
    }
}
