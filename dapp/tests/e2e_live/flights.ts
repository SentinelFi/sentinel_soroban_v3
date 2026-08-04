/**
 * Flight-candidate selection — ZERO AeroAPI calls by design: everything
 * comes from the staged whitelist (dep_time_hhmm, p_covered, premiums)
 * intersected with the curated board list (routes.live.json — the UI can
 * only sell what the board shows), then verified Active on-chain.
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
import type { Chain } from "./chain.js";

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

/**
 * Build the ranked candidate pool relative to `now`. Re-run at every buy
 * pass — candidacy is time-relative and sale-auth refusals shrink it.
 */
export async function selectCandidates(
  chain: Chain,
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
  const live = loadLiveBoard();
  if (live.length === 0) return [];
  const liveKeys = new Set(live.map((r) => `${r.flight_id}|${r.origin}|${r.destination}`));
  const routes = loadWhitelistRoutes().filter((r) =>
    liveKeys.has(`${r.flight_id}|${r.origin}|${r.destination}`),
  );

  // Verify Active on-chain once per route (not per date).
  const active: WhitelistRoute[] = [];
  for (const r of routes) {
    try {
      const status = await chain.routeStatus(r.flight_id, r.origin, r.destination);
      if (String(status) === "Active") active.push(r);
    } catch {
      /* unknown route → skip */
    }
  }

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
