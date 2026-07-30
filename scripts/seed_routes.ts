/**
 * STEP 3 of the admin route-intake pipeline — RUN ONLY AFTER THE ADMIN
 * HAS REVIEWED config/route_whitelist.json AND SAID GO:
 *
 *   discover_routes  →  price_routes  →  [ADMIN REVIEWS + SAYS GO]  →  seed_routes
 *
 * Reads the staged, ML-priced whitelist (route_whitelist.json) and seeds
 * each route on-chain via the audited GovSubmitter with its EXPLICIT
 * terms (Set premium / Set payoff / Set delay — not module defaults), so
 * what the admin reviewed is exactly what the chain gets.
 *
 * IDEMPOTENT, per route:
 *   - Unknown on-chain  → whitelist_route with the staged terms
 *   - Active            → no-op (terms drift is REPORTED, not auto-fixed).
 *                         With --apply-terms, drifted routes are UPDATED to
 *                         the staged terms instead — the monthly repricing
 *                         ritual (an explicit admin decision, hence a flag)
 *   - Disabled          → skipped (governance disabled it for a reason)
 *
 * Successfully seeded routes are merged into the operational fleet file
 * (dapp/config/routes.testnet.json — what the authorizer and jobs read),
 * with overrides mirroring the on-chain terms.
 *
 * Run (from dapp/):
 *   npx tsx ../scripts/seed_routes.ts --dry-run       # table only, no txs
 *   npx tsx ../scripts/seed_routes.ts                 # seed on-chain
 *   npx tsx ../scripts/seed_routes.ts --apply-terms   # + reprice drifted live routes
 *
 * Signs with GOVERNANCE_ADMIN_SECRET_KEY (env), falling back to the local
 * `sentinel-governor` stellar identity.
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { loadDotEnv } from "../dapp/scripts/env";
loadDotEnv();
import { GovSubmitter } from "../dapp/api/_lib/governance/submitter";
import { usdcToBaseUnits, type RouteEntry } from "../dapp/api/_lib/routes_config";

const WHITELIST_FILE = "config/route_whitelist.json";
const FLEET_FILE = "config/routes.testnet.json";

interface StagedRoute {
  flight_id: string;
  carrier: string;
  carrier_name: string;
  origin: string;
  destination: string;
  dep_time_hhmm: number;
  distance_mi: number;
  p_covered: number;
  premium_usdc: number;
  payoff_usdc: number;
  delay_hours: number;
}

interface StagedWhitelist {
  generated_at: string;
  model_version: string;
  routes: StagedRoute[];
}

function adminSecret(): string {
  if (process.env.GOVERNANCE_ADMIN_SECRET_KEY) return process.env.GOVERNANCE_ADMIN_SECRET_KEY;
  try {
    return execFileSync("stellar", ["keys", "show", "sentinel-governor"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No GOVERNANCE_ADMIN_SECRET_KEY in env and no local `sentinel-governor` identity.");
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const applyTerms = process.argv.includes("--apply-terms");
  const staged = JSON.parse(readFileSync(WHITELIST_FILE, "utf8")) as StagedWhitelist;

  console.log(
    `Staged whitelist: ${staged.routes.length} route(s), generated ${staged.generated_at} ` +
      `(model ${staged.model_version})`
  );
  console.log(`\nFirst 20 (of ${staged.routes.length}):\n`);
  console.log(
    pad("FLIGHT", 9) + pad("CARRIER", 11) + pad("ROUTE", 11) + pad("DEP", 6) +
      pad("P(COV)", 9) + pad("PREMIUM", 9) + pad("PAYOFF", 8) + "DELAY≥"
  );
  console.log("-".repeat(70));
  for (const r of staged.routes.slice(0, 20)) {
    console.log(
      pad(r.flight_id, 9) + pad(r.carrier_name, 11) + pad(`${r.origin}→${r.destination}`, 11) +
        pad(String(r.dep_time_hhmm).padStart(4, "0"), 6) + pad(r.p_covered.toFixed(4), 9) +
        pad(`$${r.premium_usdc}`, 9) + pad(`$${r.payoff_usdc}`, 8) + `${r.delay_hours}h`
    );
  }
  if (staged.routes.length > 20) console.log(`… ${staged.routes.length - 20} more`);

  if (dryRun) {
    console.log("\n--dry-run: no transactions submitted.");
    return;
  }

  const submitter = new GovSubmitter({
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    governanceId: process.env.GOVERNANCE_ID ?? "CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE",
    adminSecretKey: adminSecret(),
    actor: "script:seed_routes",
  });

  let whitelisted = 0;
  let noop = 0;
  let drift = 0;
  let applied = 0;
  let disabled = 0;
  let failed = 0;
  const seeded: StagedRoute[] = [];
  console.log("\nSeeding on-chain (idempotent)...");
  for (const r of staged.routes) {
    const key = { flightId: r.flight_id, origin: r.origin, dest: r.destination };
    const label = `${r.flight_id} ${r.origin}→${r.destination}`;
    try {
      const onChain = await submitter.readStatus(key);
      if (onChain.status === "Active") {
        const t = onChain.terms;
        const stagedPremium = usdcToBaseUnits(r.premium_usdc);
        if (t && (t.premium !== stagedPremium || t.payoff !== usdcToBaseUnits(r.payoff_usdc))) {
          if (applyTerms) {
            await submitter.updateTerms(key, stagedPremium, usdcToBaseUnits(r.payoff_usdc), r.delay_hours);
            console.log(
              `  ${label}: terms applied — $${Number(t.premium) / 1e7}/$${Number(t.payoff) / 1e7} → ` +
                `$${r.premium_usdc}/$${r.payoff_usdc} (--apply-terms)`
            );
            applied++;
          } else {
            console.warn(
              `  ${label}: active with DIFFERENT terms on-chain — staged $${r.premium_usdc}/$${r.payoff_usdc}, ` +
                `live $${Number(t.premium) / 1e7}/$${Number(t.payoff) / 1e7}. Repricing live routes is a ` +
                `governance decision — re-run with --apply-terms to apply.`
            );
            drift++;
          }
        } else {
          noop++;
        }
        seeded.push(r); // ensure the fleet file covers it either way
      } else if (onChain.status === "Disabled") {
        console.log(`  ${label}: Disabled on-chain — governance decision, skipped.`);
        disabled++;
      } else {
        await submitter.whitelist(
          key,
          usdcToBaseUnits(r.premium_usdc),
          usdcToBaseUnits(r.payoff_usdc),
          r.delay_hours
        );
        console.log(`  ${label}: whitelisted @ $${r.premium_usdc}/$${r.payoff_usdc}/${r.delay_hours}h`);
        whitelisted++;
        seeded.push(r);
      }
    } catch (err) {
      failed++;
      console.error(`  ${label}: FAILED — ${String(err).slice(0, 140)}`);
    }
  }

  // Mirror seeded routes into the operational fleet file (authorizer/jobs).
  const fleet = JSON.parse(readFileSync(FLEET_FILE, "utf8")) as { routes: RouteEntry[] };
  const byFleetKey = new Map(fleet.routes.map((f) => [`${f.flight_id}|${f.origin}|${f.destination}`, f]));
  const known = new Set(byFleetKey.keys());
  let appended = 0;
  let mirrored = 0;
  for (const r of seeded) {
    const k = `${r.flight_id}|${r.origin}|${r.destination}`;
    if (known.has(k)) {
      // --apply-terms repriced live routes on-chain — keep the fleet file
      // (the base the weather job builds on) in lockstep.
      if (applyTerms) {
        const entry = byFleetKey.get(k)!;
        const o: import("../dapp/api/_lib/routes_config").RouteTermsOverride = entry.overrides ?? {};
        if (
          o.premium_usdc !== r.premium_usdc ||
          o.payoff_usdc !== r.payoff_usdc ||
          o.delay_hours !== r.delay_hours
        ) {
          entry.overrides = {
            premium_usdc: r.premium_usdc,
            payoff_usdc: r.payoff_usdc,
            delay_hours: r.delay_hours,
          };
          mirrored++;
        }
      }
      continue;
    }
    fleet.routes.push({
      flight_id: r.flight_id,
      carrier: r.carrier,
      origin: r.origin,
      destination: r.destination,
      enabled: true,
      overrides: {
        premium_usdc: r.premium_usdc,
        payoff_usdc: r.payoff_usdc,
        delay_hours: r.delay_hours,
      },
      notes: `seeded ${new Date().toISOString().slice(0, 10)} (ML-priced, model ${staged.model_version})`,
    });
    known.add(k);
    appended++;
  }
  if (appended > 0 || mirrored > 0) writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2) + "\n");

  console.log(
    `\nDone. whitelisted=${whitelisted} already-active=${noop} terms-drift=${drift} ` +
      `terms-applied=${applied} disabled-skipped=${disabled} failed=${failed}; ` +
      `fleet file +${appended} new, ${mirrored} override(s) synced (${FLEET_FILE})`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
