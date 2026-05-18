#![no_std]
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, token, Address, Env, MuxedAddress,
    String, Vec,
};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_macros::only_owner;
use stellar_tokens::fungible::{Base, FungibleToken};
use stellar_tokens::vault::Vault;

#[contracttype]
#[derive(Clone)]
pub enum VaultKey {
    // Instance — global single-row state (auto-extended with contract instance TTL)
    Controller,
    TotalManagedAssets,
    LockedCapital,
    WithdrawalQueue,
    LastSnapshotTime,

    // Persistent — TTL extended on every write to prevent silent archival
    ClaimableBalance(Address),

    // Temporary — auto-deletes on TTL expiry, no archival rent
    SnapshotPrice(u64),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawalRequest {
    pub owner: Address,
    pub shares: i128,
    pub timestamp: u64,
}

/// Mode for `recover_uncollected` — owner-driven manual recovery of an
/// archived `ClaimableBalance` entry. Carried on the wire via the
/// `vault.recovered` event so the off-chain indexer can update its
/// `claimable_balances` table accordingly.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RecoveryMode {
    /// Re-credit `ClaimableBalance(user) = amount`. Sets (not adds) so the
    /// owner provides the full owed amount reconstructed from event logs.
    /// Future `process_withdrawal_queue` credits ADD on top normally.
    Recredit,
    /// Transfer USDC directly from vault to user. No `ClaimableBalance`
    /// storage write. Indexer DELETEs the address from its tracker.
    Transfer,
}

// --- Events ---
//
// Emitted on every `ClaimableBalance` state change. Powers the off-chain
// indexer which maintains a list of addresses with non-zero balances; that
// list feeds the off-chain TTL cron's `ExtendFootprintTTLOp` extensions.

#[contractevent(topics = ["vault", "credited"], data_format = "map")]
pub struct Credited {
    #[topic]
    user: Address,
    amount: i128,
    new_balance: i128,
}

#[contractevent(topics = ["vault", "collected"], data_format = "single-value")]
pub struct Collected {
    #[topic]
    user: Address,
    amount: i128,
}

#[contractevent(topics = ["vault", "recovered"], data_format = "map")]
pub struct Recovered {
    #[topic]
    user: Address,
    amount: i128,
    mode: RecoveryMode,
}

const SECONDS_PER_DAY: u64 = 86400;

// --- TTL constants ---

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;

/// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800.
/// Applied on every `ClaimableBalance(addr)` write to prevent silent archival
/// of per-user pending USDC. Layered defense:
/// 1. On-write extension (this constant).
/// 2. Off-chain TTL cron footprint extension via the indexer.
/// 3. `recover_uncollected` owner manual fallback.
const CLAIMABLE_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;

/// 30 days at 5s/ledger = 30 * 24 * 60 * 12 = 518_400.
/// Applied on every `SnapshotPrice(day)` Temporary write. Snapshots are
/// short-lived — recent ones queryable on-chain; older entries auto-delete
/// with no archival rent. Historical analytics happen off-chain via events.
const SNAPSHOT_TTL_LEDGERS: u32 = 30 * 24 * 60 * 12;

#[contract]
pub struct RiskVault;

fn require_controller(e: &Env, controller: &Address) {
    controller.require_auth();
    let stored: Address = e
        .storage()
        .instance()
        .get(&VaultKey::Controller)
        .expect("controller not set");
    assert!(controller == &stored, "not controller");
}

#[contractimpl]
impl RiskVault {
    pub fn __constructor(e: &Env, owner: Address, usdc_token: Address) {
        ownable::set_owner(e, &owner);
        Base::set_metadata(
            e,
            10,
            String::from_str(e, "RiskVault Share"),
            String::from_str(e, "RVS"),
        );
        Vault::set_asset(e, usdc_token);
        Vault::set_decimals_offset(e, 3);
        e.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &0i128);
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &0i128);
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &0u64);
    }

    // ─── Owner-only ───

    #[only_owner]
    pub fn set_controller(e: &Env, controller: Address) {
        assert!(
            !e.storage().instance().has(&VaultKey::Controller),
            "controller already set"
        );
        e.storage()
            .instance()
            .set(&VaultKey::Controller, &controller);
    }

    // ─── Vault operations (wrapping OZ Vault with TMA tracking) ───

    pub fn deposit(e: &Env, assets: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let shares = Vault::deposit(e, assets, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        shares
    }

    pub fn withdraw(e: &Env, assets: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
        assert!(assets <= Self::get_free_capital(e), "exceeds free capital");
        let shares = Vault::withdraw(e, assets, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(assets).expect("subtraction underflow"),
        );
        shares
    }

    pub fn mint_shares(e: &Env, shares: i128, receiver: Address, from: Address, operator: Address) -> i128 {
        let assets = Vault::mint(e, shares, receiver, from, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(assets).expect("addition overflow"),
        );
        assets
    }

    pub fn redeem(e: &Env, shares: i128, receiver: Address, owner: Address, operator: Address) -> i128 {
        let assets = Vault::preview_redeem(e, shares);
        assert!(assets <= Self::get_free_capital(e), "exceeds free capital");
        let actual_assets = Vault::redeem(e, shares, receiver, owner, operator);
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(actual_assets)
                .expect("subtraction underflow"),
        );
        actual_assets
    }

    // ─── Vault query functions (delegate to OZ) ───

    pub fn total_assets(e: &Env) -> i128 {
        Vault::total_assets(e)
    }

    pub fn asset(e: &Env) -> Address {
        Vault::query_asset(e)
    }

    pub fn convert_to_shares(e: &Env, assets: i128) -> i128 {
        Vault::convert_to_shares(e, assets)
    }

    pub fn convert_to_assets(e: &Env, shares: i128) -> i128 {
        Vault::convert_to_assets(e, shares)
    }

    pub fn preview_deposit(e: &Env, assets: i128) -> i128 {
        Vault::preview_deposit(e, assets)
    }

    pub fn preview_mint(e: &Env, shares: i128) -> i128 {
        Vault::preview_mint(e, shares)
    }

    pub fn preview_withdraw(e: &Env, assets: i128) -> i128 {
        Vault::preview_withdraw(e, assets)
    }

    pub fn preview_redeem(e: &Env, shares: i128) -> i128 {
        Vault::preview_redeem(e, shares)
    }

    pub fn max_deposit(e: &Env, address: Address) -> i128 {
        Vault::max_deposit(e, address)
    }

    pub fn max_mint(e: &Env, address: Address) -> i128 {
        Vault::max_mint(e, address)
    }

    pub fn max_withdraw(e: &Env, owner: Address) -> i128 {
        let vault_max = Vault::max_withdraw(e, owner);
        let free = Self::get_free_capital(e);
        if vault_max < free {
            vault_max
        } else {
            free
        }
    }

    pub fn max_redeem(e: &Env, owner: Address) -> i128 {
        let vault_max = Vault::max_redeem(e, owner);
        let free_capital = Self::get_free_capital(e);
        let free_shares = Vault::convert_to_shares(e, free_capital);
        if vault_max < free_shares {
            vault_max
        } else {
            free_shares
        }
    }

    // ─── Controller-only functions ───

    pub fn increase_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let locked = Self::get_locked_capital(e);
        let tma = Self::get_total_managed_assets(e);
        let new_locked = locked.checked_add(amount).expect("addition overflow");
        assert!(new_locked <= tma, "would exceed total managed assets");
        e.storage()
            .instance()
            .set(&VaultKey::LockedCapital, &new_locked);
    }

    pub fn decrease_locked(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let locked = Self::get_locked_capital(e);
        assert!(amount <= locked, "would go negative");
        e.storage().instance().set(
            &VaultKey::LockedCapital,
            &locked.checked_sub(amount).expect("subtraction underflow"),
        );
    }

    pub fn record_premium_income(e: &Env, controller: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let tma = Self::get_total_managed_assets(e);
        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_add(amount).expect("addition overflow"),
        );
    }

    pub fn send_payout(e: &Env, controller: Address, to: Address, amount: i128) {
        require_controller(e, &controller);
        assert!(amount > 0, "amount must be positive");
        let tma = Self::get_total_managed_assets(e);
        assert!(amount <= tma, "insufficient managed assets");

        let usdc = token::Client::new(e, &Vault::query_asset(e));
        usdc.transfer(&e.current_contract_address(), &to, &amount);

        e.storage().instance().set(
            &VaultKey::TotalManagedAssets,
            &tma.checked_sub(amount).expect("subtraction underflow"),
        );
    }

    pub fn process_withdrawal_queue(e: &Env, controller: Address) {
        require_controller(e, &controller);

        let queue: Vec<WithdrawalRequest> = e
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e));

        if queue.is_empty() {
            return;
        }

        let mut remaining_free = Self::get_free_capital(e);
        let mut processed: u32 = 0;
        let mut tma = Self::get_total_managed_assets(e);
        let vault_addr = e.current_contract_address();

        for i in 0..queue.len() {
            let request = queue.get(i).unwrap();
            let assets = Vault::preview_redeem(e, request.shares);

            if assets > remaining_free || assets == 0 {
                break;
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
            e.storage().persistent().extend_ttl(
                &key,
                CLAIMABLE_TTL_LEDGERS,
                CLAIMABLE_TTL_LEDGERS,
            );
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

        if processed > 0 {
            let mut new_queue = Vec::new(e);
            for i in processed..queue.len() {
                new_queue.push_back(queue.get(i).unwrap());
            }
            e.storage()
                .instance()
                .set(&VaultKey::WithdrawalQueue, &new_queue);
            e.storage()
                .instance()
                .set(&VaultKey::TotalManagedAssets, &tma);
        }
    }

    // ─── Withdrawal queue (underwriter-facing) ───

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

    // ─── Snapshot ───

    pub fn snapshot(e: &Env) {
        let now = e.ledger().timestamp();
        let last: u64 = e
            .storage()
            .instance()
            .get(&VaultKey::LastSnapshotTime)
            .unwrap_or(0);

        // No-op if already snapshotted today (safe to call repeatedly)
        if last != 0
            && now < last
                .checked_add(SECONDS_PER_DAY)
                .expect("addition overflow")
        {
            return;
        }

        let total_supply = Base::total_supply(e);
        let price = if total_supply > 0 {
            Vault::total_assets(e)
                .checked_mul(10_000_000i128)
                .expect("multiplication overflow")
                .checked_div(total_supply)
                .expect("division by zero")
        } else {
            10_000_000i128
        };

        let day = now.checked_div(SECONDS_PER_DAY).expect("division by zero");
        // SnapshotPrice lives in Temporary storage with a 30-day TTL — old
        // snapshots auto-delete with no archival rent. Historical analytics
        // are off-chain via events.
        let snap_key = VaultKey::SnapshotPrice(day);
        e.storage().temporary().set(&snap_key, &price);
        e.storage().temporary().extend_ttl(
            &snap_key,
            SNAPSHOT_TTL_LEDGERS,
            SNAPSHOT_TTL_LEDGERS,
        );
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &now);
    }

    // ─── TTL management ───

    /// Extend instance TTL. Called by cron as a safety net.
    pub fn extend_ttl(e: &Env) {
        e.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    // ─── Query functions ───

    pub fn get_total_managed_assets(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&VaultKey::TotalManagedAssets)
            .unwrap_or(0)
    }

    pub fn get_locked_capital(e: &Env) -> i128 {
        e.storage()
            .instance()
            .get(&VaultKey::LockedCapital)
            .unwrap_or(0)
    }

    pub fn get_free_capital(e: &Env) -> i128 {
        let tma = Self::get_total_managed_assets(e);
        let locked = Self::get_locked_capital(e);
        tma.checked_sub(locked).expect("subtraction underflow")
    }

    pub fn get_controller(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&VaultKey::Controller)
            .unwrap()
    }

    pub fn get_withdrawal_queue(e: &Env) -> Vec<WithdrawalRequest> {
        e.storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(e))
    }

    pub fn get_claimable_balance(e: &Env, address: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&VaultKey::ClaimableBalance(address))
            .unwrap_or(0)
    }

    pub fn get_snapshot_price(e: &Env, day: u64) -> i128 {
        // Temporary storage — entries older than 30 days return None (= 0).
        // Stale snapshots are intentionally not queryable on-chain.
        e.storage()
            .temporary()
            .get(&VaultKey::SnapshotPrice(day))
            .unwrap_or(0)
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for RiskVault {
    type ContractType = Base;
}

#[contractimpl(contracttrait)]
impl Ownable for RiskVault {}

#[cfg(test)]
mod test;
