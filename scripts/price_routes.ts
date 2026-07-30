/**
 * STEP 2 of the admin route-intake pipeline:
 *
 *   discover_routes  →  price_routes  →  [ADMIN REVIEWS + SAYS GO]  →  seed_routes
 *
 * Reads EVERY candidate from the deduped catalog
 * (dapp/config/routes.discovered.json), prices each with the DEPLOYED ML
 * prediction service (flight-delay-predictions on Render), and writes the
 * reviewable staging file dapp/config/route_whitelist.json:
 *
 *   p_covered   = live POST /predict (real dep time, great-circle distance)
 *   premium     = p_covered × payoff × 1.3, rounded UP to whole dollars,
 *                 floored at $10; above the $20 base cap the route is
 *                 EXCLUDED (listed in the file + run log, never clamped)
 *   payoff      = $100 (fixed product term)
 *   delay_hours = 3
 *
 * Each run is logged to the pricing_runs DB table when GOVERNANCE_DB_URL
 * is set (excluded routes, premium distribution) — same trail the monthly
 * advisory reprice cron writes to.
 *
 * NOTHING goes on-chain here. The admin reviews route_whitelist.json
 * (git diff / the printed table) and only then runs seed_routes.
 *
 * Run (from dapp/):
 *   npx tsx ../scripts/price_routes.ts                # price all candidates
 *   npx tsx ../scripts/price_routes.ts --date 2026-08-12   # price for a date
 */

import { readFileSync, writeFileSync } from "fs";
import { loadDotEnv } from "../dapp/scripts/env";
loadDotEnv();
import { AgentClient } from "../dapp/api/_lib/agent_client";
import { expectedLossPremiumUnits, mlBasePremiumUnits } from "../dapp/api/_lib/route_rules";
import { logPricingRun } from "../dapp/api/_lib/governance/pricing_log";
import { loadRoutesConfig, baseUnitsToUsdc } from "../dapp/api/_lib/routes_config";
import { AIRPORTS } from "../dapp/api/_lib/airports";
import { distanceMiles } from "../dapp/api/_lib/airports";
import { toIata } from "../dapp/api/_lib/airline_codes";
import type { CatalogEntry } from "./discover_routes";

const CATALOG_FILE = "config/routes.discovered.json";
const WHITELIST_FILE = "config/route_whitelist.json";
const ML_BASE = process.env.AGENT_BASE_URL ?? "https://flight-delay-predictions.onrender.com";

const PAYOFF_USDC = 100; // fixed product term
const DELAY_HOURS = 3;
const PAYOFF_UNITS = 1_000_000_000n; // 7 decimals

// The model's DepTime is LOCAL HHMM (BTS convention); the catalog stores
// scheduled_out in UTC. IANA zones for every airport in the matrix.
const AIRPORT_TZ: Record<string, string> = {
  JFK: "America/New_York", EWR: "America/New_York", LGA: "America/New_York",
  BOS: "America/New_York", PHL: "America/New_York", MIA: "America/New_York",
  ORD: "America/Chicago", DFW: "America/Chicago", IAH: "America/Chicago",
  SEA: "America/Los_Angeles", PDX: "America/Los_Angeles",
  SFO: "America/Los_Angeles", LAX: "America/Los_Angeles", LAS: "America/Los_Angeles",
};

function localDepHhmm(schedOutUtc: string | null, origin: string): number {
  if (!schedOutUtc) return 1200; // model default: noon
  const tz = AIRPORT_TZ[origin];
  if (!tz) return 1200;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(schedOutUtc));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 12) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 100 + m;
}

function routeDistanceMi(origin: string, destination: string): number {
  const a = AIRPORTS[origin];
  const b = AIRPORTS[destination];
  return a && b ? Math.round(distanceMiles(a, b)) : 1000; // model default
}

async function fetchModelVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${ML_BASE}/healthz`, { signal: AbortSignal.timeout(15_000) });
    if (r.ok) return ((await r.json()) as { model_version: string }).model_version;
  } catch {
    /* unreachable */
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dateArg = args.indexOf("--date");
  // Price for a representative date ~2 weeks out unless told otherwise.
  const forDate = dateArg >= 0
    ? new Date(Date.parse(`${args[dateArg + 1]}T12:00:00Z`))
    : new Date(Date.now() + 14 * 86_400_000);
  const month = forDate.getUTCMonth() + 1;
  const dayOfMonth = forDate.getUTCDate();
  const dayOfWeek = ((forDate.getUTCDay() + 6) % 7) + 1; // Mon=1..Sun=7

  const catalog = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as CatalogEntry[];
  const rails = loadRoutesConfig().rails;
  console.log(
    `[price] ${catalog.length} candidate(s) from ${CATALOG_FILE}; ` +
      `pricing for ${forDate.toISOString().slice(0, 10)} via ${ML_BASE}`
  );

  const modelVersion = await fetchModelVersion();
  if (!modelVersion) {
    console.error("[price] ML service unreachable — aborting (nothing written).");
    process.exit(1);
  }
  console.log(`[price] model: ${modelVersion}`);

  const agent = new AgentClient(ML_BASE, process.env.AGENT_TOKEN || undefined);
  const routes: Array<Record<string, unknown>> = [];
  const excluded: Array<{ flight_id: string; origin: string; dest: string; p_covered: number; honest_premium_usdc: number }> = [];
  let failed = 0;
  for (const [i, c] of catalog.entries()) {
    // The model only knows IATA carrier codes; the catalog stores IATA,
    // but normalize anyway so a legacy ICAO entry can't silently price
    // as "unknown carrier". Untracked = upstream bug → count as failed.
    const iata = toIata(c.carrier);
    if (!iata) {
      console.error(`[price] ${c.flight_id}: untracked carrier code "${c.carrier}" — skipped`);
      failed++;
      continue;
    }
    const dep = localDepHhmm(c.sched_out_utc, c.origin);
    const dist = routeDistanceMi(c.origin, c.destination);
    const p = await agent.predict(
      {
        carrier: iata,
        origin: c.origin,
        dest: c.destination,
        month,
        day_of_month: dayOfMonth,
        day_of_week: dayOfWeek,
        dep_time_hhmm: dep,
        distance_mi: dist,
      },
      c.flight_id
    );
    if (p === null) {
      failed++;
      continue; // reported in summary; rerun re-prices idempotently
    }
    // Whole-dollar base premium capped at rails.basePremiumMax; above the
    // cap the route is EXCLUDED (never clamped) — we don't sell routes at
    // a known expected loss. Excluded routes go in the run log + review.
    const premiumUnits = mlBasePremiumUnits(p, PAYOFF_UNITS, rails);
    if (premiumUnits === null) {
      excluded.push({
        flight_id: c.flight_id,
        origin: c.origin,
        dest: c.destination,
        p_covered: Number(p.toFixed(5)),
        honest_premium_usdc: Number(baseUnitsToUsdc(expectedLossPremiumUnits(p, PAYOFF_UNITS)).toFixed(2)),
      });
      continue;
    }
    routes.push({
      flight_id: c.flight_id,
      carrier: iata,
      carrier_name: c.carrier_name,
      origin: c.origin,
      destination: c.destination,
      dep_time_hhmm: dep,
      distance_mi: dist,
      days_seen: c.days_seen,
      p_covered: Number(p.toFixed(5)),
      premium_usdc: baseUnitsToUsdc(premiumUnits),
      payoff_usdc: PAYOFF_USDC,
      delay_hours: DELAY_HOURS,
    });
    if ((i + 1) % 100 === 0) console.log(`[price] ${i + 1}/${catalog.length}...`);
  }

  routes.sort((a, b) =>
    `${a.origin}|${a.destination}|${a.flight_id}`.localeCompare(`${b.origin}|${b.destination}|${b.flight_id}`)
  );
  const out = {
    $schema_note:
      "STAGED route whitelist — generated by scripts/price_routes.ts, reviewed by the admin, seeded on-chain by scripts/seed_routes.ts. Regenerating overwrites; nothing here is live until seeded. 'excluded' routes priced above the base cap and are NOT seeded.",
    generated_at: new Date().toISOString(),
    priced_for_date: forDate.toISOString().slice(0, 10),
    model_version: modelVersion,
    payoff_usdc: PAYOFF_USDC,
    delay_hours: DELAY_HOURS,
    rails: {
      premium_min_usdc: baseUnitsToUsdc(rails.premiumMin),
      base_premium_max_usdc: baseUnitsToUsdc(rails.basePremiumMax),
      premium_max_usdc: baseUnitsToUsdc(rails.premiumMax),
    },
    excluded,
    routes,
  };
  writeFileSync(WHITELIST_FILE, JSON.stringify(out, null, 2) + "\n");

  // Review summary.
  const byPremium = new Map<number, number>();
  for (const r of routes) {
    byPremium.set(r.premium_usdc as number, (byPremium.get(r.premium_usdc as number) ?? 0) + 1);
  }
  console.log(`\n[price] ${routes.length} route(s) priced → ${WHITELIST_FILE} (${failed} failed — rerun to fill)`);
  console.log("[price] premium distribution (whole dollars):");
  for (const [prem, n] of [...byPremium.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  $${prem}: ${n} route(s)`);
  }
  if (excluded.length > 0) {
    console.log(`\n[price] EXCLUDED — honest price above the $${baseUnitsToUsdc(rails.basePremiumMax)} base cap (NOT whitelisted):`);
    for (const e of excluded.sort((a, b) => b.p_covered - a.p_covered)) {
      console.log(`  ${e.flight_id} ${e.origin}→${e.dest}: p=${(e.p_covered * 100).toFixed(1)}% → $${e.honest_premium_usdc}`);
    }
  }

  await logPricingRun({
    context: "manual:price_routes",
    model_version: modelVersion,
    priced_for_date: forDate.toISOString().slice(0, 10),
    total_candidates: catalog.length,
    priced: routes.length,
    failed,
    excluded,
    summary: { premium_distribution: Object.fromEntries([...byPremium.entries()].sort((a, b) => a[0] - b[0])) },
  });

  console.log("\nADMIN REVIEW: inspect config/route_whitelist.json (git diff). When approved:");
  console.log("  npx tsx ../scripts/seed_routes.ts --dry-run   # final look");
  console.log("  npx tsx ../scripts/seed_routes.ts             # seed on-chain");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
