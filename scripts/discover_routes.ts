/**
 * STEP 1 of the admin route-intake pipeline (see scripts/README.md):
 *
 *   discover_routes  →  price_routes  →  [ADMIN REVIEWS + SAYS GO]  →  seed_routes
 *
 * Run MANUALLY by an admin, ad hoc — nothing schedules this, and route
 * intake is deliberately NOT automated (no cron, no auto-promote).
 *
 * Sweeps the directed city-pair matrix via real AeroAPI /schedules and
 * merges every eligible flight into the deduped catalog
 * dapp/config/routes.discovered.json. Eligibility is a HARD filter:
 *
 *   - attestable ident only — airline-code + number (e.g. AAL1152);
 *     registration-style / charter idents are dropped (the oracle can't
 *     track what it can't query);
 *   - operating mainline flights only (no codeshares, no regional
 *     partners — API-level filters);
 *   - TRACKED CARRIERS ONLY: American, Delta, United, Alaska, Southwest,
 *     JetBlue, Frontier, Spirit, Hawaiian. Everything else is ignored.
 *
 * The catalog is UNCAPPED and never discards: re-runs merge (dedupe on
 * flight_id|origin|dest), updating last_seen/days_seen. This script does
 * NOT touch the fleet file (routes.testnet.json) and does NOT compute
 * terms — pricing is step 2, seeding (after the admin's go) is step 3.
 *
 * Run (from dapp/):
 *   npx tsx ../scripts/discover_routes.ts                  # full sweep
 *   npx tsx ../scripts/discover_routes.ts --date 2026-08-12
 *   npx tsx ../scripts/discover_routes.ts --dry            # sweep, write nothing
 */

import { readFileSync, writeFileSync } from "fs";
import { loadDotEnv } from "../dapp/scripts/env";
loadDotEnv();
import { AeroApiClient } from "../dapp/api/_lib/aeroapi_client";

// ── Tracked carriers (the ONLY airlines we insure) ─────────────────────────
// ICAO operating codes as returned by /schedules idents, with IATA
// equivalents accepted defensively.
const TRACKED_CARRIERS: Record<string, string> = {
  AAL: "American", AA: "American",
  DAL: "Delta", DL: "Delta",
  UAL: "United", UA: "United",
  ASA: "Alaska", AS: "Alaska",
  SWA: "Southwest", WN: "Southwest",
  JBU: "JetBlue", B6: "JetBlue",
  FFT: "Frontier", F9: "Frontier",
  NKS: "Spirit", NK: "Spirit",
  HAL: "Hawaiian", HA: "Hawaiian",
};

// ── The directed pair matrix ───────────────────────────────────────────────
const NYC = ["JFK", "EWR", "LGA"];
const NYC_DESTS = ["SEA", "SFO", "LAX", "ORD", "MIA"];
const MESH_PAIRS: Array<[string, string]> = [
  ["BOS", "ORD"], ["BOS", "LAX"], ["BOS", "SFO"], ["BOS", "MIA"], ["BOS", "PHL"],
  ["PHL", "ORD"], ["PHL", "MIA"], ["PHL", "LAX"], ["PHL", "DFW"],
  ["LAS", "LAX"], ["LAS", "SFO"], ["LAS", "SEA"], ["LAS", "ORD"], ["LAS", "DFW"],
  ["PDX", "SEA"], ["PDX", "SFO"], ["PDX", "LAX"],
  ["DFW", "ORD"], ["DFW", "LAX"], ["DFW", "MIA"], ["DFW", "SEA"],
  ["IAH", "ORD"], ["IAH", "LAX"], ["IAH", "MIA"], ["IAH", "SFO"],
];

const CATALOG_FILE = "config/routes.discovered.json";
const PACE_MS = Number(process.env.DISCOVER_PACE_MS ?? 4000);

export interface CatalogEntry {
  flight_id: string;
  carrier: string; // ICAO operating code (AAL, DAL, ...)
  carrier_name: string;
  origin: string;
  destination: string;
  /** Scheduled departure of the sampled instance, UTC ISO — pricing
   *  converts to local HHMM (the model's DepTime is local). */
  sched_out_utc: string | null;
  days_seen: number;
  first_seen: string; // YYYY-MM-DD (run date)
  last_seen: string;
}

/** Attestable ident: airline designator + flight number, nothing else. */
function parseIdent(ident: string): { carrier: string } | null {
  const m = ident.match(/^([A-Z]{2,3})(\d{1,4})$/);
  return m ? { carrier: m[1] } : null;
}

function nextWeekday(from: Date, weekday: number): string {
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
  const dry = args.includes("--dry");

  // Two sample days — a Tuesday and the following Saturday — filter out
  // one-off charters and catch day-of-week-only service.
  const tuesday = getArg("date") ?? nextWeekday(new Date(), 2);
  const saturday = nextWeekday(new Date(Date.parse(`${tuesday}T00:00:00Z`)), 6);
  const sampleDays = [tuesday, saturday];

  // Directed pairs, deduplicated.
  const pairSet = new Set<string>();
  const pairs: Array<[string, string]> = [];
  const addPair = (a: string, b: string) => {
    const k = `${a}|${b}`;
    if (a !== b && !pairSet.has(k)) {
      pairSet.add(k);
      pairs.push([a, b]);
    }
  };
  for (const a of NYC) for (const b of NYC_DESTS) { addPair(a, b); addPair(b, a); }
  for (const [a, b] of MESH_PAIRS) { addPair(a, b); addPair(b, a); }

  const aero = new AeroApiClient({
    aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "https://aeroapi.flightaware.com/aeroapi",
    aeroApiKey: process.env.AEROAPI_KEY ?? "",
  });

  console.log(`[discover] ${pairs.length} directed pairs on ${sampleDays.join(" + ")} (tracked carriers only)`);

  // ── Sweep ────────────────────────────────────────────────────────────────
  const found = new Map<string, { entry: Omit<CatalogEntry, "days_seen" | "first_seen" | "last_seen">; days: Set<string> }>();
  let apiCalls = 0;
  let ignoredCarriers = 0;
  for (const [origin, destination] of pairs) {
    for (const day of sampleDays) {
      const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      apiCalls++;
      const resp = await aero.getSchedules(day, nextDay, { origin, destination, maxPages: 5 });
      if (!resp) {
        console.warn(`[discover] ${origin}->${destination} ${day}: request failed (skipped)`);
        continue;
      }
      for (const row of resp.scheduled ?? []) {
        const ident = (row.actual_ident ?? row.ident) as string;
        const parsed = parseIdent(ident);
        if (!parsed) continue; // unattestable ident
        const carrierName = TRACKED_CARRIERS[parsed.carrier];
        if (!carrierName) {
          ignoredCarriers++;
          continue; // not one of our nine airlines
        }
        const key = `${ident}|${origin}|${destination}`;
        const existing = found.get(key);
        if (existing) {
          existing.days.add(day);
        } else {
          found.set(key, {
            entry: {
              flight_id: ident,
              carrier: parsed.carrier,
              carrier_name: carrierName,
              origin,
              destination,
              sched_out_utc: (row as { scheduled_out?: string }).scheduled_out ?? null,
            },
            days: new Set([day]),
          });
        }
      }
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
  }
  console.log(
    `[discover] ${found.size} eligible flight(s) in ${apiCalls} call(s) ` +
      `(${ignoredCarriers} row(s) ignored — untracked carriers)`
  );

  if (dry) {
    console.log("[discover] --dry: catalog not written.");
    return;
  }

  // ── Merge into the deduped catalog (uncapped; never discards) ──────────
  const today = new Date().toISOString().slice(0, 10);
  let catalog: CatalogEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(CATALOG_FILE, "utf8"));
    if (Array.isArray(raw)) catalog = raw as CatalogEntry[];
  } catch {
    /* first run */
  }
  // Prune legacy entries that predate the tracked-carrier rule.
  const before = catalog.length;
  catalog = catalog.filter((c) => TRACKED_CARRIERS[c.carrier]);
  const pruned = before - catalog.length;

  const byKey = new Map(catalog.map((c) => [`${c.flight_id}|${c.origin}|${c.destination}`, c]));
  let added = 0;
  for (const [key, f] of found) {
    const existing = byKey.get(key);
    if (existing) {
      existing.days_seen = Math.max(existing.days_seen ?? 1, f.days.size);
      existing.last_seen = today;
      if (!existing.sched_out_utc && f.entry.sched_out_utc) existing.sched_out_utc = f.entry.sched_out_utc;
      if (!existing.carrier_name) existing.carrier_name = f.entry.carrier_name;
    } else {
      byKey.set(key, { ...f.entry, days_seen: f.days.size, first_seen: today, last_seen: today });
      added++;
    }
  }
  const merged = [...byKey.values()].sort((a, b) =>
    `${a.origin}|${a.destination}|${a.flight_id}`.localeCompare(`${b.origin}|${b.destination}|${b.flight_id}`)
  );
  writeFileSync(CATALOG_FILE, JSON.stringify(merged, null, 2) + "\n");
  console.log(
    `[discover] catalog: ${merged.length} candidate(s) in ${CATALOG_FILE} ` +
      `(${added} new${pruned ? `, ${pruned} legacy untracked-carrier entrie(s) pruned` : ""})`
  );
  console.log("\nNext step: npx tsx ../scripts/price_routes.ts  (then admin review, then seed_routes)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
