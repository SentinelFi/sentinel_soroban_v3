/**
 * DESTRUCTIVE ADMIN SCRIPT — wipe ALL route data everywhere, for a
 * from-scratch re-intake through the manual pipeline:
 *
 *   1. ON-CHAIN: `remove_route` for every fleet-file entry that exists on
 *      the GovernanceModule (reads status first; Unknown → skip). Signed
 *      by the gov admin via the audited GovSubmitter.
 *   2. DB (if GOVERNANCE_DB_URL is set): clears the route-scoped tables —
 *      signals, premium_adjustments, pause_events, routes.
 *   3. JSON: fleet file `routes` → [] (defaults/rails preserved), catalog
 *      routes.discovered.json → [], staged route_whitelist.json deleted.
 *
 * Requires --yes. Run (from dapp/):
 *   npx tsx ../scripts/wipe_routes.ts --yes
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { loadDotEnv } from "../dapp/scripts/env";
loadDotEnv();
import { GovSubmitter } from "../dapp/api/_lib/governance/submitter";
import type { RouteEntry } from "../dapp/api/_lib/routes_config";

const FLEET_FILE = "config/routes.testnet.json";
const CATALOG_FILE = "config/routes.discovered.json";
const WHITELIST_FILE = "config/route_whitelist.json";

function adminSecret(): string {
  if (process.env.GOVERNANCE_ADMIN_SECRET_KEY) return process.env.GOVERNANCE_ADMIN_SECRET_KEY;
  return execFileSync("stellar", ["keys", "show", "sentinel-governor"], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  if (!process.argv.includes("--yes")) {
    console.error("This deletes ALL route data (on-chain, DB, JSON). Re-run with --yes.");
    process.exit(2);
  }

  // ── 1. On-chain removals (enumerate from the fleet file FIRST) ─────────
  const fleet = JSON.parse(readFileSync(FLEET_FILE, "utf8")) as { routes: RouteEntry[] };
  const submitter = new GovSubmitter({
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    governanceId: process.env.GOVERNANCE_ID ?? "CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE",
    adminSecretKey: adminSecret(),
    actor: "script:wipe_routes",
  });

  console.log(`[wipe] on-chain: checking ${fleet.routes.length} fleet-file route(s)...`);
  let removed = 0;
  let absent = 0;
  let failed = 0;
  for (const r of fleet.routes) {
    const key = { flightId: r.flight_id, origin: r.origin, dest: r.destination };
    try {
      const onChain = await submitter.readStatus(key);
      if (onChain.status === "Unknown") {
        absent++;
        continue;
      }
      // The contract enforces two-step removal (#508
      // RouteMustBeDisabledBeforeRemoval): a live sellable route must be
      // disabled before it can be removed.
      if (onChain.status === "Active") {
        await submitter.disable(key);
      }
      await submitter.remove(key);
      removed++;
      if (removed % 25 === 0) console.log(`[wipe] ${removed} removed...`);
    } catch (err) {
      failed++;
      console.error(`[wipe] ${r.flight_id} ${r.origin}→${r.destination}: FAILED — ${String(err).slice(0, 120)}`);
    }
  }
  console.log(`[wipe] on-chain done: removed=${removed} not-on-chain=${absent} failed=${failed}`);
  if (failed > 0) {
    // Keep the JSON enumeration intact so a re-run can retry the failures —
    // resetting the files while routes remain on-chain would orphan them.
    console.error(`[wipe] ${failed} on-chain removal(s) failed — DB/JSON left untouched; fix and re-run.`);
    process.exit(1);
  }

  // ── 2. DB wipe (route-scoped tables) ────────────────────────────────────
  if (process.env.GOVERNANCE_DB_URL) {
    const { getDb } = await import("../dapp/api/_lib/governance/db");
    const sql = getDb();
    for (const table of ["signals", "premium_adjustments", "pause_events", "routes"]) {
      const res = await sql.unsafe(`delete from ${table}`);
      console.log(`[wipe] db: ${table} cleared (${res.count} row(s))`);
    }
    await sql.end();
  } else {
    console.log("[wipe] db: GOVERNANCE_DB_URL not set — skipped");
  }

  // ── 3. JSON resets ──────────────────────────────────────────────────────
  const raw = JSON.parse(readFileSync(FLEET_FILE, "utf8")) as Record<string, unknown>;
  raw.routes = [];
  writeFileSync(FLEET_FILE, JSON.stringify(raw, null, 2) + "\n");
  writeFileSync(CATALOG_FILE, "[]\n");
  if (existsSync(WHITELIST_FILE)) unlinkSync(WHITELIST_FILE);
  console.log(`[wipe] json: ${FLEET_FILE} routes=[], ${CATALOG_FILE} emptied, ${WHITELIST_FILE} deleted`);

  console.log("\n[wipe] Done. Re-intake from scratch:");
  console.log("  npx tsx ../scripts/discover_routes.ts");
  console.log("  npx tsx ../scripts/price_routes.ts");
  console.log("  [ADMIN REVIEWS route_whitelist.json + SAYS GO]");
  console.log("  npx tsx ../scripts/seed_routes.ts");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
