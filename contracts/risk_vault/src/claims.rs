// Underwriter-facing withdrawal lifecycle: request → process → collect, plus
// owner-driven manual recovery for entries archived past their TTL.

use soroban_sdk::{contractimpl, token, Address, Env, Vec};
use stellar_macros::only_owner;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::events::{Collected, Recovered};
use crate::storage::{VaultKey, CLAIMABLE_TTL_LEDGERS};
use crate::{RecoveryMode, RiskVault, RiskVaultArgs, RiskVaultClient, WithdrawalRequest};

#[contractimpl]
impl RiskVault {
    pub fn request_withdrawal(e: &Env, caller: Address, shares: i128) {
        caller.require_auth();
        assert!(shares > 0, "shares must be positive");

        // Escrow shares: transfer from caller to vault
        Base::update(e, Some(&caller), Some(&e.current_contract_address()), shares);

        let mut queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        queue.push_back(WithdrawalRequest {
            owner: caller,
            shares,
            timestamp: e.ledger().timestamp(),
        });

        e.storage()
            .instance()
            .set(&VaultKey::WithdrawalQueue, &queue);
    }

    pub fn cancel_withdrawal(e: &Env, caller: Address, queue_index: u32) {
        caller.require_auth();

        let mut queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        let request = queue.get(queue_index).expect("invalid queue index");
        assert!(request.owner == caller, "not your request");

        // Return escrowed shares to caller
        Base::update(e, Some(&e.current_contract_address()), Some(&caller), request.shares);

        queue.remove(queue_index);
        e.storage()
            .instance()
            .set(&VaultKey::WithdrawalQueue, &queue);
    }

    pub fn collect(e: &Env, caller: Address) {
        caller.require_auth();

        let key = VaultKey::ClaimableBalance(caller.clone());
        let claimable: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        assert!(claimable > 0, "nothing to collect");

        let usdc = token::Client::new(e, &Vault::query_asset(e));
        usdc.transfer(&e.current_contract_address(), &caller, &claimable);

        e.storage().persistent().remove(&key);

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
    /// - `RecoveryMode::Transfer` — directly `usdc.transfer(vault → user,
    ///   amount)`. No storage write. Use when user wants funds in hand.
    ///
    /// Layered defense:
    /// 1. On-write 60-day TTL extension (`process_withdrawal_queue`).
    /// 2. Off-chain TTL cron `ExtendFootprintTTLOp` covering
    ///    `ClaimableBalance(addr)` keys.
    /// 3. This function (`recover_uncollected`) — owner manual fallback if
    ///    layers 1 and 2 fail.
    #[only_owner]
    pub fn recover_uncollected(
        e: &Env,
        user: Address,
        amount: i128,
        mode: RecoveryMode,
    ) {
        assert!(amount > 0, "amount must be positive");

        match mode {
            RecoveryMode::Recredit => {
                let key = VaultKey::ClaimableBalance(user.clone());
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
                assert!(amount <= existing, "amount exceeds claimable balance");

                // CEI: write state before the external transfer.
                let remaining = existing
                    .checked_sub(amount)
                    .expect("subtraction underflow");
                if remaining == 0 {
                    e.storage().persistent().remove(&key);
                } else {
                    e.storage().persistent().set(&key, &remaining);
                }

                let usdc = token::Client::new(e, &Vault::query_asset(e));
                usdc.transfer(&e.current_contract_address(), &user, &amount);
            }
        }

        Recovered {
            user,
            amount,
            mode,
        }
        .publish(e);
    }
}
