/**
 * Seed the route fleet on-chain — the 200 AeroAPI-discovered routes (plus
 * hand-seeded ones) from dapp/config/routes.testnet.json.
 *
 * IDEMPOTENT: safe to run any time. Per enabled route:
 *   - Unknown on-chain            → whitelist_route (overrides→Set terms,
 *                                   null→UseDefault: tracks module defaults)
 *   - Disabled but file-enabled   → enable_route
 *   - Active                      → no-op
 * File-disabled routes are never touched (governance may have its reasons).
 *
 * Prints a seeding table first (all the data each route is seeded with:
 * ident, carrier, pair, premium, payoff, delay threshold, term source),
 * then executes unless --dry-run.
 *
 * Run (from dapp/):
 *   npx tsx ../scripts/seed_routes.ts --dry-run        # table only
 *   npx tsx ../scripts/seed_routes.ts                  # seed on-chain
 *   npx tsx ../scripts/seed_routes.ts --table 50       # wider preview
 *
 * Signs with GOVERNANCE_ADMIN_SECRET_KEY (env), falling back to the local
 * `sentinel-governor` stellar identity.
 */

import { execFileSync } from "child_process";
import { loadDotEnv } from "../dapp/scripts/env";
import {
  loadRoutesConfig,
  fileTerms,
  baseUnitsToUsdc,
  usdcToBaseUnits,
  type RouteEntry,
} from "../dapp/api/_lib/routes_config";
import { GovSubmitter } from "../dapp/api/_lib/governance/submitter";

loadDotEnv();

const DRY_RUN = process.argv.includes("--dry-run");
const tableArg = process.argv.indexOf("--table");
const TABLE_ROWS = tableArg >= 0 ? Number(process.argv[tableArg + 1]) : 20;

function adminSecret(): string {
  if (process.env.GOVERNANCE_ADMIN_SECRET_KEY) return process.env.GOVERNANCE_ADMIN_SECRET_KEY;
  try {
    return execFileSync("stellar", ["keys", "show", "sentinel-governor"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      "No GOVERNANCE_ADMIN_SECRET_KEY in env and no local `sentinel-governor` identity."
    );
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

async function main(): Promise<void> {
  const cfg = loadRoutesConfig();
  const enabled = cfg.routes.filter((r) => r.enabled);
  const disabled = cfg.routes.filter((r) => !r.enabled);

  console.log(
    `Routes file: ${cfg.routes.length} route(s) — ${enabled.length} enabled, ` +
      `${disabled.length} file-disabled (untouched).`
  );
  console.log(
    `Defaults: premium $${cfg.defaults.premiumUsdc} / payoff $${cfg.defaults.payoffUsdc} / ` +
      `delay ${cfg.defaults.delayHours}h · rails $${baseUnitsToUsdc(cfg.rails.premiumMin)}–$${baseUnitsToUsdc(cfg.rails.premiumMax)}`
  );

  // ── Seeding table: exactly the data each route is seeded with ───────────
  console.log(`\nSeeding data (first ${Math.min(TABLE_ROWS, enabled.length)} of ${enabled.length}):\n`);
  console.log(
    pad("FLIGHT", 9) + pad("CARRIER", 9) + pad("ROUTE", 11) +
      pad("PREMIUM", 9) + pad("PAYOFF", 8) + pad("DELAY≥", 8) + "TERMS"
  );
  console.log("-".repeat(66));
  for (const r of enabled.slice(0, TABLE_ROWS)) {
    const t = fileTerms(cfg, r);
    const src = r.overrides ? "override (Set)" : "module defaults (UseDefault)";
    console.log(
      pad(r.flight_id, 9) +
        pad(r.carrier, 9) +
        pad(`${r.origin}→${r.destination}`, 11) +
        pad(`$${baseUnitsToUsdc(t.premium)}`, 9) +
        pad(`$${baseUnitsToUsdc(t.payoff)}`, 8) +
        pad(`${t.delayHours}h`, 8) +
        src
    );
  }
  if (enabled.length > TABLE_ROWS) console.log(`… ${enabled.length - TABLE_ROWS} more`);

  if (DRY_RUN) {
    console.log("\n--dry-run: no transactions submitted.");
    return;
  }

  // ── Idempotent on-chain seeding via the audited GovSubmitter ────────────
  const submitter = new GovSubmitter({
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    governanceId:
      process.env.GOVERNANCE_ID ?? "CANSHOFUFZPLZPCVUQYL3LBO25FW5BP6AEVAMNN2QS2BINGDIVZVEWYZ",
    adminSecretKey: adminSecret(),
    actor: "script:seed_routes",
  });

  let whitelisted = 0;
  let enabledCount = 0;
  let noop = 0;
  let failed = 0;
  console.log("\nSeeding on-chain (idempotent)...");
  for (const r of enabled) {
    const key = { flightId: r.flight_id, origin: r.origin, dest: r.destination };
    const label = `${r.flight_id} ${r.origin}→${r.destination}`;
    try {
      const onChain = await submitter.readStatus(key);
      if (onChain.status === "Active") {
        noop++;
      } else if (onChain.status === "Disabled") {
        await submitter.enable(key);
        console.log(`  ${label}: re-enabled`);
        enabledCount++;
      } else {
        await submitter.whitelist(
          key,
          overrideUnits(r, "premium_usdc"),
          overrideUnits(r, "payoff_usdc"),
          r.overrides?.delay_hours ?? null
        );
        console.log(`  ${label}: whitelisted`);
        whitelisted++;
      }
    } catch (err) {
      failed++;
      console.error(`  ${label}: FAILED — ${String(err).slice(0, 140)}`);
    }
  }
  console.log(
    `\nDone. whitelisted=${whitelisted} re-enabled=${enabledCount} ` +
      `already-active=${noop} failed=${failed}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

function overrideUnits(r: RouteEntry, field: "premium_usdc" | "payoff_usdc"): bigint | null {
  const v = r.overrides?.[field];
  return v != null ? usdcToBaseUnits(v) : null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
