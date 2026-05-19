use soroban_sdk::{contractimpl, Env};
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::storage::{VaultKey, SECONDS_PER_DAY, SNAPSHOT_TTL_LEDGERS};
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl RiskVault {
    #[when_not_paused]
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

    pub fn get_snapshot_price(e: &Env, day: u64) -> i128 {
        // Temporary storage — entries older than 30 days return None (= 0).
        // Stale snapshots are intentionally not queryable on-chain.
        e.storage()
            .temporary()
            .get(&VaultKey::SnapshotPrice(day))
            .unwrap_or(0)
    }
}
