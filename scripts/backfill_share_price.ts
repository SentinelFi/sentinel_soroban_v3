/**
 * Backfill the daily share-price series from the on-chain snapshots, into a
 * dedicated `share_price_daily` table.
 *
 * WHY THIS EXISTS
 * The headline "realized APR" on /earn annualizes the share price across a
 * 90-day window. That window cannot come from RPC: `get_snapshot_price`
 * entries carry a 30-day TTL, so on-chain history is not merely expensive to
 * read, it EXPIRES. It also cannot come from `vault_history` alone, because
 * that mirror only starts at the first queue_maintainer run that wrote it —
 * on this deployment 2026-08-07, three days after the vault opened. Reading
 * only the mirror measured the vault from its local peak and printed −28.4%
 * APR for a vault that was up +1.0% since inception.
 *
 * WHY NOT WRITE INTO vault_history
 * That table has five NOT NULL columns (total_assets, free_capital,
 * locked_capital, total_supply, share_price) and the on-chain snapshot
 * records ONLY share_price — the rest is unrecoverable for past days.
 * Inventing them would break the honesty rule, and writing NULL/0 would fire
 * false alarms on the Security board: `api/admin/security.ts` flags any
 * `total_supply` change not bracketed by a queue_maintainer run as a supply
 * violation, and backfilled rows have no such run. So this writes its own
 * single-purpose table, and `vault_history` is left exactly as the cron
 * maintains it.
 *
 * SAFETY
 *   - Dry run by DEFAULT. Nothing is written without --apply.
 *   - Implausible snapshots are SKIPPED, not imported: this deployment has a
 *     corrupt 2026-08-06 snapshot of 0.001 (a 1000x dip between two ~1.0
 *     readings) which would poison any series it landed in.
 *   - Idempotent: `day` is the primary key and re-runs upsert in place.
 *
 * Run (from dapp/):
 *   npx tsx ../scripts/backfill_share_price.ts                  # dry run
 *   npx tsx ../scripts/backfill_share_price.ts --apply
 *   npx tsx ../scripts/backfill_share_price.ts --days 30 --apply
 *
 * Needs GOVERNANCE_DB_URL and the usual RPC/contract env (loadConfig).
 */

import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { loadDotEnv } from "../dapp/scripts/env";
loadDotEnv();
import { getDb } from "../dapp/api/_lib/governance/db";

/**
 * Deliberately NOT SorobanClient/loadConfig: those derive a simulation
 * source from ORACLE_SECRET_KEY, so a strictly read-only script would
 * demand a signing key it has no business holding (and which lives only in
 * the deployment env, never in dapp/.env). Simulation needs a source
 * ACCOUNT, not a signer — any funded public address works, and nothing here
 * is ever signed or submitted.
 */
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const RISK_VAULT_ID =
  process.env.RISK_VAULT_ID ?? "CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF";
/** Owner's PUBLIC address — a funded account to simulate against. */
const SIM_SOURCE =
  process.env.SIM_SOURCE ?? "GCEODBNVUGJVYQKWY7NMU4U3EIYQOXA7LADMQOPNB5PBBKMYCQJ7E6KD";

/** 1.0 share, in the snapshot's fixed-point scale (USDC 7-dp). */
const SCALE = 10_000_000;
/** A NAV series cannot legitimately move outside this band day-over-day. */
const MIN_DAILY_RATIO = 0.5;
const MAX_DAILY_RATIO = 2;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface DayPoint {
  day: number;
  raw: bigint;
  price: number;
}

async function ensureTable(sql: ReturnType<typeof getDb>): Promise<void> {
  await sql`
    create table if not exists share_price_daily (
      day integer primary key,
      share_price numeric not null,
      source text not null,
      recorded_at timestamptz not null default now()
    )
  `;
  // Same deny-all RLS posture as every other self-created table (the
  // owning server-side role bypasses it); see governance/interventions.ts.
  await sql`alter table share_price_daily enable row level security`;
}

/**
 * Reject a point whose move against its accepted predecessor is outside the
 * plausible band. Deliberately compared against the last ACCEPTED point, not
 * the immediately preceding day: one corrupt sample must not drag a healthy
 * neighbour out with it.
 */
function isPlausible(prev: DayPoint | undefined, point: DayPoint): boolean {
  if (!prev) return true;
  const span = Math.max(1, point.day - prev.day);
  const daily = Math.pow(point.price / prev.price, 1 / span);
  return daily >= MIN_DAILY_RATIO && daily <= MAX_DAILY_RATIO;
}

/** One simulated `get_snapshot_price(day)` read. Never signs or submits. */
async function readSnapshot(
  server: rpc.Server,
  source: Awaited<ReturnType<rpc.Server["getAccount"]>>,
  day: number,
): Promise<bigint> {
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(
      new Contract(RISK_VAULT_ID).call(
        "get_snapshot_price",
        nativeToScVal(BigInt(day), { type: "u64" }),
      ),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return 0n;
  return BigInt(scValToNative(sim.result.retval) ?? 0);
}

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const lookback = Math.max(1, Number(arg("days") ?? 30));

  if (!process.env.GOVERNANCE_DB_URL) {
    console.error("GOVERNANCE_DB_URL is not set — nothing to back fill into.");
    return 1;
  }

  const server = new rpc.Server(RPC_URL);
  const source = await server.getAccount(SIM_SOURCE);
  const today = Math.floor(Date.now() / 86_400_000);
  const from = today - lookback;

  console.log(
    `scanning on-chain snapshots for days ${from}..${today} ` +
      `(${new Date(from * 86_400_000).toISOString().slice(0, 10)} → ` +
      `${new Date(today * 86_400_000).toISOString().slice(0, 10)})`
  );

  // Read every day in the window. Days with no snapshot answer 0 — that is
  // "never recorded" or "aged past the 30-day TTL", both of which are simply
  // absent, not zero-valued.
  const found: DayPoint[] = [];
  for (let day = from; day <= today; day++) {
    let raw: bigint;
    try {
      raw = await readSnapshot(server, source, day);
    } catch (err) {
      console.warn(`  day ${day}: read failed, skipping — ${err}`);
      continue;
    }
    if (raw > 0n) found.push({ day, raw, price: Number(raw) / SCALE });
  }

  if (found.length === 0) {
    console.log("no on-chain snapshots in range — nothing to do.");
    return 0;
  }

  const accepted: DayPoint[] = [];
  const rejected: Array<{ point: DayPoint; reason: string }> = [];
  for (const point of found) {
    const prev = accepted[accepted.length - 1];
    if (isPlausible(prev, point)) accepted.push(point);
    else
      rejected.push({
        point,
        reason: `implausible vs day ${prev!.day} (${prev!.price.toFixed(6)} → ${point.price.toFixed(6)})`,
      });
  }

  console.log(`\nfound ${found.length} snapshot(s); accepting ${accepted.length}:`);
  for (const p of accepted) {
    console.log(
      `  day ${p.day}  ${new Date(p.day * 86_400_000).toISOString().slice(0, 10)}  ${p.price.toFixed(6)}`
    );
  }
  if (rejected.length > 0) {
    console.log(`\nSKIPPED ${rejected.length} implausible snapshot(s) — NOT imported:`);
    for (const r of rejected) {
      console.log(
        `  day ${r.point.day}  ${new Date(r.point.day * 86_400_000).toISOString().slice(0, 10)}  ` +
          `${r.point.price.toFixed(6)}  — ${r.reason}`
      );
    }
    console.log(
      "  (these stay on-chain and in the chart; they are excluded from the\n" +
        "   annualization series so one bad sample cannot become an endpoint)"
    );
  }

  if (!apply) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to upsert ${accepted.length} row(s).`);
    return 0;
  }

  const sql = getDb();
  await ensureTable(sql);
  let written = 0;
  for (const p of accepted) {
    await sql`
      insert into share_price_daily (day, share_price, source)
      values (${p.day}, ${p.raw.toString()}, 'onchain-snapshot')
      on conflict (day) do update
        set share_price = excluded.share_price,
            source      = excluded.source,
            recorded_at = now()
    `;
    written++;
  }
  console.log(`\nupserted ${written} row(s) into share_price_daily.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
