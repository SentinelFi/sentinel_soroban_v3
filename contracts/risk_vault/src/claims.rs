// Underwriter-facing two-phase lifecycles: request_deposit → process (mint),
// request_withdrawal → process → collect, request cancellation, plus
// owner-driven manual recovery for entries archived past their TTL.

use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env, Vec};
use stellar_contract_utils::math::Rounding;
use stellar_macros::{only_owner, when_not_paused};
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::constants::{
    CLAIMABLE_TTL_LEDGERS, MAX_ACTIVE_REQUESTS_PER_ADDRESS, MAX_DEPOSIT_QUEUE_LEN,
    MAX_WITHDRAWAL_QUEUE_LEN, MIN_REQUEST_FLOOR_CAP_ABS, MIN_REQUEST_FLOOR_DIVISOR,
};
use crate::events::{
    Collected, DepositCancelled, DepositRequested, Recovered, WithdrawalCancelled,
    WithdrawalRequested,
};
use crate::storage::{DepositRequest, VaultKey};
use crate::vault_ops::{managed_convert_to_assets, managed_convert_to_shares};
use crate::{Error, RecoveryMode, RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    /// Submit an LP entry request. The assets transfer into the vault
    /// immediately (escrowed — NOT yet counted as managed assets and backing
    /// no shares), and queue processing mints the shares only after the
    /// request outlives the LP pricing delay, at the share price current at
    /// processing time. Committing value before pricing is the point: by the
    /// time the request is priced, every flight outcome that was publicly
    /// knowable at request time has reached the chain, so an informed
    /// depositor cannot capture a known-but-unrecognized gain from the
    /// incumbent LPs. Returns a monotonic request_id usable with
    /// `cancel_deposit`.
    #[when_not_paused]
    pub fn request_deposit(e: &Env, caller: Address, assets: i128) -> u64 {
        caller.require_auth();
        Self::extend_ttl(e);
        if assets <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }
        // Early dust rejection: an amount that previews to zero shares at the
        // current price would only occupy a queue slot (processing would
        // return it anyway). The authoritative zero-share check re-runs at
        // processing time against the price actually applied.
        if managed_convert_to_shares(e, assets, Rounding::Floor) == 0 {
            panic_with_error!(e, Error::AssetsConvertToZeroShares);
        }
        let mut queue: Vec<DepositRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::DepositQueue)
            .unwrap_or(Vec::new(e));
        if queue.len() >= MAX_DEPOSIT_QUEUE_LEN {
            panic_with_error!(e, Error::DepositQueueFull);
        }
        // Same anti-squatting floor as the withdrawal queue: each slot of the
        // bounded queue must carry meaningful escrowed value, with the
        // occupancy-scaled lower bound keeping slots expensive even when the
        // configured minimum is low or unset (see request_withdrawal /
        // MIN_REQUEST_FLOOR_DIVISOR). The absolute floor on the cap keeps
        // both protections alive at near-zero TMA (see
        // MIN_REQUEST_FLOOR_CAP_ABS).
        let floor_cap = Self::get_total_managed_assets(e)
            .checked_div(MIN_REQUEST_FLOOR_DIVISOR)
            .expect("division by zero")
            .max(MIN_REQUEST_FLOOR_CAP_ABS);
        let occupancy_floor = floor_cap
            .checked_mul(queue.len() as i128)
            .expect("multiplication overflow")
            .checked_div(MAX_DEPOSIT_QUEUE_LEN as i128)
            .expect("division by zero");
        let effective_min = Self::get_min_withdrawal_request(e)
            .min(floor_cap)
            .max(occupancy_floor);
        if assets < effective_min {
            panic_with_error!(e, Error::RequestBelowMinimum);
        }
        let mut own_count: u32 = 0;
        for i in 0..queue.len() {
            if queue.get(i).unwrap().owner == caller {
                own_count = own_count.checked_add(1).expect("count overflow");
            }
        }
        if own_count >= MAX_ACTIVE_REQUESTS_PER_ADDRESS {
            panic_with_error!(e, Error::TooManyActiveRequests);
        }

        // Escrow the assets in the vault. TMA is deliberately NOT increased —
        // escrowed entries back no shares until they are priced and minted.
        let asset = token::Client::new(e, &Vault::query_asset(e));
        asset.transfer(&caller, e.current_contract_address(), &assets);

        let request_id: u64 = e
            .storage()
            .instance()
            .get(&VaultKey::NextRequestId)
            .unwrap_or(0);
        let next_id = request_id.checked_add(1).expect("request_id overflow");
        e.storage()
            .instance()
            .set(&VaultKey::NextRequestId, &next_id);

        queue.push_back(DepositRequest {
            request_id,
            owner: caller.clone(),
            assets,
            requested_at: e.ledger().timestamp(),
        });
        e.storage().instance().set(&VaultKey::DepositQueue, &queue);

        DepositRequested {
            owner: caller,
            request_id,
            assets,
            queue_len: queue.len(),
        }
        .publish(e);

        request_id
    }

    /// Cancel a queued deposit by request_id and return the escrowed assets.
    /// Cancellation carries no pricing optionality: a queued deposit is
    /// always minted at the post-outcome price, so backing out never lets
    /// the owner dodge a loss or capture a gain that belongs to others.
    #[when_not_paused]
    pub fn cancel_deposit(e: &Env, caller: Address, request_id: u64) {
        caller.require_auth();
        Self::extend_ttl(e);

        let mut queue: Vec<DepositRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::DepositQueue)
            .unwrap_or(Vec::new(e));

        let mut found: Option<u32> = None;
        for i in 0..queue.len() {
            if queue.get(i).unwrap().request_id == request_id {
                found = Some(i);
                break;
            }
        }
        let idx = match found {
            Some(i) => i,
            None => panic_with_error!(e, Error::RequestNotFound),
        };
        let request = queue.get(idx).unwrap();
        if request.owner != caller {
            panic_with_error!(e, Error::NotYourRequest);
        }

        queue.remove(idx);
        e.storage().instance().set(&VaultKey::DepositQueue, &queue);

        let asset = token::Client::new(e, &Vault::query_asset(e));
        asset.transfer(&e.current_contract_address(), &caller, &request.assets);

        DepositCancelled {
            owner: caller,
            request_id,
            assets: request.assets,
            queue_len: queue.len(),
        }
        .publish(e);
    }
    /// Submit a withdrawal request — the only LP exit path. The shares
    /// escrow immediately; queue processing pays out only after the request
    /// outlives the LP pricing delay, at the share price current at
    /// processing time (see `request_deposit` on why pricing is delayed).
    /// Returns a monotonic request_id that the caller can use to cancel the
    /// request later (immune to queue reorder caused by intervening
    /// process_withdrawal_queue calls).
    #[when_not_paused]
    pub fn request_withdrawal(e: &Env, caller: Address, shares: i128) -> u64 {
        caller.require_auth();
        Self::extend_ttl(e);
        if shares <= 0 {
            panic_with_error!(e, Error::SharesMustBePositive);
        }
        // Reject dust requests that preview to zero assets on the managed-asset
        // basis. Such a request carries no value and would only consume queue
        // capacity.
        let preview = managed_convert_to_assets(e, shares, Rounding::Floor);
        if preview <= 0 {
            panic_with_error!(e, Error::SharesRedeemToZeroAssets);
        }
        let mut queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        // Bound the shared single-vector queue so it can't grow into the
        // contract-instance entry-size limit and become unwritable.
        if queue.len() >= MAX_WITHDRAWAL_QUEUE_LEN {
            panic_with_error!(e, Error::WithdrawalQueueFull);
        }
        // Enforce the request-value floor: each slot of the bounded queue must
        // carry meaningful escrowed capital, or one actor could cheaply occupy
        // every slot via many small requests spread across addresses. Two
        // clamps shape the owner-configured minimum (MIN_REQUEST_FLOOR_DIVISOR):
        //  - from above, TMA/2500, so no configuration — mistaken or hostile —
        //    can exclude ordinary positions from the queue;
        //  - from below, that same cap scaled by current occupancy, so a low
        //    or unset configuration cannot make slots free to squat: an empty
        //    queue admits any non-dust request, but each further slot prices
        //    higher, and pinning the queue full escrows a material fraction
        //    of managed assets no matter what the owner configured.
        // Both clamps are value-relative, so the cap itself is floored by an
        // absolute constant — otherwise near-zero TMA (launch, severe
        // drawdown) would zero every protection at once and make slots free
        // (see MIN_REQUEST_FLOOR_CAP_ABS).
        let floor_cap = Self::get_total_managed_assets(e)
            .checked_div(MIN_REQUEST_FLOOR_DIVISOR)
            .expect("division by zero")
            .max(MIN_REQUEST_FLOOR_CAP_ABS);
        let occupancy_floor = floor_cap
            .checked_mul(queue.len() as i128)
            .expect("multiplication overflow")
            .checked_div(MAX_WITHDRAWAL_QUEUE_LEN as i128)
            .expect("division by zero");
        let effective_min = Self::get_min_withdrawal_request(e)
            .min(floor_cap)
            .max(occupancy_floor);
        if preview < effective_min {
            panic_with_error!(e, Error::RequestBelowMinimum);
        }
        // Bound how many pending requests one address may hold, so a single
        // underwriter can't monopolize the queue and starve others.
        let mut own_count: u32 = 0;
        for i in 0..queue.len() {
            if queue.get(i).unwrap().owner == caller {
                own_count = own_count.checked_add(1).expect("count overflow");
            }
        }
        if own_count >= MAX_ACTIVE_REQUESTS_PER_ADDRESS {
            panic_with_error!(e, Error::TooManyActiveRequests);
        }

        // Escrow shares: transfer from caller to vault
        Base::update(
            e,
            Some(&caller),
            Some(&e.current_contract_address()),
            shares,
        );

        let request_id: u64 = e
            .storage()
            .instance()
            .get(&VaultKey::NextRequestId)
            .unwrap_or(0);
        let next_id = request_id.checked_add(1).expect("request_id overflow");
        e.storage()
            .instance()
            .set(&VaultKey::NextRequestId, &next_id);

        queue.push_back(WithdrawalRequest {
            request_id,
            owner: caller.clone(),
            shares,
            requested_at: e.ledger().timestamp(),
        });

        e.storage()
            .instance()
            .set(&VaultKey::WithdrawalQueue, &queue);

        // Post-push occupancy lets operators watch queue saturation and react
        // before the cap starts rejecting exit requests.
        WithdrawalRequested {
            owner: caller,
            request_id,
            shares,
            queue_len: queue.len(),
        }
        .publish(e);

        request_id
    }

    /// Cancel a queued withdrawal by request_id (NOT queue index).
    /// Indices shift when process_withdrawal_queue drains earlier entries;
    /// a stable id avoids cancelling the wrong request.
    #[when_not_paused]
    pub fn cancel_withdrawal(e: &Env, caller: Address, request_id: u64) {
        caller.require_auth();
        Self::extend_ttl(e);

        let mut queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        let mut found: Option<u32> = None;
        for i in 0..queue.len() {
            if queue.get(i).unwrap().request_id == request_id {
                found = Some(i);
                break;
            }
        }
        let idx = match found {
            Some(i) => i,
            None => panic_with_error!(e, Error::RequestNotFound),
        };
        let request = queue.get(idx).unwrap();
        if request.owner != caller {
            panic_with_error!(e, Error::NotYourRequest);
        }

        // Return escrowed shares to caller
        Base::update(
            e,
            Some(&e.current_contract_address()),
            Some(&caller),
            request.shares,
        );

        queue.remove(idx);
        e.storage()
            .instance()
            .set(&VaultKey::WithdrawalQueue, &queue);

        // Post-removal occupancy, mirroring WithdrawalRequested — lets
        // indexers track queue state from events alone.
        WithdrawalCancelled {
            owner: caller,
            request_id,
            shares: request.shares,
            queue_len: queue.len(),
        }
        .publish(e);
    }

    /// Collect (transfer out) the caller's accrued claimable balance.
    #[when_not_paused]
    pub fn collect(e: &Env, caller: Address) {
        caller.require_auth();
        // Renew the instance alongside every other user-facing path so
        // ongoing use keeps the contract alive if the TTL cron lapses.
        Self::extend_ttl(e);

        let key = VaultKey::ClaimableBalance(caller.clone());
        let claimable: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if claimable <= 0 {
            panic_with_error!(e, Error::NothingToCollect);
        }

        // Clear the entry before the external transfer.
        e.storage().persistent().remove(&key);

        let asset = token::Client::new(e, &Vault::query_asset(e));
        asset.transfer(&e.current_contract_address(), &caller, &claimable);

        // Signal balance drained so the off-chain indexer can DELETE this
        // address from its claimable_balances tracker.
        Collected {
            user: caller,
            amount: claimable,
        }
        .publish(e);
    }

    /// Owner-driven manual recovery of an archived `ClaimableBalance` entry
    /// (or any user owed value the protocol couldn't deliver via
    /// `process_withdrawal_queue` + `collect`). Uses event logs as the
    /// audit trail for who is owed what.
    ///
    /// - `RecoveryMode::Recredit` — SET `ClaimableBalance(user) = amount`,
    ///   extend TTL, emit `vault.recovered(.., Recredit)`. Use after
    ///   archival recovery.
    /// - `RecoveryMode::Transfer` — directly `asset.transfer(vault → user,
    ///   amount)`. No storage write. Use when user wants funds in hand.
    ///
    /// Layered defense:
    /// 1. On-write 60-day TTL extension (`process_withdrawal_queue`).
    /// 2. Off-chain TTL cron `ExtendFootprintTTLOp` covering
    ///    `ClaimableBalance(addr)` keys.
    /// 3. This function (`recover_uncollected`) — owner manual fallback if
    ///    layers 1 and 2 fail.
    #[only_owner]
    pub fn recover_uncollected(e: &Env, user: Address, amount: i128, mode: RecoveryMode) {
        if amount <= 0 {
            panic_with_error!(e, Error::AmountMustBePositive);
        }

        match mode {
            RecoveryMode::Recredit => {
                let key = VaultKey::ClaimableBalance(user.clone());
                // SETs the balance (does not add). To prevent silent underpay
                // when an entry already exists, require the new amount to be
                // at least the existing one — restoring an archived entry
                // can only ever bring it back up to its prior value or
                // higher, never down.
                let existing: i128 = e.storage().persistent().get(&key).unwrap_or(0);
                if amount < existing {
                    panic_with_error!(e, Error::RecreditWouldUnderpay);
                }
                // Upper bound, symmetric to the underpay guard: the credit
                // this write leaves behind must be covered by asset the vault
                // holds beyond its managed total. Every legitimate credit
                // already reduced TMA when it was made (including one whose
                // storage entry later lapsed), so `balance − TMA` is exactly
                // the asset available to satisfy claimable entries — this
                // user's included. Crediting past that surplus would create a
                // liability that `collect` could only pay by consuming asset
                // backing outstanding shares — silent insolvency surfacing
                // later as a failed transfer for an unrelated party. A correct
                // restore always fits (its asset is still part of the
                // surplus); only a mis-keyed amount is rejected. The bound is
                // a floor, not exact accounting: other users' uncollected
                // credits also sit in the surplus, so it cannot catch an
                // overpay that overlaps them — if both parties later collect,
                // the shortfall falls on the asset backing shares. Exact
                // aggregate accounting is not achievable on-chain: archived
                // entries are neither enumerable nor measurable (restoring
                // them is this function's purpose), so any liability counter
                // either misses them or double-counts their restore. The
                // guard therefore caps the MAGNITUDE of owner error at the
                // total already owed to users, and the event trail
                // (credited / collected / recovered) is the authoritative
                // ledger the owner must reconcile against before recrediting.
                // Escrowed deposit-queue
                // assets also sit in the raw balance without backing shares,
                // and they are owed back to their requesters — subtract them
                // so a mis-keyed recredit can never be satisfied out of
                // pending entrants' escrow.
                let asset = token::Client::new(e, &Vault::query_asset(e));
                let balance = asset.balance(&e.current_contract_address());
                let mut escrowed_deposits: i128 = 0;
                let dep_queue = Self::get_deposit_queue(e);
                for i in 0..dep_queue.len() {
                    escrowed_deposits = escrowed_deposits
                        .checked_add(dep_queue.get(i).unwrap().assets)
                        .expect("addition overflow");
                }
                let surplus = balance
                    .checked_sub(Self::get_total_managed_assets(e))
                    .expect("subtraction overflow")
                    .checked_sub(escrowed_deposits)
                    .expect("subtraction overflow");
                if amount > surplus {
                    panic_with_error!(e, Error::RecreditExceedsRecoverableSurplus);
                }
                e.storage().persistent().set(&key, &amount);
                e.storage().persistent().extend_ttl(
                    &key,
                    CLAIMABLE_TTL_LEDGERS,
                    CLAIMABLE_TTL_LEDGERS,
                );
            }
            RecoveryMode::Transfer => {
                // Gate: user must have a current ClaimableBalance >= amount.
                // The credit was recorded at process_withdrawal_queue time
                // (which already decremented TMA), so Transfer just settles
                // an existing obligation — it must not exceed it.
                let key = VaultKey::ClaimableBalance(user.clone());
                let existing: i128 = e.storage().persistent().get(&key).unwrap_or(0);
                if amount > existing {
                    panic_with_error!(e, Error::AmountExceedsClaimableBalance);
                }

                // Write state before the external transfer (ordering for
                // clarity; no reentrancy on Soroban).
                let remaining = existing.checked_sub(amount).expect("subtraction underflow");
                if remaining == 0 {
                    e.storage().persistent().remove(&key);
                } else {
                    e.storage().persistent().set(&key, &remaining);
                    // A partial transfer leaves a nonzero balance
                    // behind — refresh its TTL so the remainder can't archive
                    // sooner than a freshly-credited entry.
                    e.storage().persistent().extend_ttl(
                        &key,
                        CLAIMABLE_TTL_LEDGERS,
                        CLAIMABLE_TTL_LEDGERS,
                    );
                }

                let asset = token::Client::new(e, &Vault::query_asset(e));
                asset.transfer(&e.current_contract_address(), &user, &amount);
            }
        }

        Recovered { user, amount, mode }.publish(e);
    }
}
