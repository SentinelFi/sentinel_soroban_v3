import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  Account,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { getDb } from "../_lib/governance/db.js";
import { loadPublicConfig } from "../_lib/config.js";

/**
 * Admin API — the USER overview board.
 *
 * Who is actually using the protocol? Two populations, two sources:
 *
 *   policy holders — the DURABLE `policies` event mirror (buyer, premium,
 *     payoff per purchase). Unique buyers, totals, top-5 by premium spent.
 *
 *   underwriters — the chain has no way to enumerate share holders, so
 *     this is honest best-effort: vault totals (total shares / assets),
 *     both queues (addresses currently waiting), and share balances
 *     probed across every address the protocol has SEEN (policy buyers +
 *     queued LPs, capped). An LP that never bought a policy and is not
 *     queued right now will not appear in top positions — the response
 *     carries the probe counts so the UI can say so.
 *
 * Read-only: every chain call is a simulation; nothing is signed.
 * DB-optional: without GOVERNANCE_DB_URL the buyer half is null and the
 * probe candidates shrink to the queues.
 *
 * GET → { policy_holders, vault, as_of }
 */

export const config = { maxDuration: 60 };

const PROBE_CAP = 200; // max candidate addresses to balance-probe
const PROBE_CONCURRENCY = 6;
const TOP_N = 5;

// Any funded account works as a read-simulation source; the protocol
// owner is a stable public default (deployments/testnet.json).
const SIM_SOURCE =
  process.env.CONTRACT_OWNER_ADDRESS ??
  "GCEODBNVUGJVYQKWY7NMU4U3EIYQOXA7LADMQOPNB5PBBKMYCQJ7E6KD";

interface TopBuyer {
  buyer: string;
  policies: number;
  premium_units: string;
  payoff_units: string;
  last_at: string;
}

interface TopPosition {
  address: string;
  /** RVS shares (10 decimals), as a decimal string */
  shares: string;
  /** current USDC value of those shares (7 decimals), as a decimal string */
  assets_units: string;
}

async function simulateRead(
  server: rpc.Server,
  passphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(SIM_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error.slice(0, 200));
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
}

/** Bounded-concurrency map — same shape the frontend batch hook uses. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (i >= items.length || item === undefined) return;
        out[i] = await fn(item);
      }
    })
  );
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const pub = loadPublicConfig();
    const server = new rpc.Server(pub.rpcUrl);
    const read = (contract: string, method: string, args: xdr.ScVal[] = []) =>
      simulateRead(server, pub.network, contract, method, args);
    const vaultId = pub.contractIds.riskVault;

    // ── policy holders (DB mirror) ─────────────────────────────────
    let policyHolders: {
      unique_buyers: number;
      policies: number;
      premium_units_total: string;
      payoff_units_total: string;
      top: TopBuyer[];
    } | null = null;
    let buyerAddresses: string[] = [];
    if (process.env.GOVERNANCE_DB_URL) {
      const sql = getDb();
      const totalsRows = (await sql`
        select count(distinct buyer)::int as unique_buyers,
               count(*)::int as policies,
               coalesce(sum(premium_units), 0)::text as premium_units_total,
               coalesce(sum(payoff_units), 0)::text as payoff_units_total
        from policies
      `) as unknown as Array<{
        unique_buyers: number;
        policies: number;
        premium_units_total: string;
        payoff_units_total: string;
      }>;
      const totals = totalsRows[0] ?? {
        unique_buyers: 0,
        policies: 0,
        premium_units_total: "0",
        payoff_units_total: "0",
      };
      const top = (await sql`
        select buyer,
               count(*)::int as policies,
               coalesce(sum(premium_units), 0)::text as premium_units,
               coalesce(sum(payoff_units), 0)::text as payoff_units,
               max(bought_at)::text as last_at
        from policies
        group by buyer
        order by sum(premium_units) desc nulls last
        limit ${TOP_N}
      `) as unknown as TopBuyer[];
      const buyers = (await sql`
        select distinct buyer from policies limit ${PROBE_CAP}
      `) as unknown as Array<{ buyer: string }>;
      buyerAddresses = buyers.map((b) => b.buyer);
      policyHolders = { ...totals, top };
    }

    // ── vault (chain) ──────────────────────────────────────────────
    const [totalShares, totalAssets, depositQueue, withdrawalQueue] = await Promise.all([
      read(vaultId, "total_supply"),
      read(vaultId, "total_assets"),
      read(vaultId, "get_deposit_queue"),
      read(vaultId, "get_withdrawal_queue"),
    ]);
    const deposits = (depositQueue ?? []) as Array<{ owner: string; assets: bigint }>;
    const withdrawals = (withdrawalQueue ?? []) as Array<{ owner: string; shares: bigint }>;

    // share-balance probe across every address the protocol has seen
    const candidates = [
      ...new Set([
        ...buyerAddresses,
        ...deposits.map((d) => d.owner),
        ...withdrawals.map((w) => w.owner),
      ]),
    ].slice(0, PROBE_CAP);
    const balances = await mapLimited(candidates, PROBE_CONCURRENCY, async (address) => {
      try {
        const shares = (await read(vaultId, "balance", [
          nativeToScVal(address, { type: "address" }),
        ])) as bigint;
        return { address, shares };
      } catch {
        return { address, shares: 0n };
      }
    });
    const holders = balances
      .filter((b) => b.shares > 0n)
      .sort((a, b) => (b.shares > a.shares ? 1 : b.shares < a.shares ? -1 : 0));
    const topPositions: TopPosition[] = await mapLimited(
      holders.slice(0, TOP_N),
      PROBE_CONCURRENCY,
      async (h) => {
        let assets = 0n;
        try {
          assets = (await read(vaultId, "convert_to_assets", [
            nativeToScVal(h.shares, { type: "i128" }),
          ])) as bigint;
        } catch {
          /* value display only — leave 0 */
        }
        return { address: h.address, shares: String(h.shares), assets_units: String(assets) };
      }
    );

    res.status(200).json({
      policy_holders: policyHolders,
      vault: {
        total_shares: String(totalShares ?? 0n),
        total_assets: String(totalAssets ?? 0n),
        deposit_queue: {
          count: deposits.length,
          assets_units_total: String(deposits.reduce((s, d) => s + BigInt(d.assets ?? 0n), 0n)),
          unique_owners: new Set(deposits.map((d) => d.owner)).size,
        },
        withdrawal_queue: {
          count: withdrawals.length,
          shares_total: String(withdrawals.reduce((s, w) => s + BigInt(w.shares ?? 0n), 0n)),
          unique_owners: new Set(withdrawals.map((w) => w.owner)).size,
        },
        top_positions: topPositions,
        holders_probed: candidates.length,
        holders_with_shares: holders.length,
      },
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
