/**
 * Flight-candidate selection — ZERO AeroAPI calls by design.
 *
 * Inventory = GET /api/routes (the full seeded catalog the board now
 * sells — the same data path the UI uses) joined with the staged
 * whitelist for scheduling metadata (dep_time_hhmm, p_covered). Picked
 * candidates get one on-chain route_status spot-verification each right
 * before buying; the catalog itself is CDN-cached and trusted for
 * browsing, exactly like the real UI.
 *
 * Window math: the deployed sale-auth enforces a 24h purchase cutoff
 * before departure (SALE_MIN_LEAD_SECS default), so viable candidates
 * depart ≥~26h out. dep_time_hhmm is airport-LOCAL; with no tz table we
 * estimate UTC with a +5h average US offset and let sale-auth be the
 * authoritative gate — refusals are expected and retried (that's why the
 * pool must be deep).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { DAPP_ROOT } from "./config.js";

const DAY = 86_400;
const AVG_US_UTC_OFFSET_H = 5;

export interface WhitelistRoute {
  flight_id: string;
  carrier: string;
  origin: string;
  destination: string;
  dep_time_hhmm: string;
  distance_mi: number;
  p_covered: number;
  premium_usdc: number;
}

export interface Candidate {
  flightId: string;
  origin: string;
  dest: string;
  /** UTC-midnight date bucket (contract key), seconds. */
  dateSecs: bigint;
  dateISO: string;
  /** estimated departure epoch secs (UTC, ±tz slop) */
  depEstSecs: number;
  /** estimated arrival epoch secs */
  arrEstSecs: number;
  pCovered: number;
  premiumUsdc: number;
  eveningDep: boolean;
}

export function loadWhitelistRoutes(): WhitelistRoute[] {
  const w = JSON.parse(
    readFileSync(join(DAPP_ROOT, "config", "route_whitelist.json"), "utf8"),
  ) as { routes: WhitelistRoute[] };
  return w.routes;
}

export function loadLiveBoard(): Array<{ flight_id: string; origin: string; destination: string }> {
  const l = JSON.parse(
    readFileSync(join(DAPP_ROOT, "config", "routes.live.json"), "utf8"),
  ) as { routes: Array<{ flight_id: string; origin: string; destination: string }> };
  return l.routes ?? [];
}

export interface CatalogRoute {
  flight_id: string;
  origin: string;
  destination: string;
  status: string;
  featured: boolean;
}

/** GET /api/routes — the deployed catalog (the board's own inventory). */
export async function fetchCatalog(backendUrl: string): Promise<CatalogRoute[]> {
  const r = await fetch(`${backendUrl}/api/routes`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`/api/routes → ${r.status}`);
  const body = (await r.json()) as { routes: CatalogRoute[] };
  return body.routes ?? [];
}

/**
 * Build the ranked candidate pool relative to `now`. Re-run at every buy
 * pass — candidacy is time-relative and sale-auth refusals shrink it.
 * Inventory: the deployed /api/routes catalog (status Active) joined
 * with the whitelist for scheduling metadata. Picked candidates are
 * spot-verified on-chain by the buy pass, not here (1,000+ per-route
 * simulate calls per pass would be the exact anti-pattern the catalog
 * endpoint removed).
 */
export async function selectCandidates(
  backendUrl: string,
  opts: {
    nowSecs?: number;
    soakEndSecs?: number;
    minLeadHours?: number; // buy-to-departure minimum (sale-auth cutoff + slop)
    maxLeadHours?: number; // don't book past the soak's settle horizon
    excludeKeys?: Set<string>; // `${flightId}|${dateISO}` already bought/refused
  } = {},
): Promise<Candidate[]> {
  const now = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const minLeadH = opts.minLeadHours ?? Number(process.env.E2E_DEP_MIN_HOURS ?? 26);
  const maxLeadH = opts.maxLeadHours ?? Number(process.env.E2E_DEP_MAX_HOURS ?? 54);
  const catalog = await fetchCatalog(backendUrl);
  const activeKeys = new Set(
    catalog.filter((r) => r.status === "Active").map((r) => `${r.flight_id}|${r.origin}|${r.destination}`),
  );
  if (activeKeys.size === 0) return [];
  const active = loadWhitelistRoutes().filter((r) =>
    activeKeys.has(`${r.flight_id}|${r.origin}|${r.destination}`),
  );

  const out: Candidate[] = [];
  for (const r of active) {
    const hh = Number(r.dep_time_hhmm.slice(0, -2) || "0");
    const mm = Number(r.dep_time_hhmm.slice(-2) || "0");
    for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
      const dateSecs = (Math.floor(now / DAY) + dayOffset) * DAY;
      const depEst = dateSecs + (hh + AVG_US_UTC_OFFSET_H) * 3600 + mm * 60;
      const leadH = (depEst - now) / 3600;
      if (leadH < minLeadH || leadH > maxLeadH) continue;
      const flightHours = r.distance_mi / 500 + 0.75;
      const arrEst = depEst + Math.round(flightHours * 3600);
      if (opts.soakEndSecs && arrEst > opts.soakEndSecs - 8 * 3600) continue;
      const dateISO = new Date(dateSecs * 1000).toISOString().slice(0, 10);
      if (opts.excludeKeys?.has(`${r.flight_id}|${dateISO}`)) continue;
      out.push({
        flightId: r.flight_id,
        origin: r.origin,
        dest: r.destination,
        dateSecs: BigInt(dateSecs),
        dateISO,
        depEstSecs: depEst,
        arrEstSecs: arrEst,
        pCovered: r.p_covered,
        premiumUsdc: r.premium_usdc,
        eveningDep: hh >= 17,
      });
    }
  }
  // Rank: delay-prone first — p_covered desc with an evening-departure bonus.
  out.sort(
    (a, b) => b.pCovered + (b.eveningDep ? 0.02 : 0) - (a.pCovered + (a.eveningDep ? 0.02 : 0)),
  );
  return out;
}

/**
 * Diverse pick: spread `n` buys across distinct routes/carriers/days
 * before reusing any route — the 2026-08-04 "diverse group of flights"
 * requirement. Returns at most n candidates.
 */
export function pickDiverse(pool: Candidate[], n: number): Candidate[] {
  const picked: Candidate[] = [];
  const usedRoute = new Set<string>();
  const usedCarrierDay = new Map<string, number>();
  for (const round of [0, 1]) {
    for (const c of pool) {
      if (picked.length >= n) return picked;
      if (picked.includes(c)) continue;
      const routeKey = `${c.flightId}|${c.origin}|${c.dest}`;
      if (round === 0 && usedRoute.has(routeKey)) continue;
      const cdKey = `${c.flightId.slice(0, 3)}|${c.dateISO}`;
      const cdCount = usedCarrierDay.get(cdKey) ?? 0;
      if (round === 0 && cdCount >= 6) continue;
      picked.push(c);
      usedRoute.add(routeKey);
      usedCarrierDay.set(cdKey, cdCount + 1);
    }
  }
  return picked;
}
