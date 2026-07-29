/**
 * Route discovery — find insurable routes between airport sets using the
 * MINIMUM number of AeroAPI calls.
 *
 * The trick: /schedules/{ds}/{de}?origin=X&destination=Y returns EVERY
 * scheduled flight for a city pair in one call (include_codeshares=false →
 * operating flights only). So discovering the whole NYC × west/major matrix
 * costs one call per directed pair per sample day:
 *
 *   3 NYC airports × 5 destinations × 2 directions × 2 sample days
 *   = 60 calls (+ a page or two on busy pairs) → ~200-400 unique routes.
 *
 * Two sample days (a Tuesday and the following Saturday by default) filter
 * out one-off charters and catch day-of-week-only service; routes seen on
 * BOTH days rank first (daily-ish service = the good insurance inventory).
 *
 * Usage (from dapp/):
 *   npx tsx scripts/discover_routes.ts                 # defaults below
 *   npx tsx scripts/discover_routes.ts --date 2026-08-04 --max 200
 *   npx tsx scripts/discover_routes.ts --dry           # print, write nothing
 *   AEROAPI_BASE_URL=http://localhost:3001 npx tsx scripts/discover_routes.ts
 *
 * TWO-STEP GOVERNANCE INTAKE — this script is step 1 of 2, and each step
 * is idempotent (run either twice, nothing double-happens):
 *
 *   1. DISCOVER+ADD (this script): appends newly found routes into the
 *      governance-consumed JSON (config/routes.testnet.json, or
 *      ROUTES_CONFIG_PATH) as enabled RouteEntry rows. Routes already in
 *      the file are skipped, multi-leg idents the contract would reject
 *      are dropped — a re-run finds everything already present and writes
 *      nothing. The file is in git: review the append with `git diff`
 *      before step 2.
 *   2. WHITELIST (`npm run whitelist:routes`): pushes the file on-chain.
 *      Diffs against on-chain route_status first (Active → noop), and the
 *      contract treats a same-route re-whitelist as a no-op refresh.
 *
 * (gov_onboard's DB sync additionally picks the new file entries up as
 * reconciler-managed rows — 'candidate' until whitelisted, then 'active'.)
 */
import { readFileSync, writeFileSync } from "fs";
import { loadDotEnv } from "./env";
loadDotEnv(); // dapp/.env for local runs; real env vars always win
import { AeroApiClient } from "../api/_lib/aeroapi_client";
import { loadRoutesConfig, type RouteEntry } from "../api/_lib/routes_config";

const DEFAULT_ORIGINS = ["JFK", "EWR", "LGA"];
const DEFAULT_DESTINATIONS = ["SEA", "SFO", "LAX", "ORD", "MIA"];

export interface DiscoveredRoute {
  flight_id: string;
  carrier: string;
  origin: string;
  destination: string;
  /** How many of the sample days this route appeared on. */
  days_seen: number;
}

/** Ident must be airline designator + number (what the pipeline can attest). */
function parsableIdent(ident: string): { carrier: string } | null {
  const m = ident.match(/^([A-Z]{2,3})(\d{1,4})$/);
  return m ? { carrier: m[1] } : null;
}

/**
 * One /schedules call per (pair, day). Returns unique routes with day
 * counts. Exported for the E2E suite (runs against mock-aeroapi).
 */
export async function discoverRoutes(
  aero: AeroApiClient,
  origins: string[],
  destinations: string[],
  sampleDays: string[] // YYYY-MM-DD
): Promise<{ routes: DiscoveredRoute[]; apiCalls: number }> {
  const seen = new Map<string, DiscoveredRoute>();
  let apiCalls = 0;

  // Directed pairs, both directions.
  const pairs: Array<[string, string]> = [];
  for (const a of origins) {
    for (const b of destinations) {
      pairs.push([a, b], [b, a]);
    }
  }

  for (const [origin, destination] of pairs) {
    for (const day of sampleDays) {
      const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      apiCalls++;
      const resp = await aero.getSchedules(day, nextDay, {
        origin,
        destination,
        maxPages: 5, // busy pairs (JFK-LAX) run >15 rows/day
      });
      if (!resp) {
        console.warn(`[discover] ${origin}->${destination} ${day}: request failed (skipped)`);
        continue;
      }
      // Pace the sweep: 60 back-to-back max_pages=5 calls trip AeroAPI's
      // per-minute rate limit and the tail of the sweep silently fails
      // (observed 2026-07-29: dense pairs returned null while a lone
      // curl to the same endpoint succeeded). DISCOVER_PACE_MS=0 disables.
      await new Promise((r) => setTimeout(r, Number(process.env.DISCOVER_PACE_MS ?? 4000)));

      const dayIdents = new Set<string>();
      for (const row of resp.scheduled ?? []) {
        const ident = row.actual_ident ?? row.ident;
        const parsed = parsableIdent(ident);
        if (!parsed) continue; // registration-style / unattestable idents
        if (dayIdents.has(ident)) continue; // one count per day
        dayIdents.add(ident);

        const key = `${ident}|${origin}|${destination}`;
        const existing = seen.get(key);
        if (existing) {
          existing.days_seen++;
        } else {
          seen.set(key, {
            flight_id: ident,
            carrier: parsed.carrier,
            origin,
            destination,
            days_seen: 1,
          });
        }
      }
    }
  }

  // Rank: routes flying on more sample days first, then stable by ident.
  const routes = [...seen.values()].sort(
    (a, b) =>
      b.days_seen - a.days_seen ||
      a.origin.localeCompare(b.origin) ||
      a.destination.localeCompare(b.destination) ||
      a.flight_id.localeCompare(b.flight_id)
  );
  return { routes, apiCalls };
}

/**
 * Trim to `max` while preserving pair coverage: round-robin across pairs in
 * rank order so no city pair is starved by a busier one.
 */
export function trimBalanced(routes: DiscoveredRoute[], max: number): DiscoveredRoute[] {
  if (routes.length <= max) return routes;
  const byPair = new Map<string, DiscoveredRoute[]>();
  for (const r of routes) {
    const key = `${r.origin}|${r.destination}`;
    const list = byPair.get(key) ?? [];
    list.push(r);
    byPair.set(key, list);
  }
  const out: DiscoveredRoute[] = [];
  let added = true;
  while (out.length < max && added) {
    added = false;
    for (const list of byPair.values()) {
      if (out.length >= max) break;
      const next = list.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

function nextWeekday(from: Date, weekday: number): string {
  // weekday: 0=Sun..6=Sat (UTC). Always strictly in the future.
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + (((weekday - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const max = Number(getArg("max") ?? 200);
  const dry = args.includes("--dry");
  // The governance-consumed routes JSON — the same file whitelist:routes
  // and gov_onboard read. ROUTES_CONFIG_PATH overrides (tests/networks).
  const routesFile = process.env.ROUTES_CONFIG_PATH ?? "config/routes.testnet.json";
  // Sample a Tuesday + the following Saturday (~1-2 weeks out: inside
  // /schedules' 1-year visibility, far enough out to be a normal week).
  const baseDate = getArg("date");
  const tuesday = baseDate ?? nextWeekday(new Date(), 2);
  const saturday = nextWeekday(new Date(Date.parse(`${tuesday}T00:00:00Z`)), 6);
  const sampleDays = [tuesday, saturday];

  const origins = (getArg("origins") ?? DEFAULT_ORIGINS.join(",")).split(",");
  const destinations = (getArg("destinations") ?? DEFAULT_DESTINATIONS.join(",")).split(",");

  const aero = new AeroApiClient({
    aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "https://aeroapi.flightaware.com/aeroapi",
    aeroApiKey: process.env.AEROAPI_KEY ?? "",
  });

  console.log(
    `[discover] ${origins.join("/")} <-> ${destinations.join("/")} on ${sampleDays.join(" + ")}`
  );
  const { routes: found, apiCalls } = await discoverRoutes(aero, origins, destinations, sampleDays);

  // Idempotency, layer 1 of 3 — the whole discover → merge → whitelist loop
  // is safe to re-run:
  //   1. here: routes already in the routes file are skipped (no duplicate
  //      merge entries), and conflicting idents are surfaced early;
  //   2. whitelist_routes.ts diffs on-chain first (Active → noop);
  //   3. the contract treats re-whitelisting the same route as an
  //      idempotent refresh (only a CONFLICTING origin/dest panics).
  const existing = loadRoutesConfig().routes;
  const existingByIdent = new Map(existing.map((r) => [r.flight_id, r]));

  // The contract maps each flight_id to exactly ONE (origin, dest) —
  // multi-leg flight numbers (same ident, second pair) cannot be
  // whitelisted and are dropped with a warning, keeping the first-ranked
  // pair. Same rule against the existing routes file.
  const routes: DiscoveredRoute[] = [];
  let known = 0;
  const seenIdent = new Map<string, DiscoveredRoute>();
  for (const r of found) {
    const ex = existingByIdent.get(r.flight_id);
    if (ex) {
      if (ex.origin === r.origin && ex.destination === r.destination) {
        known++; // already in the routes file — nothing to add
      } else {
        console.warn(
          `[discover] ${r.flight_id}: already mapped to ${ex.origin}->${ex.destination} ` +
            `in the routes file — ${r.origin}->${r.destination} would be rejected on-chain ` +
            `(FlightIdAlreadyMapped). Skipping.`
        );
      }
      continue;
    }
    const dup = seenIdent.get(r.flight_id);
    if (dup) {
      console.warn(
        `[discover] ${r.flight_id}: flies ${dup.origin}->${dup.destination} AND ` +
          `${r.origin}->${r.destination} (multi-leg flight number) — keeping the ` +
          `first, the contract allows one route per flight_id.`
      );
      continue;
    }
    seenIdent.set(r.flight_id, r);
    routes.push(r);
  }
  if (known > 0) {
    console.log(`[discover] ${known} route(s) already in the routes file — skipped (idempotent re-run).`);
  }

  const trimmed = trimBalanced(routes, max);

  // Pair summary.
  const pairCounts = new Map<string, number>();
  for (const r of trimmed) {
    const key = `${r.origin}->${r.destination}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  console.log(
    `\n[discover] ${found.length} unique routes found with ${apiCalls} API call(s); ` +
      `${routes.length} new; keeping ${trimmed.length}:`
  );
  for (const [pair, n] of [...pairCounts.entries()].sort()) {
    console.log(`  ${pair}: ${n}`);
  }

  const entries: RouteEntry[] = trimmed.map((r) => ({
    flight_id: r.flight_id,
    carrier: r.carrier,
    origin: r.origin,
    destination: r.destination,
    enabled: true,
    overrides: null,
    notes: `discovered ${sampleDays.join("+")} (days_seen=${r.days_seen})`,
  }));

  if (entries.length === 0) {
    console.log(`\n[discover] Nothing new to add — ${routesFile} already covers everything found (idempotent re-run).`);
    return;
  }

  if (dry) {
    console.log(`\n[discover] --dry: would append ${entries.length} route(s) to ${routesFile}:`);
    for (const e of entries) console.log(`  ${e.flight_id} ${e.origin}->${e.destination}`);
    return;
  }

  // Step 1 of 2: APPEND into the governance-consumed JSON, preserving
  // everything else in the file (defaults, rails, horizon, existing
  // routes, key order). Whitelisting is deliberately the separate step 2.
  const raw = JSON.parse(readFileSync(routesFile, "utf8")) as { routes: RouteEntry[] };
  raw.routes = [...raw.routes, ...entries];
  writeFileSync(routesFile, JSON.stringify(raw, null, 2) + "\n");
  console.log(
    `\n[discover] Appended ${entries.length} route entrie(s) to ${routesFile} ` +
      `(${raw.routes.length} total).\n` +
      `Next step (separate + idempotent):\n` +
      `  git diff ${routesFile}        # review the append\n` +
      `  npm run whitelist:routes      # push on-chain (Active routes no-op)`
  );
}

// Only run as a CLI (the E2E suite imports the functions above).
if (process.argv[1] && process.argv[1].endsWith("discover_routes.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
