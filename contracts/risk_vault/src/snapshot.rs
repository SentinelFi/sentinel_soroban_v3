use soroban_sdk::{contractimpl, token, Env};
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;
use stellar_tokens::vault::Vault;

use crate::auth::settlement_pending;
use crate::constants::{SECONDS_PER_DAY, SNAPSHOT_TTL_LEDGERS};
use crate::events::SharePriceSnapshot;
use crate::storage::VaultKey;
use crate::{RiskVault, RiskVaultArgs, RiskVaultClient};

#[contractimpl]
impl RiskVault {
    /// Record today's share price into temporary storage and emit it.
    ///
    /// Access control: **intentionally permissionless** — any address may call
    /// this, by design. It is a keeper/cron entrypoint meant to be triggered
    /// by the off-chain scheduler, but anyone is allowed to keep the daily price
    /// series alive. This is safe because the function:
    /// - moves no funds and mutates no capital/locked accounting — it only
    ///   writes a derived price into temporary storage and emits an event;
    /// - cannot be manipulated by the caller — the price is computed solely
    ///   from on-chain state, so a caller controls only *when* it runs, never
    /// the recorded value;
    /// - is idempotent and rate-limited — it no-ops if a snapshot already
    ///   exists for the current day (see the guard below), so repeated or
    ///   adversarial calls cost the caller gas but change nothing.
    ///
    /// One residual caller degree of freedom: WHICH moment within the day is
    /// recorded. An early caller can pin the day's price before that day's
    /// settlements land (the pending-outcomes guard below only defers while
    /// an outcome is already public). Consumers of the daily series must
    /// treat the intra-day sample point as untrusted — it is analytics data,
    /// never an executable quote or a pricing input.
    #[when_not_paused]
    pub fn snapshot(e: &Env) {
        let now = e.ledger().timestamp();
        let last: u64 = e
            .storage()
            .instance()
            .get(&VaultKey::LastSnapshotTime)
            .unwrap_or(0);

        // No-op if this calendar day already has a snapshot. Gating on the
        // day number (the same value used as the storage key) rather than a
        // rolling 24-hour window keeps the series aligned to calendar days —
        // a rolling gate lets the snapshot time creep forward and skip days.
        let day = now.checked_div(SECONDS_PER_DAY).expect("division by zero");
        if last != 0 && day == last / SECONDS_PER_DAY {
            return;
        }

        // Skip while a public flight outcome awaits settlement: the NAV at
        // this moment includes unrecognized PnL, so recording it would
        // publish a price no executable path honors. The cron retries and
        // records once settlement completes.
        if settlement_pending(e) {
            return;
        }

        // Derive the price scale from the underlying asset's decimals so
        // the snapshot is meaningful regardless of stablecoin precision.
        // For 7-decimal asset this is still 10^7.
        let asset = token::Client::new(e, &Vault::query_asset(e));
        let scale = 10i128
            .checked_pow(asset.decimals())
            .expect("decimals power overflow");

        let total_supply = Base::total_supply(e);
        // Price on the internal managed-asset basis, the same figure queue
        // pricing and the `preview_*` quotes use — NOT the raw token balance.
        // The raw balance additionally includes processed-but-uncollected
        // withdrawal liabilities (and any direct donations), which no longer back
        // outstanding shares, so pricing on it would publish an inflated share
        // price to off-chain analytics.
        //
        // The recorded price is the exact net-backing-per-share ratio
        // (TMA * scale / supply). It deliberately omits the virtual-offset
        // terms (+1 / +10^offset) that the conversion helpers add as an
        // inflation-attack defense, so at near-zero supply it can diverge
        // slightly from preview_* results; at any real supply the two agree.
        // Consumers should treat it as the vault's net asset value per share,
        // not as an executable quote.
        let price = if total_supply > 0 {
            Self::get_total_managed_assets(e)
                .checked_mul(scale)
                .expect("multiplication overflow")
                .checked_div(total_supply)
                .expect("division by zero")
        } else {
            scale
        };

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
        Self::extend_ttl(e);

        // Emit so off-chain analytics can subscribe instead of polling.
        SharePriceSnapshot { day, price }.publish(e);
    }

    /// Return the recorded share price for the given day (0 if expired/absent).
    pub fn get_snapshot_price(e: &Env, day: u64) -> i128 {
        // Temporary storage — entries older than 30 days return None (= 0).
        // Stale snapshots are intentionally not queryable on-chain.
        e.storage()
            .temporary()
            .get(&VaultKey::SnapshotPrice(day))
            .unwrap_or(0)
    }
}
