use soroban_sdk::{contractimpl, token, Env};
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::events::SharePriceSnapshot;
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
            && now
                < last
                    .checked_add(SECONDS_PER_DAY)
                    .expect("addition overflow")
        {
            return;
        }

        // Derive the price scale from the underlying asset's decimals so
        // the snapshot is meaningful regardless of stablecoin precision
        // (L-04 — audit). For 7-decimal USDC this is still 10^7.
        let asset = token::Client::new(e, &Vault::query_asset(e));
        let scale = 10i128
            .checked_pow(asset.decimals())
            .expect("decimals power overflow");

        let total_supply = Base::total_supply(e);
        let price = if total_supply > 0 {
            Vault::total_assets(e)
                .checked_mul(scale)
                .expect("multiplication overflow")
                .checked_div(total_supply)
                .expect("division by zero")
        } else {
            scale
        };

        let day = now.checked_div(SECONDS_PER_DAY).expect("division by zero");
        // SnapshotPrice lives in Temporary storage with a 30-day TTL — old
        // snapshots auto-delete with no archival rent. Historical analytics
        // are off-chain via events.
        let snap_key = VaultKey::SnapshotPrice(day);
        e.storage().temporary().set(&snap_key, &price);
        e.storage()
            .temporary()
            .extend_ttl(&snap_key, SNAPSHOT_TTL_LEDGERS, SNAPSHOT_TTL_LEDGERS);
        e.storage()
            .instance()
            .set(&VaultKey::LastSnapshotTime, &now);

        // L-05: emit so off-chain analytics can subscribe instead of polling.
        SharePriceSnapshot { day, price }.publish(e);
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
