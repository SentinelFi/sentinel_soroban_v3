// Underwriter-facing withdrawal lifecycle: request → process → collect, plus
// owner-driven manual recovery for entries archived past their TTL.

use soroban_sdk::{contractimpl, panic_with_error, token, Address, Env, Vec};
use stellar_macros::{only_owner, when_not_paused};
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::constants::CLAIMABLE_TTL_LEDGERS;
use crate::events::{Collected, Recovered};
use crate::storage::VaultKey;
use crate::{Error, RecoveryMode, RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    /// Submit a withdrawal request. Returns a monotonic request_id that the
    /// caller can use to cancel the request later (immune to queue reorder
    /// caused by intervening process_withdrawal_queue calls).
    #[when_not_paused]
    pub fn request_withdrawal(e: &Env, caller: Address, shares: i128) -> u64 {
        caller.require_auth();
        Self::extend_ttl(e);
        if shares <= 0 {
            panic_with_error!(e, Error::SharesMustBePositive);
        }
        // Reject dust requests that preview to zero assets. Such a
        // request would otherwise sit at the queue head and block every later
        // request (the drain loop stops at the first zero-preview entry).
        if Vault::preview_redeem(e, shares) <= 0 {
            panic_with_error!(e, Error::SharesRedeemToZeroAssets);
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

        let mut queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        queue.push_back(WithdrawalRequest {
            request_id,
            owner: caller,
            shares,
            timestamp: e.ledger().timestamp(),
        });

        e.storage()
            .instance()
            .set(&VaultKey::WithdrawalQueue, &queue);

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
        let idx = found.expect("request_id not found");
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
    }

    /// Collect (transfer out) the caller's accrued claimable balance.
    #[when_not_paused]
    pub fn collect(e: &Env, caller: Address) {
        caller.require_auth();

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
