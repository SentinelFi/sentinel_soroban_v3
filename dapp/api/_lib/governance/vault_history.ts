import { getDb } from "./db.js";
import type { SorobanClient } from "../soroban_client.js";

/**
 * vault_history — the vault's time series, appended by the
 * queue_maintainer cron on every invocation (including its early-return
 * paths, so cadence is the cron schedule, not queue activity).
 *
 * The protocol keeps no history anywhere else: RPC events expire in ~7
 * days and the on-chain snapshot is daily. This mirror is what makes
 * rate-of-change detection possible at all — sudden share-price moves,
 * solvency drops, and the supply-conservation check on the Security
 * board all read from here.
 *
 * DB-OPTIONAL and never load-bearing: a write failure is console-logged
 * and the caller's job continues untouched.
 */

/** i128 columns are stored as numeric — Postgres holds them exactly. */
export async function ensureVaultHistoryTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    create table if not exists vault_history (
      id bigint generated always as identity primary key,
      ts timestamptz not null default now(),
      total_assets numeric not null,
      free_capital numeric not null,
      locked_capital numeric not null,
      total_supply numeric not null,
      -- USDC (7-dp units) per 1.0 share: TMA * 10^10 / supply, the same
      -- net-backing basis the on-chain snapshot records
      share_price numeric not null
    )
  `;
  // Self-created tables default to RLS-DISABLED and Supabase grants the
  // public schema to anon/authenticated — enable deny-all RLS (zero
  // policies) like every migration-defined table. The owning server-side
  // role bypasses RLS. Idempotent.
  await sql`alter table vault_history enable row level security`;
  await sql`create index if not exists vault_history_ts_idx on vault_history (ts desc)`;
}

/** Read the vault's headline figures and append one history row. */
export async function recordVaultHistory(
  client: SorobanClient,
  riskVaultId: string
): Promise<void> {
  if (!process.env.GOVERNANCE_DB_URL) return;
  try {
    const [tma, free, locked, supply] = await Promise.all([
      client.readContractWithRetry(riskVaultId, "get_total_managed_assets"),
      client.readContractWithRetry(riskVaultId, "get_free_capital"),
      client.readContractWithRetry(riskVaultId, "get_locked_capital"),
      client.readContractWithRetry(riskVaultId, "total_supply"),
    ]);
    const tmaU = BigInt(tma ?? 0);
    const supplyU = BigInt(supply ?? 0);
    // 1.0 share = 10^10 units (asset 7 decimals + virtual offset 3).
    const sharePrice = supplyU > 0n ? (tmaU * 10_000_000_000n) / supplyU : 10_000_000n;

    const sql = getDb();
    await ensureVaultHistoryTable(sql);
    await sql`
      insert into vault_history
        (total_assets, free_capital, locked_capital, total_supply, share_price)
      values
        (${tmaU.toString()}, ${BigInt(free ?? 0).toString()},
         ${BigInt(locked ?? 0).toString()}, ${supplyU.toString()},
         ${sharePrice.toString()})
    `;
  } catch (err) {
    console.warn(`[vault-history] append failed (job unaffected): ${err}`);
  }
}
